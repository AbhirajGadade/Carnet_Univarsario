#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
UMA Photo Validator API

Rules:
- Image must be a valid JPG/PNG
- Detect 1 face (Haar)
- Crop around the face to 240x288 aspect ratio
- Resize to 240x288 pixels (rectangular, no oval)
- Background mostly white/clear (background is cleaned to white)
- Final JPEG <= 50KB
- Save to photos/approved or photos/rejected
- If approved, upload to Supabase Storage (bucket student-photos/approved)
"""

import base64
import io
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import requests
from cv2 import data as cv2_data
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps

load_dotenv()

# ---------------- Config ----------------
# Final photo size (rectangular)
TARGET_W, TARGET_H = 240, 288

# Max bytes (50 KB by default)
MAX_BYTES = int(os.getenv("UMA_MAX_BYTES", 50 * 1024))

# Local folder where Python saves files
PHOTOS_DIR = os.getenv("UMA_PHOTOS_DIR", "photos")

# Background / face config
BORDER = 10
WHITE_L_MIN = 75
LAB_BG_DIST = 16
FACE_CENTER_X = (0.28, 0.72)
FACE_CENTER_Y = (0.26, 0.72)
FACE_REL_H = (0.18, 0.72)

os.makedirs(os.path.join(PHOTOS_DIR, "approved"), exist_ok=True)
os.makedirs(os.path.join(PHOTOS_DIR, "rejected"), exist_ok=True)

# Pillow resampling constant
try:
    from PIL.Image import Resampling

    RESAMPLE_LANCZOS = Resampling.LANCZOS
except Exception:
    RESAMPLE_LANCZOS = getattr(Image, "LANCZOS", getattr(Image, "BILINEAR", 2))

# Supabase config
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
# IMPORTANT: this must be the "Service role" key (starts with eyJ...)
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_BUCKET = os.getenv("SUPABASE_BUCKET", "student-photos")


def _log(*a: Any) -> None:
    print(*a, flush=True)


# ---------------- Supabase helper ----------------
def upload_to_supabase(jpg_bytes: bytes, path_in_bucket: str) -> Dict[str, Any]:
    """
    Upload JPEG bytes to Supabase Storage.
    Returns dict with ok/public_url or error.
    """
    info: Dict[str, Any] = {"ok": False}

    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        info["error"] = "supabase_not_configured"
        _log("[supabase] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
        return info

    try:
        # Example object path:
        #   bucket: student-photos
        #   path_in_bucket: approved/12345678.jpg
        # Final URL path: /storage/v1/object/student-photos/approved/12345678.jpg
        object_path = f"{SUPABASE_BUCKET}/{path_in_bucket.lstrip('/')}"
        url = f"{SUPABASE_URL}/storage/v1/object/{object_path}"

        # Service role key is used as both apikey and Bearer token.
        headers = {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "image/jpeg",
            "x-upsert": "true",  # overwrite if already exists
        }

        resp = requests.post(url, headers=headers, data=jpg_bytes, timeout=30)

        if resp.status_code not in (200, 201):
            info["error"] = f"upload_failed_{resp.status_code}"
            info["details"] = resp.text[:200]
            _log("[supabase] upload failed:", info["error"], info.get("details", ""))
            return info

        # Public URL (bucket is Public)
        public_url = (
            f"{SUPABASE_URL}/storage/v1/object/public/"
            f"{SUPABASE_BUCKET}/{path_in_bucket.lstrip('/')}"
        )

        info.update({"ok": True, "public_url": public_url, "status": resp.status_code})
        _log("[supabase] uploaded:", public_url)
        return info
    except Exception as e:
        info["error"] = repr(e)
        _log("[supabase] upload exception:", repr(e))
        return info


# ---------------- FastAPI app ----------------
app = FastAPI(title="UMA Photo Validator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # adjust for prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------- Helpers ----------------
def sanitize_name(s: Optional[str]) -> str:
    return re.sub(r"[^\w\-]", "", (s or "").strip(), flags=re.ASCII)


def load_pil(upload: UploadFile) -> Image.Image:
    data = upload.file.read()
    pil = Image.open(io.BytesIO(data))
    if hasattr(ImageOps, "exif_transpose"):
        pil = ImageOps.exif_transpose(pil)
    return pil.convert("RGB")  # type: ignore


def to_np(img: Image.Image) -> np.ndarray:
    return np.array(img)


def detect_face(bgr: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    """Return (x,y,w,h) of biggest detected face, or None."""
    try:
        cascade_path = os.path.join(
            cv2_data.haarcascades, "haarcascade_frontalface_default.xml"
        )
        cas = cv2.CascadeClassifier(cascade_path)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        faces = cas.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=5, flags=cv2.CASCADE_SCALE_IMAGE
        )
        if len(faces) == 0:
            return None
        faces = sorted(faces, key=lambda r: int(r[2]) * int(r[3]), reverse=True)
        x, y, w, h = [int(v) for v in faces[0]]
        return (x, y, w, h)
    except Exception:
        return None


def crop_to_ratio(rgb: np.ndarray, face: Optional[Tuple[int, int, int, int]]) -> np.ndarray:
    """
    Crop image to TARGET_W:TARGET_H (240x288) keeping the face centered.
    Result is a normal rectangle (no oval).
    """
    h, w = rgb.shape[:2]
    target = TARGET_W / TARGET_H
    r = w / h

    if r > target:
        # Image too wide -> crop left/right
        new_w = int(h * target)
        new_h = h
        cx = w // 2
        if face:
            cx = face[0] + face[2] // 2
        x1 = max(0, min(w - new_w, int(cx - new_w // 2)))
        y1 = 0
    else:
        # Image too tall -> crop top/bottom
        new_w = w
        new_h = int(w / target)
        cy = h // 2
        if face:
            cy = face[1] + face[3] // 2
        x1 = 0
        y1 = max(0, min(h - new_h, int(cy - new_h // 2)))

    return rgb[y1 : y1 + new_h, x1 : x1 + new_w]


def rgb_to_lab(a: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(a, cv2.COLOR_RGB2LAB)


def whiten_background(rgb: np.ndarray) -> Tuple[np.ndarray, float]:
    """
    Try to make background white.
    It samples the border colors and turns pixels similar to that into pure white.
    Returns (image, % of border that was already bright).
    """
    h, w = rgb.shape[:2]
    b = min(BORDER, h // 4, w // 4)
    border = np.concatenate(
        [
            rgb[:b, :, :].reshape(-1, 3),
            rgb[-b:, :, :].reshape(-1, 3),
            rgb[:, :b, :].reshape(-1, 3),
            rgb[:, -b:, :].reshape(-1, 3),
        ],
        axis=0,
    ).astype(np.uint8)

    lab_img = rgb_to_lab(rgb)
    lab_border = rgb_to_lab(border.reshape(-1, 1, 3)).reshape(-1, 3)
    bg_lab = np.median(lab_border, axis=0)

    white_pct = (lab_border[:, 0] >= WHITE_L_MIN).sum() / lab_border.shape[0] * 100.0
    dist = np.linalg.norm(lab_img - bg_lab[None, None, :], axis=2)
    mask = dist < LAB_BG_DIST

    out = rgb.copy()
    out[mask] = (255, 255, 255)
    return out, float(white_pct)


def jpg_under_size(pil_img: Image.Image, limit: int = MAX_BYTES) -> bytes:
    """Binary search JPEG quality so that file <= limit bytes if possible."""
    lo, hi = 35, 95
    best: Optional[bytes] = None
    while lo <= hi:
        q = (lo + hi) // 2
        buf = io.BytesIO()
        pil_img.save(buf, format="JPEG", quality=q, optimize=True, progressive=True)
        size = buf.tell()
        if size <= limit:
            best = buf.getvalue()
            lo = q + 1
        else:
            hi = q - 1
    if best is not None:
        return best
    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=35, optimize=True, progressive=True)
    return buf.getvalue()


def face_rules(
    rgb: np.ndarray, face: Optional[Tuple[int, int, int, int]]
) -> List[str]:
    """Return list of face-related issues, empty if OK."""
    issues: List[str] = []
    if face is None:
        issues.append("No se detectó un rostro claro.")
        return issues
    x, y, w, h = face
    H, W = rgb.shape[:2]
    cx, cy = x + w / 2, y + h / 2
    if not (W * FACE_CENTER_X[0] <= cx <= W * FACE_CENTER_X[1]):
        issues.append("Rostro no está centrado horizontalmente.")
    if not (H * FACE_CENTER_Y[0] <= cy <= H * FACE_CENTER_Y[1]):
        issues.append("Rostro no está centrado verticalmente.")
    if not (H * FACE_REL_H[0] <= h <= H * FACE_REL_H[1]):
        issues.append("Rostro demasiado pequeño o grande.")
    return issues


# ---------------- Routes ----------------
@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "msg": "UMA validator healthy",
        "target": [TARGET_W, TARGET_H],
        "max_bytes": MAX_BYTES,
        "supabase": {
            "url": SUPABASE_URL,
            "bucket": SUPABASE_BUCKET,
            "configured": bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY),
        },
    }


@app.post("/validate")
def validate(
    dni: Optional[str] = Form(None, description="Student DNI used as output filename"),
    image: UploadFile = File(...),
) -> Dict[str, Any]:
    """
    Main validator endpoint.

    Request: multipart/form-data with fields:
      - image: file
      - dni: student identifier (used for filename)
    """
    dni = sanitize_name(dni) or "unknown_user"
    issues: List[str] = []

    try:
        # 1) Load and normalise
        try:
            pil_in = load_pil(image)
        except Exception:
            return {
                "ok": False,
                "issues": ["Archivo no es una imagen válida."],
                "bytes": 0,
            }

        rgb = to_np(pil_in)
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

        # 2) Face detection + rules
        face = detect_face(bgr)
        issues += face_rules(rgb, face)

        # 3) Crop to target ratio around face
        cropped = crop_to_ratio(rgb, face)

        # 4) Whiten background
        whitened, white_pct = whiten_background(cropped)
        if white_pct < 60:
            issues.append("Fondo no es suficientemente claro/blanco.")

        # 5) Resize to final size (rectangle)
        pil_out = Image.fromarray(whitened).resize(
            (TARGET_W, TARGET_H), resample=RESAMPLE_LANCZOS
        )

        # 6) Compress under MAX_BYTES
        jpg = jpg_under_size(pil_out, MAX_BYTES)

        if len(jpg) > MAX_BYTES:
            issues.append(
                f"La foto final debe pesar ≤ {MAX_BYTES // 1024} KB "
                f"(actual: {len(jpg) / 1024:.1f} KB)."
            )

        ok = (len(issues) == 0) and (len(jpg) <= MAX_BYTES)

        if not ok and not issues:
            issues.append("La foto no cumple con los criterios requeridos.")

        # 7) Save locally
        bucket = "approved" if ok else "rejected"
        ts = int(time.time())
        fname = f"{dni}.jpg" if ok else f"{dni}_{ts}.jpg"
        save_dir = os.path.join(PHOTOS_DIR, bucket)
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, fname)
        with open(save_path, "wb") as f:
            f.write(jpg)

        # 8) Base64 data URL (for UI / debugging)
        data_url = "data:image/jpeg;base64," + base64.b64encode(jpg).decode("ascii")

        # 9) Supabase upload (only for approved)
        supabase_info: Dict[str, Any] = {}
        supabase_url: Optional[str] = None
        if ok:
            object_path = f"approved/{fname}"
            supabase_info = upload_to_supabase(jpg, object_path)
            supabase_url = supabase_info.get("public_url")

        _log(
            "[validator]",
            "dni=",
            dni,
            "ok=",
            ok,
            "issues=",
            issues,
            "bytes=",
            len(jpg),
            "local=",
            save_path,
            "supabase_used=",
            bool(supabase_url),
        )

        return {
            "ok": ok,
            "issues": issues,
            "width": TARGET_W,
            "height": TARGET_H,
            "bytes": len(jpg),
            "category": bucket,
            "filename": fname,
            "relative_path": save_path,
            "data_url": data_url,
            "supabase_url": supabase_url,
            "supabase": supabase_info,
        }

    except Exception as e:
        # Safety net: always return JSON, never raw error
        _log("[validator] unexpected error:", repr(e))
        return {
            "ok": False,
            "issues": [f"Error interno del validador: {repr(e)}"],
            "bytes": 0,
        }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("validator_api:app", host="127.0.0.1", port=8000, reload=True)
