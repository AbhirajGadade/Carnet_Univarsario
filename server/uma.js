// server/uma.js
const axios = require('axios');

const {
    UMA_BASE_URL = 'http://37.60.229.241:8085/service-uma',
    ADMIN_EMAIL,
    ADMIN_PASS
} = process.env;

// clean base URL (no trailing slash)
const CLEAN_BASE = UMA_BASE_URL.replace(/\/+$/, '');
const DATA_BASE_URL = `${CLEAN_BASE}/grupoa`;

// ---------- axios clients ----------
const studentClient = axios.create({
    baseURL: CLEAN_BASE,
    timeout: 15000
});

const adminClient = axios.create({
    baseURL: DATA_BASE_URL,
    timeout: 15000
});

// ---------- session helpers ----------
function setStudentAccessToken(session, token) {
    session.studentAccessToken = token || null;
}
function setStudentRefreshToken(session, token) {
    session.studentRefreshToken = token || null;
}
function getStudentAccessToken(session) {
    return session.studentAccessToken || null;
}

// ---------- STUDENT LOGIN ----------
// UMA endpoint: {UMA_BASE_URL}/login-alumno?codigo=...&dni=...
async function studentLogin({ codigo, dni }) {
    return studentClient.post('/login-alumno', null, {
        params: { codigo, dni }
    });
}

// ---------- ADMIN LOGIN (for the admin UI) ----------
// UMA endpoint: {UMA_BASE_URL}/login?email=...&password=...
async function adminLogin({ email, password }) {
    return studentClient.post('/login', null, {
        params: { email, password }
    });
}

// ---------- ADMIN SERVICE ACCOUNT (for grupoa/* data) ----------
let adminToken = null;
let adminTokenExp = 0; // epoch seconds

async function ensureAdminToken() {
    const now = Date.now() / 1000;
    if (adminToken && now < adminTokenExp - 60) {
        return adminToken;
    }

    if (!ADMIN_EMAIL || !ADMIN_PASS) {
        throw new Error('ADMIN_EMAIL or ADMIN_PASS missing in .env');
    }

    const r = await studentClient.post('/login', null, {
        params: {
            email: ADMIN_EMAIL,
            password: ADMIN_PASS
        }
    });

    const root = r.data || {};
    const data = root.data || root;
    const access = data.access_token;

    if (!access) {
        throw new Error('Admin login did not return access_token');
    }

    const expiresIn = data.expires_in || 3600;
    adminToken = access;
    adminTokenExp = now + expiresIn;
    return adminToken;
}

// ---------- STUDENT-FACING DATA (uses student token if needed) ----------
async function studentFetch(session, kind, params) {
    const token = getStudentAccessToken(session);
    if (!token) {
        const err = new Error('student not logged in');
        err.status = 401;
        throw err;
    }

    const headers = { Authorization: `Bearer ${token}` };

    switch (kind) {
        case 'student':
            return studentClient.post('/student', null, {
                params: { codigo: params.code },
                headers
            });
        case 'course-schedules':
            return studentClient.post('/course-schedules', null, {
                params: { codigo: params.code, period: params.period },
                headers
            });
        default:
            throw new Error(`Unknown studentFetch kind: ${kind}`);
    }
}

// ---------- ADMIN / GRUPOA DATA ----------
async function adminGetStudent({ code }) {
    const token = await ensureAdminToken();
    return adminClient.post('/student', null, {
        params: { code },
        headers: { Authorization: `Bearer ${token}` }
    });
}

async function adminGetCourseSchedules({ code, period }) {
    const token = await ensureAdminToken();
    return adminClient.post('/course-schedules', null, {
        params: { code, period },
        headers: { Authorization: `Bearer ${token}` }
    });
}

async function adminGetTeachers({ period }) {
    const token = await ensureAdminToken();
    return adminClient.post('/teachers', null, {
        params: { period },
        headers: { Authorization: `Bearer ${token}` }
    });
}

async function adminGetTeacherSchedule({ dni, period }) {
    const token = await ensureAdminToken();
    return adminClient.post('/teacher-schedule', null, {
        params: { dni, period },
        headers: { Authorization: `Bearer ${token}` }
    });
}

module.exports = {
    // student auth
    studentLogin,
    setStudentAccessToken,
    setStudentRefreshToken,
    studentFetch,

    // admin auth for UI
    adminLogin,

    // grupoa data
    adminGetStudent,
    adminGetCourseSchedules,
    adminGetTeachers,
    adminGetTeacherSchedule
};
