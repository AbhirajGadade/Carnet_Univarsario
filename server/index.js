// server/index.js
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');

// helper that builds rich SUNEDU ZIPs
const { createAdminZip } = require('./adminZipHelper');

const {
  studentLogin,
  setStudentAccessToken,
  setStudentRefreshToken,
  studentFetch,
  adminLogin,
  adminGetStudent,
  adminGetCourseSchedules,
  adminGetTeachers,
  adminGetTeacherSchedule
} = require('./uma');

const {
  PORT = 5000,
  SESSION_SECRET = 'change-this',
  VALIDATOR_URL: ENV_VALIDATOR_URL
} = process.env;

// Python validator URL (FastAPI)
const VALIDATOR_URL = ENV_VALIDATOR_URL || 'http://127.0.0.1:8000';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// ---------- paths ----------
const ROOT_DIR = path.join(__dirname, '..');
// IMPORTANT: Python validator writes here: photo/photos/{approved|rejected}
const PHOTOS_ROOT = path.join(ROOT_DIR, 'photo', 'photos');
const SUBMISSIONS_PATH = path.join(ROOT_DIR, 'photo', 'submissions.json');

// directory for generated SUNEDU ZIP files
const ZIP_OUTPUT_DIR = path.join(ROOT_DIR, 'tmp_zips');
if (!fs.existsSync(ZIP_OUTPUT_DIR)) {
  fs.mkdirSync(ZIP_OUTPUT_DIR, { recursive: true });
}

// ---------- submissions helpers ----------
async function loadSubmissions() {
  try {
    const txt = await fsp.readFile(SUBMISSIONS_PATH, 'utf8');
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.submissions)) return parsed.submissions;
    return [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('[submissions] read error:', err);
    return [];
  }
}

async function saveSubmissions(list) {
  try {
    await fsp.mkdir(path.dirname(SUBMISSIONS_PATH), { recursive: true });
    await fsp.writeFile(
      SUBMISSIONS_PATH,
      JSON.stringify({ submissions: list }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.error('[submissions] write error:', err);
  }
}

// Find the approved JPG for a given DNI:
//   photo/photos/approved/<dni>.jpg
function findApprovedPhotoByDni(dni) {
  if (!dni) return null;
  const dirApproved = path.join(PHOTOS_ROOT, 'approved');

  const jpg = path.join(dirApproved, `${dni}.jpg`);
  if (fs.existsSync(jpg)) return jpg;

  // fallback: any file starting with DNI
  try {
    const files = fs.readdirSync(dirApproved);
    const hit = files.find((name) => name.startsWith(String(dni)));
    if (hit) return path.join(dirApproved, hit);
  } catch (err) {
    // dir may not exist yet
  }

  return null;
}

async function deletePhotoFile(absPath) {
  if (!absPath) return;
  try {
    const abs = path.resolve(absPath);
    const root = path.resolve(PHOTOS_ROOT);
    if (!abs.startsWith(root)) {
      console.warn('[delete] refused outside photos root:', abs);
      return;
    }
    await fsp.unlink(abs);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[delete] unlink error:', err);
  }
}

// ---------- middleware ----------
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' }
  })
);

// static assets
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use('/photos', express.static(PHOTOS_ROOT));     // existing photos
app.use('/downloads', express.static(ZIP_OUTPUT_DIR)); // SUNEDU ZIPs

// ---------- STUDENT LOGIN ----------
app.post('/api/student/login', async (req, res) => {
  try {
    const { codigo, dni } = req.body;
    if (!codigo || !dni) {
      return res
        .status(400)
        .json({ ok: false, error: 'codigo and dni are required' });
    }

    const r = await studentLogin({ codigo, dni });

    const root = r.data || {};
    const data = root.data || root;
    const access = data.access_token || root.access_token || null;
    const refresh = data.refresh_token || root.refresh_token || null;

    if (!access) {
      return res.status(502).json({
        ok: false,
        error: 'UMA login did not return tokens',
        raw: root
      });
    }

    setStudentAccessToken(req.session, access);
    setStudentRefreshToken(req.session, refresh);

    res.json({ ok: true, message: 'login ok' });
  } catch (e) {
    const status = e.response?.status || e.status || 500;
    res.status(status).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ---------- ADMIN LOGIN ----------
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ ok: false, error: 'email and password are required' });
    }

    const r = await adminLogin({ email, password });

    const root = r.data || {};
    const data = root.data || root;
    const access = data.access_token || root.access_token || null;

    if (!access) {
      return res.status(502).json({
        ok: false,
        error: 'UMA admin login did not return token',
        raw: root
      });
    }

    req.session.adminAccessToken = access;
    res.json({ ok: true, message: 'admin login ok' });
  } catch (e) {
    const status = e.response?.status || e.status || 500;
    res.status(status).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ---------- STUDENT PROFILE ----------
app.post('/api/student/profile', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ ok: false, error: 'code is required' });
    }
    const r = await adminGetStudent({ code });
    res.json({ ok: true, data: r.data });
  } catch (e) {
    const status = e.response?.status || e.status || 500;
    res.status(status).json({ ok: false, error: e.response?.data || e.message });
  }
});

app.post('/api/student/course-schedules', async (req, res) => {
  try {
    const { code, period } = req.body;
    if (!code || !period) {
      return res
        .status(400)
        .json({ ok: false, error: 'code and period are required' });
    }
    const r = await adminGetCourseSchedules({ code, period });
    res.json({ ok: true, data: r.data });
  } catch (e) {
    const status = e.response?.status || e.status || 500;
    res.status(status).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ---------- ADMIN DATA ----------
app.post('/api/admin/student', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ ok: false, error: 'code is required' });
    }
    const r = await adminGetStudent({ code });
    res.json({ ok: true, data: r.data });
  } catch (e) {
    const status = e.response?.status || e.status || 500;
    res.status(status).json({ ok: false, error: e.response?.data || e.message });
  }
});

app.post('/api/admin/course-schedules', async (req, res) => {
  try {
    const { code, period } = req.body;
    if (!code || !period) {
      return res
        .status(400)
        .json({ ok: false, error: 'code and period are required' });
    }
    const r = await adminGetCourseSchedules({ code, period });
    res.json({ ok: true, data: r.data });
  } catch (e) {
    const status = e.response?.status || e.status || 500;
    res.status(status).json({ ok: false, error: e.response?.data || e.message });
  }
});

app.post('/api/admin/teachers', async (req, res) => {
  try {
    const { period } = req.body;
    if (!period) {
      return res.status(400).json({ ok: false, error: 'period is required' });
    }
    const r = await adminGetTeachers({ period });
    res.json({ ok: true, data: r.data });
  } catch (e) {
    const status = e.response?.status || e.status || 500;
    res.status(status).json({ ok: false, error: e.response?.data || e.message });
  }
});

app.post('/api/admin/teacher-schedule', async (req, res) => {
  try {
    const { dni, period } = req.body;
    if (!dni || !period) {
      return res
        .status(400)
        .json({ ok: false, error: 'dni and period are required' });
    }
    const r = await adminGetTeacherSchedule({ dni, period });
    res.json({ ok: true, data: r.data });
  } catch (e) {
    const status = e.response?.status || e.status || 500;
    res.status(status).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ---------- PHOTO VALIDATOR PROXY + LOG ----------
app.post('/validate', upload.single('image'), async (req, res) => {
  try {
    const file = req.file;
    const bodyFields = req.body || {};
    const dni = bodyFields.dni || 'unknown_user';

    if (!file) {
      return res.status(400).json({ ok: false, issues: ['No file provided'] });
    }

    const formData = new FormData();
    formData.append('image', file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype || 'application/octet-stream'
    });
    formData.append('dni', dni);

    const url = `${VALIDATOR_URL}/validate`;
    console.log('[validate] calling validator at:', url);

    const response = await axios.post(url, formData, {
      headers: formData.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true
    });

    const data = response.data || {};

    // log submission info used by admin portal
    try {
      const ok = !!data.ok;
      const category = data.category || (ok ? 'approved' : 'rejected');
      const filename = data.filename || '';
      const relPath = (data.relative_path || '').toString();

      let photoUrl = '';
      if (filename) {
        photoUrl = `/photos/${category}/${filename}`;
      } else if (relPath) {
        const normalized = relPath.replace(/\\/g, '/');
        if (normalized.startsWith('photos/')) {
          const tail = normalized.slice('photos/'.length);
          photoUrl = `/photos/${tail}`;
        }
      }

      const now = new Date().toISOString();
      const submission = {
        dni,
        code: bodyFields.code || '',
        name: bodyFields.name || '',
        email: bodyFields.email || '',
        esp: bodyFields.esp || '',
        category,
        ok,
        photoUrl,
        filename,
        relative_path: relPath,
        issues: Array.isArray(data.issues) ? data.issues : [],
        data_url: data.data_url || null,
        supabase_url: data.supabase_url || null,
        updatedAt: now
      };

      const list = await loadSubmissions();
      const idxExisting = list.findIndex((s) => s.dni === dni);
      if (idxExisting >= 0) {
        list[idxExisting] = { ...list[idxExisting], ...submission };
      } else {
        submission.createdAt = now;
        submission.suneduStatus = 'Pendiente';
        list.push(submission);
      }
      await saveSubmissions(list);
    } catch (err) {
      console.error('[submissions] log error:', err);
    }

    res.status(response.status || 200).json(data);
  } catch (err) {
    console.error('Validator proxy error:', err);
    res.status(500).json({
      ok: false,
      issues: ['Validation service error: ' + err.message]
    });
  }
});

// ---------- ADMIN: list submissions ----------
app.get('/api/admin/submissions', async (_req, res) => {
  try {
    const list = await loadSubmissions();
    const approved = list.filter((s) => s.category === 'approved');
    const rejected = list.filter((s) => s.category !== 'approved');
    res.json({ ok: true, data: { approved, rejected } });
  } catch (err) {
    console.error('[submissions] admin list error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- ADMIN: generate ZIP (rich SUNEDU package) ----------
app.post('/api/admin/generate-zip', async (req, res) => {
  try {
    const { dniList } = req.body || {};
    const list = await loadSubmissions();
    let selected = list.filter((s) => s.category === 'approved');

    // If admin selected specific DNIs, filter for only those
    if (Array.isArray(dniList) && dniList.length) {
      const dniSet = new Set(dniList.map(String));
      selected = selected.filter((s) => s.dni && dniSet.has(String(s.dni)));
    }

    console.log('[zip] approved in JSON:', list.filter(s => s.category === 'approved').length);
    console.log('[zip] requested DNIs:', selected.map(s => s.dni));

    if (!selected.length) {
      return res
        .status(400)
        .json({ ok: false, error: 'No hay estudiantes seleccionados.' });
    }

    const { zipPath, total, fileName } = await createAdminZip(selected, {
      outDir: ZIP_OUTPUT_DIR
    });

    const publicUrl = `/downloads/${fileName}`;

    return res.json({
      ok: true,
      url: publicUrl,
      total,
      zipPath,
      file: fileName
    });
  } catch (err) {
    console.error('[zip] unexpected error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- ADMIN: delete submissions ----------
app.post('/api/admin/delete-submissions', async (req, res) => {
  try {
    const { dniList } = req.body || {};
    if (!Array.isArray(dniList) || !dniList.length) {
      return res.status(400).json({ ok: false, error: 'dniList vacío.' });
    }

    const list = await loadSubmissions();
    const toDelete = list.filter((s) => s.dni && dniList.includes(s.dni));
    const remaining = list.filter((s) => !(s.dni && dniList.includes(s.dni)));

    for (const s of toDelete) {
      const abs = findApprovedPhotoByDni(s.dni);
      if (abs) await deletePhotoFile(abs);
    }

    await saveSubmissions(remaining);
    res.json({ ok: true, deleted: toDelete.length });
  } catch (err) {
    console.error('[delete-submissions] error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, validator: VALIDATOR_URL, photosRoot: PHOTOS_ROOT });
});

app.listen(PORT, () => {
  console.log(`UMA proxy running on port ${PORT}`);
  console.log(`Validator URL configured as: ${VALIDATOR_URL}`);
  console.log(`PHOTOS_ROOT: ${PHOTOS_ROOT}`);
  console.log(`ZIP_OUTPUT_DIR: ${ZIP_OUTPUT_DIR}`);
});
