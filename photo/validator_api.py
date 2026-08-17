#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
UMA Photo Validator API

- Accepts JPG/PNG.
- Requires white background.
- Generates 240x288 JPEG.
- Final JPEG must be <= 50 KB.
- Only APPROVED photos are stored locally.
- Rejected photos are not stored.
- Node.js uploads approved photos to Google Drive.
"""

import base64
import io
import os
import re

from typing import (
    Any,
    Dict,
    List,
    Optional,
    Tuple,
    Iterable,
    cast,
)

from dotenv import load_dotenv

from fastapi import (
    FastAPI,
    File,
    Form,
    UploadFile,
)

from fastapi.middleware.cors import (
    CORSMiddleware,
)

from PIL import (
    Image,
    ImageOps,
)


load_dotenv()


# =========================================
# CONFIGURATION
# =========================================

TARGET_W = 240
TARGET_H = 288

MAX_BYTES = int(
    os.getenv(
        "UMA_MAX_BYTES",
        50 * 1024,
    )
)

MAX_ORIGINAL_BYTES = int(
    os.getenv(
        "UMA_MAX_ORIG_BYTES",
        MAX_BYTES,
    )
)

PHOTOS_DIR = os.getenv(
    "UMA_PHOTOS_DIR",
    "photo/photos",
)


BORDER_PIXELS = 12
WHITE_THRESHOLD = 210
BACKGROUND_MIN_WHITE = 0.58


os.makedirs(
    os.path.join(
        PHOTOS_DIR,
        "approved",
    ),
    exist_ok=True,
)


def _log(*args: Any) -> None:
    print(
        *args,
        flush=True,
    )


def _kb(
    num_bytes: int,
) -> float:
    return (
        num_bytes /
        1024.0
    )


# =========================================
# PIL RESAMPLING
# =========================================

try:
    from PIL.Image import Resampling

    RESAMPLE_LANCZOS = (
        Resampling.LANCZOS
    )

except Exception:
    RESAMPLE_LANCZOS = getattr(
        Image,
        "LANCZOS",
        getattr(
            Image,
            "BILINEAR",
            2,
        ),
    )


# =========================================
# HELPERS
# =========================================

def sanitize_name(
    value: Optional[str],
) -> str:

    return re.sub(
        r"[^\w\-]",
        "",
        (value or "").strip(),
        flags=re.ASCII,
    )


def load_pil(
    upload: UploadFile,
    raw_bytes: Optional[bytes] = None,
) -> Tuple[
    Image.Image,
    bytes,
]:

    if raw_bytes is None:
        raw_bytes = (
            upload.file.read()
        )

    pil = Image.open(
        io.BytesIO(
            raw_bytes
        )
    )

    if hasattr(
        ImageOps,
        "exif_transpose",
    ):
        pil = (
            ImageOps
            .exif_transpose(
                pil
            )
        )

    return (
        pil.convert("RGB"),
        raw_bytes,
    )


def border_white_ratio(
    pil_img: Image.Image,
) -> float:

    w, h = pil_img.size

    b = max(
        2,
        min(
            BORDER_PIXELS,
            w // 4,
            h // 4,
        ),
    )

    gray = pil_img.convert(
        "L"
    )

    def frac_white(
        region: Image.Image,
    ) -> float:

        data_iter = cast(
            Iterable[int],
            region.getdata(),
        )

        data_list = list(
            data_iter
        )

        total = len(
            data_list
        )

        if total == 0:
            return 0.0

        white = sum(
            1
            for value
            in data_list
            if value >=
            WHITE_THRESHOLD
        )

        return (
            white /
            total
        )

    top = gray.crop(
        (
            0,
            0,
            w,
            b,
        )
    )

    bottom = gray.crop(
        (
            0,
            h - b,
            w,
            h,
        )
    )

    left = gray.crop(
        (
            0,
            0,
            b,
            h,
        )
    )

    right = gray.crop(
        (
            w - b,
            0,
            w,
            h,
        )
    )

    values = [
        frac_white(region)
        for region
        in (
            top,
            bottom,
            left,
            right,
        )
    ]

    return (
        sum(values) /
        len(values)
    )


def passport_crop(
    pil_img: Image.Image,
) -> Image.Image:

    w, h = pil_img.size

    target_ratio = (
        TARGET_W /
        TARGET_H
    )

    crop_factor = (
        0.9
        if h >
        TARGET_H * 1.2
        else 1.0
    )

    new_h = max(
        int(
            h *
            crop_factor
        ),
        TARGET_H,
    )

    new_w = int(
        new_h *
        target_ratio
    )

    if new_w > w:
        new_w = w

        new_h = int(
            new_w /
            target_ratio
        )

    left = max(
        0,
        (w - new_w) // 2,
    )

    right = (
        left +
        new_w
    )

    max_top = (
        h -
        new_h
    )

    top = (
        max_top // 2
        if max_top > 0
        else 0
    )

    bottom = (
        top +
        new_h
    )

    return pil_img.crop(
        (
            left,
            top,
            right,
            bottom,
        )
    )


def jpg_under_size(
    pil_img: Image.Image,
    limit: int = MAX_BYTES,
) -> bytes:

    lo = 35
    hi = 95

    best: Optional[bytes] = None

    while lo <= hi:

        quality = (
            lo +
            hi
        ) // 2

        buffer = io.BytesIO()

        pil_img.save(
            buffer,
            format="JPEG",
            quality=quality,
            optimize=True,
            progressive=True,
        )

        size = buffer.tell()

        if size <= limit:
            best = (
                buffer.getvalue()
            )

            lo = (
                quality +
                1
            )

        else:
            hi = (
                quality -
                1
            )

    if best is not None:
        return best

    buffer = io.BytesIO()

    pil_img.save(
        buffer,
        format="JPEG",
        quality=35,
        optimize=True,
        progressive=True,
    )

    return (
        buffer.getvalue()
    )


def run_pipeline(
    pil_img: Image.Image,
    *,
    require_white_bg: bool = True,
) -> Tuple[
    bytes,
    Dict[str, Any],
]:

    issues: List[str] = []

    white_ratio = (
        border_white_ratio(
            pil_img
        )
    )

    background_ok = (
        white_ratio >=
        BACKGROUND_MIN_WHITE
    )

    if (
        require_white_bg
        and not background_ok
    ):
        issues.append(
            "La foto debe tomarse frente a una pared blanca lisa, "
            "sin objetos ni colores de fondo. "
            "Repita la foto con un fondo completamente blanco."
        )

    cropped = (
        passport_crop(
            pil_img
        )
    )

    output_image = (
        cropped.resize(
            (
                TARGET_W,
                TARGET_H,
            ),
            resample=
            RESAMPLE_LANCZOS,
        )
    )

    jpg = (
        jpg_under_size(
            output_image,
            MAX_BYTES,
        )
    )

    info: Dict[str, Any] = {
        "issues":
            issues,

        "width":
            TARGET_W,

        "height":
            TARGET_H,

        "bytes":
            len(jpg),

        "white_ratio":
            white_ratio,

        "background_ok":
            background_ok,
    }

    return (
        jpg,
        info,
    )


# =========================================
# FASTAPI
# =========================================

app = FastAPI(
    title=
    "UMA Photo Validator"
)


app.add_middleware(
    CORSMiddleware,

    allow_origins=[
        "*"
    ],

    allow_credentials=True,

    allow_methods=[
        "*"
    ],

    allow_headers=[
        "*"
    ],
)


@app.get("/")
@app.head("/")
def root() -> Dict[str, Any]:

    return {
        "ok": True,

        "message":
            "UMA Photo Validator running",

        "endpoints": {
            "health":
                "/health",

            "validate":
                "/validate",

            "fix_photo":
                "/fix-photo",
        },
    }


@app.get("/health")
@app.head("/health")
def health() -> Dict[str, Any]:

    return {
        "ok": True,

        "msg":
            "UMA validator healthy",

        "target": [
            TARGET_W,
            TARGET_H,
        ],

        "max_bytes":
            MAX_BYTES,

        "max_original_bytes":
            MAX_ORIGINAL_BYTES,
    }


# =========================================
# VALIDATE
# =========================================

@app.post("/validate")
def validate(
    dni: Optional[str] = Form(
        None
    ),

    image: UploadFile = File(
        ...
    ),
) -> Dict[str, Any]:

    dni = (
        sanitize_name(dni)
        or
        "unknown_user"
    )

    try:

        try:
            pil_in, raw_bytes = (
                load_pil(
                    image
                )
            )

        except Exception:

            return {
                "ok": False,

                "issues": [
                    "Archivo no es una imagen válida."
                ],

                "bytes": 0,
            }

        original_size = len(
            raw_bytes
        )

        jpg, info = (
            run_pipeline(
                pil_in,
                require_white_bg=True,
            )
        )

        issues: List[str] = list(
            info.get(
                "issues",
                [],
            )
        )

        if (
            original_size >
            MAX_ORIGINAL_BYTES
        ):

            limit_kb = (
                MAX_ORIGINAL_BYTES //
                1024
            )

            issues.insert(
                0,

                (
                    "Foto inválida: "
                    "El archivo original pesa "
                    f"{_kb(original_size):.1f} KB; "
                    f"debe ser ≤ {limit_kb} KB. "
                    'Usa el botón "Arreglar con IA" '
                    "o selecciona otra foto."
                ),
            )

        ok = (
            len(issues) == 0
            and
            len(jpg) <=
            MAX_BYTES
        )

        if (
            not ok
            and
            not issues
        ):
            issues.append(
                "La foto no cumple con los criterios requeridos."
            )

        category = (
            "approved"
            if ok
            else
            "rejected"
        )

        filename = ""
        save_path = ""

        # ONLY APPROVED PHOTOS
        # ARE SAVED LOCALLY
        if ok:

            filename = (
                f"{dni}.jpg"
            )

            save_dir = (
                os.path.join(
                    PHOTOS_DIR,
                    "approved",
                )
            )

            os.makedirs(
                save_dir,
                exist_ok=True,
            )

            save_path = (
                os.path.join(
                    save_dir,
                    filename,
                )
            )

            with open(
                save_path,
                "wb",
            ) as file_handle:

                file_handle.write(
                    jpg
                )

        # Node needs processed photo
        # for Google Drive upload.
        data_url = (
            "data:image/jpeg;base64,"
            +
            base64
            .b64encode(jpg)
            .decode("ascii")
        )

        _log(
            "[validator]",

            "dni=",
            dni,

            "ok=",
            ok,

            "issues=",
            issues,

            "original_bytes=",
            original_size,

            "final_bytes=",
            len(jpg),

            "local=",
            (
                save_path
                or
                "not_saved"
            ),
        )

        return {
            "ok":
                ok,

            "issues":
                issues,

            "width":
                info.get(
                    "width",
                    TARGET_W,
                ),

            "height":
                info.get(
                    "height",
                    TARGET_H,
                ),

            "bytes":
                info.get(
                    "bytes",
                    len(jpg),
                ),

            "category":
                category,

            "filename":
                filename,

            "relative_path":
                save_path,

            "data_url":
                data_url,
        }

    except Exception as error:

        _log(
            "[validator] unexpected error:",
            repr(error),
        )

        return {
            "ok": False,

            "issues": [
                (
                    "Error interno del validador: "
                    f"{repr(error)}"
                )
            ],

            "bytes": 0,
        }


# =========================================
# FIX PHOTO
# =========================================

@app.post("/fix-photo")
def fix_photo(
    image: UploadFile = File(
        ...
    ),
) -> Dict[str, Any]:

    try:

        try:
            pil_in, raw_bytes = (
                load_pil(
                    image
                )
            )

        except Exception:

            return {
                "ok": False,

                "issues": [
                    "Archivo no es una imagen válida."
                ],

                "bytes": 0,
            }

        jpg, info = (
            run_pipeline(
                pil_in,
                require_white_bg=True,
            )
        )

        issues: List[str] = list(
            info.get(
                "issues",
                [],
            )
        )

        ok = (
            len(issues) == 0
            and
            len(jpg) <=
            MAX_BYTES
        )

        data_url = (
            "data:image/jpeg;base64,"
            +
            base64
            .b64encode(jpg)
            .decode("ascii")
        )

        _log(
            "[fix-photo]",

            "ok=",
            ok,

            "original_bytes=",
            len(raw_bytes),

            "final_bytes=",
            len(jpg),

            "white_ratio=",
            info.get(
                "white_ratio"
            ),

            "issues=",
            issues,
        )

        return {
            "ok":
                ok,

            "issues":
                issues,

            "width":
                info.get(
                    "width",
                    TARGET_W,
                ),

            "height":
                info.get(
                    "height",
                    TARGET_H,
                ),

            "bytes":
                info.get(
                    "bytes",
                    len(jpg),
                ),

            "data_url":
                data_url,
        }

    except Exception as error:

        _log(
            "[fix-photo] unexpected error:",
            repr(error),
        )

        return {
            "ok": False,

            "issues": [
                (
                    "Error interno al intentar corregir la foto: "
                    f"{repr(error)}"
                )
            ],

            "bytes": 0,
        }


    # ============================================================
# RUN DIRECTLY
# ============================================================

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "photo.validator_api:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
    )