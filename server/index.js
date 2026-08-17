// ============================================================
// ENV + CORE IMPORTS
// ============================================================

const path = require('path');

// Load .env from project root: <root>/.env
require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
});

const fs = require('fs');
const fsp = fs.promises;

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');


// ============================================================
// HELPERS
// ============================================================

// Builds SUNEDU ZIP files.
const {
  createAdminZip,
} = require('./adminZipHelper');


// ============================================================
// MONGODB STORAGE
// ============================================================

const {
  connectMongo,
  closeMongo,
  getMongoStatus,
  verifyMongoConnection,

  upsertSubmission,
  loadSubmissions,

  getStudentPhoto,

  deleteSubmissions,
  markSuneduSent,
} = require('./mongoStorage');


// ============================================================
// UMA API HELPERS
// ============================================================

const {
  studentLogin,

  setStudentAccessToken,
  setStudentRefreshToken,

  adminLogin,
  adminGetStudent,
  adminGetCourseSchedules,

  adminGetTeachers,
  adminGetTeacherSchedule,
} = require('./uma');


// ============================================================
// ENVIRONMENT VARIABLES
// ============================================================

const {
  PORT = 5000,

  SESSION_SECRET = 'change-this',

  VALIDATOR_URL: ENV_VALIDATOR_URL,

  UMA_BASE_URL,

  ADMIN_EMAIL,
  ADMIN_PASS,

  // Carnet payment API.
  CARNET_API_URL,

  CARNET_API_USER,
  CARNET_API_PASS,

  CARNET_CONCEPT_CODE,
  CARNET_PERIOD,
} = process.env;


// Normalize UMA URL.
const UMA_BASE = (UMA_BASE_URL || '')
  .trim()
  .replace(/\/$/, '');


// Python FastAPI validator.
const VALIDATOR_URL =
  ENV_VALIDATOR_URL ||
  'http://127.0.0.1:8000';


// ============================================================
// EXPRESS
// ============================================================

const app = express();


// Keep uploaded photo in memory before sending it to Python.
const upload = multer({
  storage: multer.memoryStorage(),
});


// ============================================================
// PATHS
// ============================================================

const ROOT_DIR = path.join(
  __dirname,
  '..'
);


// Python validator currently keeps an approved local copy here.
// MongoDB also stores the approved JPEG.
//
// The local copy is still useful for your current ZIP generator.
const PHOTOS_ROOT = path.join(
  ROOT_DIR,
  'photo',
  'photos'
);


// ZIP output folder.
const ZIP_OUTPUT_DIR = path.join(
  ROOT_DIR,
  'tmp_zips'
);


if (!fs.existsSync(ZIP_OUTPUT_DIR)) {
  fs.mkdirSync(
    ZIP_OUTPUT_DIR,
    {
      recursive: true,
    }
  );
}


// ============================================================
// LOCAL PHOTO HELPERS
// ============================================================

function findApprovedPhotoByDni(dni) {
  if (!dni) {
    return null;
  }


  const approvedDir = path.join(
    PHOTOS_ROOT,
    'approved'
  );


  const exactPhoto = path.join(
    approvedDir,
    `${dni}.jpg`
  );


  if (fs.existsSync(exactPhoto)) {
    return exactPhoto;
  }


  try {
    const files = fs.readdirSync(
      approvedDir
    );


    const match = files.find(
      (name) =>
        name.startsWith(
          String(dni)
        )
    );


    if (match) {
      return path.join(
        approvedDir,
        match
      );
    }
  } catch (_) {
    // Folder may not exist yet.
  }


  return null;
}


// Delete a local approved photo safely.
async function deletePhotoFile(absPath) {
  if (!absPath) {
    return;
  }


  try {
    const absolutePath =
      path.resolve(absPath);


    const photoRoot =
      path.resolve(
        PHOTOS_ROOT
      );


    if (
      !absolutePath.startsWith(
        photoRoot
      )
    ) {
      console.warn(
        '[delete] refused outside photos root:',
        absolutePath
      );

      return;
    }


    await fsp.unlink(
      absolutePath
    );
  } catch (err) {
    if (
      err.code !==
      'ENOENT'
    ) {
      console.warn(
        '[delete] unlink error:',
        err
      );
    }
  }
}


// ============================================================
// UMA HELPER
// Retry UMA admin operations when access token expires.
// ============================================================

async function callUmaWithAdminRetry(
  fn,
  args = {}
) {
  let firstError = null;


  try {
    return await fn(args);
  } catch (err) {
    const status =
      err?.response?.status ||
      err?.status;


    const authError =
      status === 401 ||
      status === 403;


    if (
      !authError ||
      !ADMIN_EMAIL ||
      !ADMIN_PASS
    ) {
      throw err;
    }


    firstError = err;
  }


  console.warn(
    '[uma] got 401/403. Calling adminLogin() once to refresh token and retry...'
  );


  try {
    await adminLogin({
      email: ADMIN_EMAIL,
      password: ADMIN_PASS,
    });
  } catch (loginErr) {
    console.error(
      '[uma] adminLogin retry failed:',
      loginErr.response?.data ||
      loginErr.message ||
      loginErr
    );


    throw firstError;
  }


  try {
    return await fn(args);
  } catch (err) {
    const status =
      err?.response?.status ||
      err?.status;


    console.error(
      '[uma] request failed again after adminLogin. status=',
      status,
      'body=',
      err.response?.data ||
      err.message ||
      err
    );


    throw err;
  }
}


// ============================================================
// UMA ADMIN TOKEN
// ============================================================

async function getUmaAdminToken() {
  if (
    !ADMIN_EMAIL ||
    !ADMIN_PASS
  ) {
    console.error(
      '[uma-admin-token] ADMIN_EMAIL or ADMIN_PASS missing in .env'
    );

    return null;
  }


  try {
    const response =
      await adminLogin({
        email: ADMIN_EMAIL,
        password: ADMIN_PASS,
      });


    const root =
      response.data || {};


    const data =
      root.data || root;


    const token =
      data.access_token ||
      root.access_token ||
      null;


    if (!token) {
      console.error(
        '[uma-admin-token] UMA admin login did not return access_token:',
        root
      );

      return null;
    }


    console.log(
      '[uma-admin-token] got access_token starting with:',
      token.slice(0, 20),
      '...'
    );


    return token;
  } catch (err) {
    console.error(
      '[uma-admin-token] UMA admin login failed:',
      err.response?.data ||
      err.message ||
      err
    );


    return null;
  }
}


// ============================================================
// FETCH STUDENT FROM UMA
// ============================================================

async function fetchStudentFromUma({
  codigo,
}) {
  if (!UMA_BASE) {
    console.warn(
      '[student-uma] UMA_BASE_URL not configured. Cannot fetch student profile.'
    );

    return null;
  }


  const adminToken =
    await getUmaAdminToken();


  if (!adminToken) {
    return null;
  }


  const codeStr =
    String(codigo)
      .trim();


  const url =
    `${UMA_BASE}/grupoa/student`;


  const body = {
    code: codeStr,
    codigo: codeStr,
  };


  console.log(
    '[student-uma] POST',
    url,
    'body =',
    body
  );


  try {
    const response =
      await axios.post(
        url,

        body,

        {
          headers: {
            Authorization:
              `Bearer ${adminToken}`,
          },

          timeout: 15000,

          validateStatus:
            () => true,
        }
      );


    const httpStatus =
      response.status;


    const payload =
      response.data || {};


    console.log(
      '[student-uma] HTTP',
      httpStatus,
      '- raw payload:',
      JSON.stringify(payload)
        .slice(0, 300) + '...'
    );


    if (
      httpStatus < 200 ||
      httpStatus >= 300
    ) {
      console.error(
        '[student-uma] unexpected status from student API:',
        httpStatus,
        payload
      );


      return null;
    }


    return (
      payload.data ??
      payload
    );
  } catch (err) {
    console.error(
      '[student-uma] error calling UMA student API:',
      err
    );


    return null;
  }
}


// ============================================================
// CARNET PAYMENT CHECK
// ============================================================
//
// Checks:
//
// codAlu === student code
// period === CARNET_PERIOD
// number_ticket must exist
//
// ============================================================

async function checkCarnetPayment({
  codigo,
  dni,
}) {
  const url =
    (CARNET_API_URL || '')
      .trim();


  if (!url) {
    console.warn(
      '[carnet] CARNET_API_URL is not configured. Skipping carnet payment check.'
    );


    return {
      allowed: true,
      reason: 'no_config',
    };
  }


  const conceptCode =
    (
      CARNET_CONCEPT_CODE ||
      '181035'
    )
      .toString()
      .trim();


  const periodFilter =
    (
      CARNET_PERIOD ||
      ''
    )
      .toString()
      .trim() ||
    null;


  try {
    const wantedCodigo =
      codigo
        .toString()
        .trim();


    const wantedDni =
      (dni || '')
        .toString()
        .trim() ||
      null;


    const body = {
      codigo:
        conceptCode,
    };


    if (wantedDni) {
      body.dni =
        wantedDni;
    }


    if (periodFilter) {
      body.period =
        periodFilter;
    }


    const adminToken =
      await getUmaAdminToken();


    if (!adminToken) {
      return {
        allowed: false,

        reason:
          'No se pudo verificar el pago del carné (no se pudo obtener token de UMA).',
      };
    }


    console.log(
      '[carnet] POST',
      url,
      'body =',
      body
    );


    const response =
      await axios.post(
        url,

        body,

        {
          headers: {
            Authorization:
              `Bearer ${adminToken}`,
          },

          timeout: 15000,

          validateStatus:
            () => true,
        }
      );


    const httpStatus =
      response.status;


    const payload =
      response.data || {};


    const rows =
      Array.isArray(
        payload.data
      )
        ? payload.data
        : [];


    console.log(
      '[carnet] HTTP',
      httpStatus,
      '- received',
      rows.length,
      'row(s) from carnet_payments'
    );


    if (
      httpStatus < 200 ||
      httpStatus >= 300
    ) {
      console.error(
        '[carnet] unexpected status from carnet API:',
        httpStatus,
        payload
      );


      return {
        allowed: false,

        reason:
          'No se pudo verificar el pago del carné (error en el servicio remoto).',

        raw:
          payload,
      };
    }


    const periodFilterStr =
      periodFilter
        ? periodFilter
            .toString()
            .trim()
        : null;


    const match =
      rows.find(
        (row) => {
          const codAlu =
            (
              row.codAlu ||
              ''
            )
              .toString()
              .trim();


          const rowDni =
            (
              row.dni ||
              ''
            )
              .toString()
              .trim();


          const ticket =
            (
              row.number_ticket ||
              ''
            )
              .toString()
              .trim();


          const period =
            (
              row.period ||
              ''
            )
              .toString()
              .trim();


          if (!ticket) {
            return false;
          }


          if (
            codAlu !==
            wantedCodigo
          ) {
            return false;
          }


          if (
            periodFilterStr &&
            period !==
              periodFilterStr
          ) {
            return false;
          }


          if (
            wantedDni &&
            rowDni &&
            rowDni !==
              wantedDni
          ) {
            console.log(
              '[carnet] codAlu match but DNI mismatch',
              {
                codAlu,
                rowDni,
                wantedDni,
              }
            );
          }


          return true;
        }
      );


    if (match) {
      console.log(
        '[carnet] payment match found:',
        match
      );


      return {
        allowed: true,
        reason: 'ok',
        row: match,
        raw: payload,
      };
    }


    console.log(
      '[carnet] no matching payment found for codigo =',
      wantedCodigo,
      'dni =',
      wantedDni
    );


    return {
      allowed: false,

      reason:
        'No se encontró un pago válido de carné universitario para este estudiante.',

      raw:
        payload,
    };
  } catch (err) {
    console.error(
      '[carnet] error calling carnet API:',
      err
    );


    return {
      allowed: false,

      reason:
        'No se pudo verificar el pago del carné. Intenta nuevamente más tarde.',

      error:
        err.message ||
        String(err),
    };
  }
}


// ============================================================
// EXPRESS MIDDLEWARE
// ============================================================

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);


app.use(
  express.json()
);


app.use(
  cookieParser()
);


app.use(
  session({
    secret:
      SESSION_SECRET,

    resave:
      false,

    saveUninitialized:
      false,

    cookie: {
      httpOnly:
        true,

      sameSite:
        'lax',
    },
  })
);


// ============================================================
// ADMIN SECURITY
// ============================================================

function requireAdmin(
  req,
  res,
  next
) {
  if (
    !req.session ||
    !req.session.adminAccessToken
  ) {
    return res
      .status(401)
      .json({
        ok: false,

        error:
          'Administrator authentication required',
      });
  }


  next();
}


// ============================================================
// STATIC ASSETS
// ============================================================

app.use(
  express.static(
    path.join(
      ROOT_DIR,
      'public'
    )
  )
);


// Local approved photo fallback.
app.use(
  '/photos',

  express.static(
    PHOTOS_ROOT
  )
);


// Generated ZIP files.
app.use(
  '/downloads',

  express.static(
    ZIP_OUTPUT_DIR
  )
);


// ============================================================
// STUDENT LOGIN
// ============================================================

app.post(
  '/api/student/login',

  async (
    req,
    res
  ) => {
    try {
      const {
        codigo,
        dni,
      } = req.body;


      if (
        !codigo ||
        !dni
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'codigo and dni are required',
          });
      }


      // -----------------------------------------
      // STEP 1
      // Verify carnet payment.
      // -----------------------------------------

      const carnet =
        await checkCarnetPayment({
          codigo,
          dni,
        });


      if (!carnet.allowed) {
        return res
          .status(403)
          .json({
            ok: false,

            error:
              carnet.reason ||
              'No se encontró un pago válido de carné universitario para este estudiante.',

            carnet,
          });
      }


      // -----------------------------------------
      // STEP 2
      // UMA student login.
      // -----------------------------------------

      const response =
        await studentLogin({
          codigo,
          dni,
        });


      const root =
        response.data || {};


      const data =
        root.data || root;


      const access =
        data.access_token ||
        root.access_token ||
        null;


      const refresh =
        data.refresh_token ||
        root.refresh_token ||
        null;


      if (!access) {
        return res
          .status(502)
          .json({
            ok: false,

            error:
              'UMA login did not return tokens',

            raw:
              root,
          });
      }


      setStudentAccessToken(
        req.session,
        access
      );


      setStudentRefreshToken(
        req.session,
        refresh
      );


      // -----------------------------------------
      // STEP 3
      // Get UMA student profile.
      // -----------------------------------------

      const studentProfile =
        await fetchStudentFromUma({
          codigo,
        });


      return res.json({
        ok: true,

        message:
          'login ok',

        carnet: {
          ok: true,

          reason:
            carnet.reason ||
            'ok',

          row:
            carnet.row ||
            null,
        },

        student:
          studentProfile ||
          null,
      });
    } catch (error) {
      const status =
        error.response?.status ||
        error.status ||
        500;


      return res
        .status(status)
        .json({
          ok: false,

          error:
            error.response?.data ||
            error.message,
        });
    }
  }
);


// ============================================================
// ADMIN LOGIN
// ============================================================

app.post(
  '/api/admin/login',

  async (
    req,
    res
  ) => {
    try {
      const {
        email,
        password,
      } = req.body;


      if (
        !email ||
        !password
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'email and password are required',
          });
      }


      const response =
        await adminLogin({
          email,
          password,
        });


      const root =
        response.data || {};


      const data =
        root.data || root;


      const access =
        data.access_token ||
        root.access_token ||
        null;


      if (!access) {
        return res
          .status(502)
          .json({
            ok: false,

            error:
              'UMA admin login did not return token',

            raw:
              root,
          });
      }


      req.session.adminAccessToken =
        access;


      return res.json({
        ok: true,

        message:
          'admin login ok',
      });
    } catch (error) {
      const status =
        error.response?.status ||
        error.status ||
        500;


      return res
        .status(status)
        .json({
          ok: false,

          error:
            error.response?.data ||
            error.message,
        });
    }
  }
);


// ============================================================
// STUDENT PROFILE
// ============================================================

app.post(
  '/api/student/profile',

  async (
    req,
    res
  ) => {
    try {
      const {
        code,
      } = req.body;


      if (!code) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'code is required',
          });
      }


      const studentProfile =
        await fetchStudentFromUma({
          codigo:
            code,
        });


      if (!studentProfile) {
        return res
          .status(502)
          .json({
            ok: false,

            error:
              'No se pudo obtener el perfil del estudiante desde UMA.',
          });
      }


      return res.json({
        ok: true,
        data: studentProfile,
      });
    } catch (error) {
      const status =
        error.response?.status ||
        error.status ||
        500;


      return res
        .status(status)
        .json({
          ok: false,

          error:
            error.response?.data ||
            error.message,
        });
    }
  }
);


// ============================================================
// STUDENT COURSE SCHEDULES
// ============================================================

app.post(
  '/api/student/course-schedules',

  async (
    req,
    res
  ) => {
    try {
      const {
        code,
        period,
      } = req.body;


      if (
        !code ||
        !period
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'code and period are required',
          });
      }


      const response =
        await callUmaWithAdminRetry(
          adminGetCourseSchedules,

          {
            code,
            period,
          }
        );


      return res.json({
        ok: true,
        data: response.data,
      });
    } catch (error) {
      const status =
        error.response?.status ||
        error.status ||
        500;


      return res
        .status(status)
        .json({
          ok: false,

          error:
            error.response?.data ||
            error.message,
        });
    }
  }
);


// ============================================================
// ADMIN STUDENT DATA
// ============================================================

app.post(
  '/api/admin/student',

  async (
    req,
    res
  ) => {
    try {
      const {
        code,
      } = req.body;


      if (!code) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'code is required',
          });
      }


      const response =
        await callUmaWithAdminRetry(
          adminGetStudent,

          {
            code,
          }
        );


      return res.json({
        ok: true,
        data: response.data,
      });
    } catch (error) {
      const status =
        error.response?.status ||
        error.status ||
        500;


      return res
        .status(status)
        .json({
          ok: false,

          error:
            error.response?.data ||
            error.message,
        });
    }
  }
);


// ============================================================
// ADMIN COURSE SCHEDULES
// ============================================================

app.post(
  '/api/admin/course-schedules',

  async (
    req,
    res
  ) => {
    try {
      const {
        code,
        period,
      } = req.body;


      if (
        !code ||
        !period
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'code and period are required',
          });
      }


      const response =
        await callUmaWithAdminRetry(
          adminGetCourseSchedules,

          {
            code,
            period,
          }
        );


      return res.json({
        ok: true,
        data: response.data,
      });
    } catch (error) {
      const status =
        error.response?.status ||
        error.status ||
        500;


      return res
        .status(status)
        .json({
          ok: false,

          error:
            error.response?.data ||
            error.message,
        });
    }
  }
);


// ============================================================
// ADMIN TEACHERS
// ============================================================

app.post(
  '/api/admin/teachers',

  async (
    req,
    res
  ) => {
    try {
      const {
        period,
      } = req.body;


      if (!period) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'period is required',
          });
      }


      const response =
        await callUmaWithAdminRetry(
          adminGetTeachers,

          {
            period,
          }
        );


      return res.json({
        ok: true,
        data: response.data,
      });
    } catch (error) {
      const status =
        error.response?.status ||
        error.status ||
        500;


      return res
        .status(status)
        .json({
          ok: false,

          error:
            error.response?.data ||
            error.message,
        });
    }
  }
);


// ============================================================
// ADMIN TEACHER SCHEDULE
// ============================================================

app.post(
  '/api/admin/teacher-schedule',

  async (
    req,
    res
  ) => {
    try {
      const {
        dni,
        period,
      } = req.body;


      if (
        !dni ||
        !period
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'dni and period are required',
          });
      }


      const response =
        await callUmaWithAdminRetry(
          adminGetTeacherSchedule,

          {
            dni,
            period,
          }
        );


      return res.json({
        ok: true,
        data: response.data,
      });
    } catch (error) {
      const status =
        error.response?.status ||
        error.status ||
        500;


      return res
        .status(status)
        .json({
          ok: false,

          error:
            error.response?.data ||
            error.message,
        });
    }
  }
);


// ============================================================
// PHOTO VALIDATOR
//
// Student photo
//      ↓
// Python validator
//      ↓
// Approved?
//      ↓
// Node converts processed JPEG to Buffer
//      ↓
// MongoDB stores:
//    - student information
//    - validation result
//    - approved JPEG
//
// Rejected photos are NOT stored.
// ============================================================

app.post(
  '/validate',

  upload.single('image'),

  async (
    req,
    res
  ) => {
    try {
      const file =
        req.file;


      const bodyFields =
        req.body || {};


      const dni =
        String(
          bodyFields.dni ||
          'unknown_user'
        ).trim();


      const code =
        String(
          bodyFields.code ||
          ''
        ).trim();


      if (!file) {
        return res
          .status(400)
          .json({
            ok: false,

            issues: [
              'No file provided',
            ],
          });
      }


      // =====================================================
      // ENRICH STUDENT DATA USING UMA
      // =====================================================

      let name =
        bodyFields.name ||
        '';


      let email =
        bodyFields.email ||
        '';


      let esp =
        bodyFields.esp ||
        '';


      let facultad =
        bodyFields.facultad ||
        bodyFields.faculty ||
        '';


      if (
        code &&
        (
          !name ||
          !email ||
          !esp ||
          !facultad
        )
      ) {
        try {
          const response =
            await callUmaWithAdminRetry(
              adminGetStudent,

              {
                code,
              }
            );


          const root =
            response.data || {};


          const student =
            root.data ||
            root ||
            {};


          const firstName =
            student.name ||
            student.nombres ||
            student.nombre ||
            '';


          const lastName =
            student.lastname ||
            student.apellidos ||
            student.apellido ||
            [
              student.apellidoPaterno,
              student.apellidoMaterno,
            ]
              .filter(Boolean)
              .join(' ') ||
            '';


          const fullName =
            [
              firstName,
              lastName,
            ]
              .filter(Boolean)
              .join(' ');


          if (
            !name &&
            fullName
          ) {
            name =
              fullName;
          }


          if (!email) {
            email =
              student.email_institucional ||
              student.emailInstitucional ||
              student.email ||
              '';
          }


          if (!esp) {
            esp =
              student.carrera ||
              student.especialidad ||
              student.specialtyName ||
              student.schoolName ||
              '';
          }


          if (!facultad) {
            facultad =
              student.facultad ||
              student.faculty ||
              student.facultyName ||
              student.facultadNombre ||
              '';
          }
        } catch (err) {
          console.warn(
            '[validate] adminGetStudent failed for code',
            code,
            err.message ||
            err
          );
        }
      }


      // =====================================================
      // SEND PHOTO TO PYTHON VALIDATOR
      // =====================================================

      const formData =
        new FormData();


      formData.append(
        'image',

        file.buffer,

        {
          filename:
            file.originalname,

          contentType:
            file.mimetype ||
            'application/octet-stream',
        }
      );


      formData.append(
        'dni',
        dni
      );


      const validatorEndpoint =
        `${VALIDATOR_URL}/validate`;


      console.log(
        '[validate] calling validator at:',
        validatorEndpoint
      );


      const validatorResponse =
        await axios.post(
          validatorEndpoint,

          formData,

          {
            headers:
              formData.getHeaders(),

            maxContentLength:
              Infinity,

            maxBodyLength:
              Infinity,

            validateStatus:
              () => true,
          }
        );


      const data =
        validatorResponse.data ||
        {};


      const ok =
        Boolean(
          data.ok
        );


      const category =
        ok
          ? 'approved'
          : 'rejected';


      // =====================================================
      // CREATE APPROVED PHOTO BUFFER
      // =====================================================

      let photoBuffer =
        null;


      if (ok) {
        const dataUrl =
          String(
            data.data_url ||
            ''
          );


        let base64 =
          '';


        if (
          dataUrl.includes(',')
        ) {
          base64 =
            dataUrl.split(',')[1] ||
            '';
        }


        if (!base64) {
          console.error(
            '[validate] approved photo returned without data_url'
          );


          return res
            .status(502)
            .json({
              ok: false,

              issues: [
                'La foto fue aprobada, pero el validador no devolvió la imagen procesada.',
              ],
            });
        }


        try {
          photoBuffer =
            Buffer.from(
              base64,
              'base64'
            );
        } catch (error) {
          console.error(
            '[validate] could not decode JPEG:',
            error
          );


          return res
            .status(502)
            .json({
              ok: false,

              issues: [
                'No se pudo procesar la imagen aprobada.',
              ],
            });
        }


        if (
          !photoBuffer ||
          !photoBuffer.length
        ) {
          return res
            .status(502)
            .json({
              ok: false,

              issues: [
                'La imagen procesada está vacía.',
              ],
            });
        }


        console.log(
          '[validate] processed JPEG size:',
          photoBuffer.length,
          'bytes'
        );
      }


      // =====================================================
      // SAVE IN MONGODB
      // =====================================================

      try {
        const saved =
          await upsertSubmission({
            dni,

            code,

            codigo:
              code,

            name,

            email,

            facultad,

            carrera:
              esp,

            esp,

            category,

            ok,

            issues:
              Array.isArray(
                data.issues
              )
                ? data.issues
                : [],

            suneduStatus:
              'Pendiente',

            // Only approved submissions have a photo.
            photoBuffer:
              ok
                ? photoBuffer
                : null,

            photoContentType:
              ok
                ? 'image/jpeg'
                : null,

            photoFilename:
              ok
                ? `${dni}_${code || 'NA'}.jpg`
                : null,
          });


        console.log(
          '[mongodb] submission saved:',
          {
            dni,
            category,
            hasPhoto:
              Boolean(
                saved?.hasPhoto
              ),
          }
        );
      } catch (storageError) {
        console.error(
          '[mongodb] submission save error:',
          storageError
        );


        if (ok) {
          return res
            .status(502)
            .json({
              ok: false,

              issues: [
                'La foto fue aprobada, pero no se pudo guardar en MongoDB. Intenta nuevamente.',
              ],

              storage_error:
                storageError.message,
            });
        }


        // Rejected result still goes back to student.
        console.warn(
          '[mongodb] rejected submission could not be recorded.'
        );
      }


      // =====================================================
      // RETURN PYTHON VALIDATION RESULT
      // =====================================================

      return res
        .status(
          validatorResponse.status ||
          200
        )
        .json(data);
    } catch (err) {
      console.error(
        'Validator proxy error:',
        err
      );


      return res
        .status(500)
        .json({
          ok: false,

          issues: [
            'Validation service error: ' +
            err.message,
          ],
        });
    }
  }
);


// ============================================================
// PHOTO AUTO-FIX
//
// Does NOT save anything to MongoDB.
// Student must submit the corrected photo afterward.
// ============================================================

app.post(
  '/fix-photo',

  upload.single('image'),

  async (
    req,
    res
  ) => {
    try {
      const file =
        req.file;


      if (!file) {
        return res
          .status(400)
          .json({
            ok: false,

            issues: [
              'No file provided',
            ],
          });
      }


      const formData =
        new FormData();


      formData.append(
        'image',

        file.buffer,

        {
          filename:
            file.originalname ||
            'photo.jpg',

          contentType:
            file.mimetype ||
            'application/octet-stream',
        }
      );


      const validatorEndpoint =
        `${VALIDATOR_URL}/fix-photo`;


      console.log(
        '[fix-photo] calling validator at:',
        validatorEndpoint
      );


      const response =
        await axios.post(
          validatorEndpoint,

          formData,

          {
            headers:
              formData.getHeaders(),

            maxContentLength:
              Infinity,

            maxBodyLength:
              Infinity,

            validateStatus:
              () => true,
          }
        );


      return res
        .status(
          response.status ||
          200
        )
        .json(
          response.data ||
          {}
        );
    } catch (err) {
      console.error(
        'Fix-photo proxy error:',
        err
      );


      return res
        .status(500)
        .json({
          ok: false,

          issues: [
            'Error interno al intentar corregir la foto automáticamente.',
          ],
        });
    }
  }
);


// ============================================================
// ADMIN
// LOAD SUBMISSIONS FROM MONGODB
// ============================================================

app.get(
  '/api/admin/submissions',

  requireAdmin,

  async (
    _req,
    res
  ) => {
    try {
      const list =
        await loadSubmissions();


      const approved =
        list.filter(
          (student) =>
            student.category ===
            'approved'
        );


      const rejected =
        list.filter(
          (student) =>
            student.category !==
            'approved'
        );


      return res.json({
        ok: true,

        data: {
          approved,
          rejected,
        },
      });
    } catch (err) {
      console.error(
        '[mongodb] admin list error:',
        err
      );


      return res
        .status(500)
        .json({
          ok: false,

          error:
            err.message,
        });
    }
  }
);


// ============================================================
// ADMIN
// PHOTO STORED INSIDE MONGODB
//
// Example:
// /api/admin/photo/76163476
// ============================================================

app.get(
  '/api/admin/photo/:dni',

  requireAdmin,

  async (
    req,
    res
  ) => {
    try {
      const dni =
        String(
          req.params.dni ||
          ''
        ).trim();


      if (!dni) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'DNI is required.',
          });
      }


      const photo =
        await getStudentPhoto(
          dni
        );


      if (!photo) {
        return res
          .status(404)
          .json({
            ok: false,

            error:
              'Photo not found',
          });
      }


      res.setHeader(
        'Content-Type',
        photo.contentType ||
        'image/jpeg'
      );


      res.setHeader(
        'Content-Length',
        photo.buffer.length
      );


      res.setHeader(
        'Cache-Control',
        'private, max-age=300'
      );


      res.setHeader(
        'Content-Disposition',
        `inline; filename="${photo.filename || `${dni}.jpg`}"`
      );


      return res.send(
        photo.buffer
      );
    } catch (err) {
      console.error(
        '[mongodb-photo]',
        err
      );


      return res
        .status(500)
        .json({
          ok: false,

          error:
            err.message,
        });
    }
  }
);


// ============================================================
// ADMIN
// GENERATE SUNEDU ZIP
//
// MongoDB provides the student records.
//
// The current ZIP helper still uses the approved local JPEG
// copy generated by Python.
// ============================================================

app.post(
  '/api/admin/generate-zip',

  requireAdmin,

  async (
    req,
    res
  ) => {
    try {
      const {
        dniList,
      } = req.body || {};


      const list =
        await loadSubmissions();


      let selected =
        list.filter(
          (student) =>
            student.category ===
            'approved'
        );


      if (
        Array.isArray(
          dniList
        ) &&
        dniList.length
      ) {
        const dniSet =
          new Set(
            dniList.map(
              (dni) =>
                String(dni)
            )
          );


        selected =
          selected.filter(
            (student) =>
              student.dni &&
              dniSet.has(
                String(
                  student.dni
                )
              )
          );
      }


      console.log(
        '[zip] approved in MongoDB:',
        list.filter(
          (student) =>
            student.category ===
            'approved'
        ).length
      );


      console.log(
        '[zip] requested DNIs:',
        selected.map(
          (student) =>
            student.dni
        )
      );


      if (!selected.length) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'No hay estudiantes seleccionados.',
          });
      }


      const {
        zipPath,
        total,
        fileName,
      } =
        await createAdminZip(
          selected,

          {
            outDir:
              ZIP_OUTPUT_DIR,
          }
        );


      const publicUrl =
        `/downloads/${fileName}`;


      return res.json({
        ok: true,

        url:
          publicUrl,

        total,

        zipPath,

        file:
          fileName,
      });
    } catch (err) {
      console.error(
        '[zip] unexpected error:',
        err
      );


      return res
        .status(500)
        .json({
          ok: false,

          error:
            err.message,
        });
    }
  }
);


// ============================================================
// ADMIN
// DELETE STUDENTS
//
// Deletes:
//
// 1. MongoDB student document
// 2. MongoDB photo (inside same document)
// 3. Local approved photo copy
//
// ============================================================

app.post(
  '/api/admin/delete-submissions',

  requireAdmin,

  async (
    req,
    res
  ) => {
    try {
      const {
        dniList,
      } = req.body || {};


      if (
        !Array.isArray(
          dniList
        ) ||
        !dniList.length
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'dniList vacío.',
          });
      }


      const cleanDniList =
        dniList
          .map(
            (dni) =>
              String(dni)
                .trim()
          )
          .filter(Boolean);


      if (!cleanDniList.length) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'dniList vacío.',
          });
      }


      // -----------------------------------------
      // Delete MongoDB records.
      // -----------------------------------------

      const deleted =
        await deleteSubmissions(
          cleanDniList
        );


      // -----------------------------------------
      // Delete local approved copies.
      // -----------------------------------------

      for (
        const dni
        of cleanDniList
      ) {
        const localPhoto =
          findApprovedPhotoByDni(
            dni
          );


        if (localPhoto) {
          await deletePhotoFile(
            localPhoto
          );
        }
      }


      return res.json({
        ok: true,

        deleted,
      });
    } catch (err) {
      console.error(
        '[delete-submissions] error:',
        err
      );


      return res
        .status(500)
        .json({
          ok: false,

          error:
            err.message,
        });
    }
  }
);


// ============================================================
// ADMIN
// MARK SUNEDU SENT
// ============================================================

app.post(
  '/api/admin/mark-sunedu-sent',

  requireAdmin,

  async (
    req,
    res
  ) => {
    try {
      const {
        dniList,
      } = req.body || {};


      if (
        !Array.isArray(
          dniList
        ) ||
        !dniList.length
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'dniList vacío.',
          });
      }


      const cleanDniList =
        dniList
          .map(
            (dni) =>
              String(dni)
                .trim()
          )
          .filter(Boolean);


      const updated =
        await markSuneduSent(
          cleanDniList
        );


      return res.json({
        ok: true,

        updated,
      });
    } catch (err) {
      console.error(
        '[mark-sunedu-sent] error:',
        err
      );


      return res
        .status(500)
        .json({
          ok: false,

          error:
            err.message,
        });
    }
  }
);


// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  '/health',

  async (
    _req,
    res
  ) => {
    const mongo =
      getMongoStatus();


    let mongoConnection =
      null;


    if (mongo.configured) {
      try {
        mongoConnection =
          await verifyMongoConnection();
      } catch (err) {
        mongoConnection = {
          ok: false,

          error:
            err.message,
        };
      }
    }


    return res.json({
      ok: true,

      validator:
        VALIDATOR_URL,

      photosRoot:
        PHOTOS_ROOT,

      zipOutputDir:
        ZIP_OUTPUT_DIR,

      storage:
        'mongodb',

      mongo,

      mongoConnection,
    });
  }
);


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(
  signal
) {
  console.log(
    `[server] received ${signal}. Closing MongoDB...`
  );


  try {
    await closeMongo();
  } catch (err) {
    console.error(
      '[mongodb] shutdown error:',
      err
    );
  }


  process.exit(0);
}


process.on(
  'SIGINT',
  () =>
    shutdown('SIGINT')
);


process.on(
  'SIGTERM',
  () =>
    shutdown('SIGTERM')
);


// ============================================================
// START SERVER
// ============================================================

async function startServer() {
  try {
    // Connect to MongoDB first.
    await connectMongo();


    const mongoStatus =
      getMongoStatus();


    console.log(
      '============================================'
    );


    console.log(
      'MongoDB connection ready'
    );


    console.log(
      'MongoDB configured:',
      mongoStatus.configured
    );


    console.log(
      'MongoDB connected:',
      mongoStatus.connected
    );


    console.log(
      'MongoDB database:',
      mongoStatus.database
    );


    console.log(
      'MongoDB collection:',
      mongoStatus.collection
    );


    console.log(
      '============================================'
    );


    app.listen(
      PORT,

      () => {
        console.log(
          '============================================'
        );


        console.log(
          `UMA proxy running on port ${PORT}`
        );


        console.log(
          `Validator URL configured as: ${VALIDATOR_URL}`
        );


        console.log(
          `PHOTOS_ROOT: ${PHOTOS_ROOT}`
        );


        console.log(
          `ZIP_OUTPUT_DIR: ${ZIP_OUTPUT_DIR}`
        );


        console.log(
          'Storage: MongoDB'
        );


        console.log(
          `MongoDB database: ${mongoStatus.database}`
        );


        console.log(
          `MongoDB collection: ${mongoStatus.collection}`
        );


        console.log(
          '============================================'
        );
      }
    );
  } catch (err) {
    console.error(
      '============================================'
    );


    console.error(
      '[mongodb] Could not start application.'
    );


    console.error(
      err.message ||
      err
    );


    console.error(
      'Check these .env values:'
    );


    console.error(
      'MONGODB_URI'
    );


    console.error(
      'MONGODB_DB'
    );


    console.error(
      'MONGODB_COLLECTION'
    );


    console.error(
      '============================================'
    );


    process.exit(1);
  }
}


startServer();