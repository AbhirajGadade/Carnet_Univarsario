// ============================================================
// MONGODB STORAGE
// server/mongoStorage.js
// ============================================================
//
// Stores:
//
// - Student information
// - Validation result
// - Approved JPEG photo
// - SUNEDU status
// - Created / updated timestamps
//
// One student = one MongoDB document identified by DNI.
//
// APPROVED:
//   metadata + photo binary are stored.
//
// REJECTED:
//   metadata/issues are stored.
//   photo is NOT stored.
//
// ============================================================

const {
  MongoClient,
  Binary,
} = require('mongodb');


// ============================================================
// ENVIRONMENT CONFIGURATION
// ============================================================

const MONGODB_URI =
  String(
    process.env.MONGODB_URI ||
    ''
  ).trim();


const MONGODB_DB =
  String(
    process.env.MONGODB_DB ||
    'uma_carnet'
  ).trim();


const MONGODB_COLLECTION =
  String(
    process.env.MONGODB_COLLECTION ||
    'submissions'
  ).trim();


// ============================================================
// CONNECTION STATE
// ============================================================

let client = null;

let database = null;

let collection = null;

let connectionPromise = null;

let connected = false;

let indexesCreated = false;


// ============================================================
// HELPERS
// ============================================================

function cleanString(value) {

  return String(
    value ?? ''
  ).trim();
}


function normalizeIssues(issues) {

  if (
    Array.isArray(
      issues
    )
  ) {

    return issues
      .map(
        issue =>
          cleanString(
            issue
          )
      )
      .filter(
        Boolean
      );
  }


  if (issues) {

    const value =
      cleanString(
        issues
      );


    return value
      ? [value]
      : [];
  }


  return [];
}


// ============================================================
// CONFIGURATION STATUS
// ============================================================

function getMongoStatus() {

  return {
    configured:
      Boolean(
        MONGODB_URI
      ),

    connected,

    database:
      MONGODB_DB,

    collection:
      MONGODB_COLLECTION,

    indexesCreated,
  };
}


// ============================================================
// VALIDATE CONFIG
// ============================================================

function assertMongoConfig() {

  if (!MONGODB_URI) {

    throw new Error(
      'MONGODB_URI is missing in .env'
    );
  }


  if (!MONGODB_DB) {

    throw new Error(
      'MONGODB_DB is missing in .env'
    );
  }


  if (!MONGODB_COLLECTION) {

    throw new Error(
      'MONGODB_COLLECTION is missing in .env'
    );
  }
}


// ============================================================
// INDEXES
// ============================================================

async function ensureIndexes() {

  if (!collection) {

    throw new Error(
      'MongoDB collection is not initialized.'
    );
  }


  if (indexesCreated) {

    return;
  }


  // One current submission per DNI.
  await collection.createIndex(
    {
      dni: 1,
    },

    {
      unique: true,

      name:
        'unique_dni',
    }
  );


  await collection.createIndex(
    {
      category: 1,
      updatedAt: -1,
    },

    {
      name:
        'category_updatedAt',
    }
  );


  await collection.createIndex(
    {
      suneduStatus: 1,
      updatedAt: -1,
    },

    {
      name:
        'suneduStatus_updatedAt',
    }
  );


  indexesCreated =
    true;
}


// ============================================================
// CONNECT
// ============================================================

async function connectMongo() {

  assertMongoConfig();


  if (
    connected &&
    client &&
    database &&
    collection
  ) {

    return {
      client,
      database,
      collection,
    };
  }


  // Prevent duplicate connections when several requests
  // arrive while MongoDB is connecting.
  if (connectionPromise) {

    return connectionPromise;
  }


  connectionPromise =
    (async () => {

      try {

        console.log(
          '[mongodb] connecting...'
        );


        client =
          new MongoClient(
            MONGODB_URI,

            {
              maxPoolSize:
                10,

              minPoolSize:
                0,

              serverSelectionTimeoutMS:
                10000,
            }
          );


        await client.connect();


        database =
          client.db(
            MONGODB_DB
          );


        collection =
          database.collection(
            MONGODB_COLLECTION
          );


        await database.command({
          ping: 1,
        });


        connected =
          true;


        console.log(
          `[mongodb] connected to database: ${MONGODB_DB}`
        );


        console.log(
          `[mongodb] collection: ${MONGODB_COLLECTION}`
        );


        await ensureIndexes();


        console.log(
          '[mongodb] indexes ready'
        );


        return {
          client,
          database,
          collection,
        };

      } catch (error) {

        connected =
          false;

        indexesCreated =
          false;


        try {

          if (client) {
            await client.close();
          }

        } catch (_) {
          // Ignore close error here.
        }


        client =
          null;

        database =
          null;

        collection =
          null;


        console.error(
          '[mongodb] connection failed:',
          error.message
        );


        throw error;

      } finally {

        connectionPromise =
          null;
      }
    })();


  return connectionPromise;
}


// ============================================================
// GET COLLECTION
// ============================================================

async function getCollection() {

  if (
    !connected ||
    !collection
  ) {

    await connectMongo();
  }


  return collection;
}


// ============================================================
// DETECT WHETHER PHOTO EXISTS
// ============================================================
//
// IMPORTANT:
//
// loadSubmissions() excludes:
//
// photo.data
//
// because sending every JPEG when loading the admin table
// would make the response unnecessarily large.
//
// Therefore we MUST NOT use:
//
// Boolean(document.photo?.data)
//
// to determine hasPhoto.
//
// Instead we use the photo metadata.
//
// ============================================================

function documentHasPhoto(document) {

  if (
    !document ||
    document.category !==
      'approved' ||
    !document.photo
  ) {

    return false;
  }


  const size =
    Number(
      document.photo.size ||
      0
    );


  return Boolean(
    size > 0 ||
    document.photo.filename ||
    document.photo.contentType
  );
}


// ============================================================
// CREATE PUBLIC SUBMISSION
// ============================================================
//
// This is returned to admin.html.
//
// It NEVER includes photo.data.
//
// ============================================================

function publicSubmission(document) {

  if (!document) {

    return null;
  }


  // ========================================================
  // IMPORTANT PHOTO FIX
  // ========================================================

  const hasPhoto =
    documentHasPhoto(
      document
    );


  const dni =
    document.dni ||
    '';


  return {

    id:
      document._id
        ? String(
            document._id
          )
        : '',


    dni,


    code:
      document.codigo ||
      '',


    codigo:
      document.codigo ||
      '',


    name:
      document.name ||
      '',


    email:
      document.email ||
      '',


    facultad:
      document.facultad ||
      '',


    faculty:
      document.facultad ||
      '',


    carrera:
      document.carrera ||
      '',


    esp:
      document.carrera ||
      '',


    category:
      document.category ||
      'rejected',


    ok:
      document.category ===
      'approved',


    issues:
      Array.isArray(
        document.issues
      )
        ? document.issues
        : [],


    suneduStatus:
      document.suneduStatus ||
      'Pendiente',


    // IMPORTANT:
    // This stays true even though photo.data
    // was excluded from loadSubmissions().
    hasPhoto,


    photo_filename:
      document.photo?.filename ||
      '',


    photo_content_type:
      document.photo?.contentType ||
      '',


    photo_size:
      document.photo?.size ||
      0,


    // Admin browser calls this authenticated backend route.
    photoUrl:
      hasPhoto &&
      dni
        ? (
            '/api/admin/photo/' +
            encodeURIComponent(
              dni
            )
          )
        : '',


    createdAt:
      document.createdAt ||
      null,


    updatedAt:
      document.updatedAt ||
      null,
  };
}


// ============================================================
// UPSERT SUBMISSION
// ============================================================
//
// Called by index.js after Python finishes validating.
//
// APPROVED:
//
// {
//   dni,
//   code,
//   name,
//   email,
//   facultad,
//   carrera,
//   category: "approved",
//   issues: [],
//   photoBuffer: Buffer,
//   photoContentType: "image/jpeg",
//   photoFilename: "...jpg"
// }
//
// REJECTED:
//
// {
//   dni,
//   code,
//   ...
//   category: "rejected",
//   issues: [...]
// }
//
// ============================================================

async function upsertSubmission(
  submission
) {

  const submissions =
    await getCollection();


  const dni =
    cleanString(
      submission.dni
    );


  if (!dni) {

    throw new Error(
      'DNI is required before saving a MongoDB submission.'
    );
  }


  const codigo =
    cleanString(
      submission.code ||
      submission.codigo
    );


  const category =
    cleanString(
      submission.category ||
      (
        submission.ok
          ? 'approved'
          : 'rejected'
      )
    )
      .toLowerCase();


  const approved =
    category ===
    'approved';


  const now =
    new Date();


  const issues =
    normalizeIssues(
      submission.issues
    );


  // ========================================================
  // STUDENT DATA
  // ========================================================

  const setFields = {

    dni,

    codigo,

    name:
      cleanString(
        submission.name
      ),

    email:
      cleanString(
        submission.email
      ),

    facultad:
      cleanString(
        submission.facultad ||
        submission.faculty
      ),

    carrera:
      cleanString(
        submission.carrera ||
        submission.esp
      ),

    category,

    issues,

    suneduStatus:
      cleanString(
        submission.suneduStatus ||
        'Pendiente'
      ) ||
      'Pendiente',

    updatedAt:
      now,
  };


  // ========================================================
  // APPROVED PHOTO
  // ========================================================

  if (approved) {

    const photoBuffer =
      submission.photoBuffer;


    if (
      !Buffer.isBuffer(
        photoBuffer
      ) ||
      photoBuffer.length ===
        0
    ) {

      throw new Error(
        'Approved submission requires a valid photoBuffer.'
      );
    }


    const photoFilename =
      cleanString(
        submission.photoFilename
      ) ||
      `${dni}_${codigo || 'NA'}.jpg`;


    const photoContentType =
      cleanString(
        submission.photoContentType
      ) ||
      'image/jpeg';


    setFields.photo = {

      // Actual JPEG binary.
      data:
        new Binary(
          photoBuffer,
          Binary.SUBTYPE_DEFAULT
        ),

      contentType:
        photoContentType,

      filename:
        photoFilename,

      // This metadata is intentionally retained when
      // photo.data is excluded from admin list queries.
      size:
        photoBuffer.length,

      updatedAt:
        now,
    };


    console.log(
      '[mongodb] storing approved JPEG:',
      {
        dni,
        filename:
          photoFilename,
        bytes:
          photoBuffer.length,
      }
    );
  }


  // ========================================================
  // UPDATE DOCUMENT
  // ========================================================

  const update = {

    $set:
      setFields,

    $setOnInsert: {

      createdAt:
        now,
    },
  };


  // Rejected photos must not be stored.
  //
  // Also remove an old approved photo if the current
  // submission for this DNI becomes rejected.
  if (!approved) {

    update.$unset = {

      photo:
        '',
    };
  }


  const result =
    await submissions.updateOne(

      {
        dni,
      },

      update,

      {
        upsert:
          true,
      }
    );


  console.log(
    '[mongodb] submission saved:',
    {
      dni,

      codigo,

      category,

      inserted:
        Boolean(
          result.upsertedId
        ),

      matched:
        result.matchedCount,

      modified:
        result.modifiedCount,
    }
  );


  // ========================================================
  // RETURN SAVED STUDENT WITHOUT PHOTO BINARY
  // ========================================================

  const saved =
    await submissions.findOne(

      {
        dni,
      },

      {
        projection: {

          'photo.data':
            0,
        },
      }
    );


  return publicSubmission(
    saved
  );
}


// ============================================================
// LOAD ALL SUBMISSIONS
// ============================================================
//
// IMPORTANT:
//
// photo.data is deliberately excluded.
//
// photo.filename
// photo.contentType
// photo.size
//
// are still returned.
//
// ============================================================

async function loadSubmissions() {

  const submissions =
    await getCollection();


  const rows =
    await submissions
      .find(
        {},

        {
          projection: {

            'photo.data':
              0,
          },
        }
      )
      .sort({
        updatedAt:
          -1,
      })
      .toArray();


  return rows.map(
    publicSubmission
  );
}


// ============================================================
// LOAD APPROVED SUBMISSIONS
// ============================================================

async function loadApprovedSubmissions() {

  const submissions =
    await getCollection();


  const rows =
    await submissions
      .find(

        {
          category:
            'approved',
        },

        {
          projection: {

            'photo.data':
              0,
          },
        }
      )
      .sort({
        updatedAt:
          -1,
      })
      .toArray();


  return rows.map(
    publicSubmission
  );
}


// ============================================================
// LOAD REJECTED SUBMISSIONS
// ============================================================

async function loadRejectedSubmissions() {

  const submissions =
    await getCollection();


  const rows =
    await submissions
      .find(

        {
          category:
            {
              $ne:
                'approved',
            },
        },

        {
          projection: {

            'photo.data':
              0,
          },
        }
      )
      .sort({
        updatedAt:
          -1,
      })
      .toArray();


  return rows.map(
    publicSubmission
  );
}


// ============================================================
// GET ONE SUBMISSION
// ============================================================

async function getSubmissionByDni(
  dni
) {

  const submissions =
    await getCollection();


  const cleanDni =
    cleanString(
      dni
    );


  if (!cleanDni) {

    return null;
  }


  const document =
    await submissions.findOne(

      {
        dni:
          cleanDni,
      },

      {
        projection: {

          'photo.data':
            0,
        },
      }
    );


  return publicSubmission(
    document
  );
}


// ============================================================
// CONVERT MONGODB BINARY TO NODE BUFFER
// ============================================================

function mongoBinaryToBuffer(
  binary
) {

  if (!binary) {

    return null;
  }


  // Already a Node.js Buffer.
  if (
    Buffer.isBuffer(
      binary
    )
  ) {

    return Buffer.from(
      binary
    );
  }


  // MongoDB BSON Binary.
  //
  // Binary.value() returns the bytes of the binary value.
  if (
    typeof binary.value ===
    'function'
  ) {

    const value =
      binary.value();


    if (value) {

      return Buffer.from(
        value
      );
    }
  }


  // Uint8Array.
  if (
    binary instanceof
    Uint8Array
  ) {

    return Buffer.from(
      binary
    );
  }


  // Fallback for BSON Binary-like objects.
  if (
    binary.buffer instanceof
    Uint8Array
  ) {

    let bytes =
      binary.buffer;


    // BSON Binary can have a buffer larger than
    // the real binary contents.
    if (
      Number.isInteger(
        binary.position
      ) &&
      binary.position >= 0 &&
      binary.position <
        bytes.length
    ) {

      bytes =
        bytes.subarray(
          0,
          binary.position
        );
    }


    return Buffer.from(
      bytes
    );
  }


  throw new Error(
    'MongoDB photo data has an unsupported binary format.'
  );
}


// ============================================================
// GET APPROVED STUDENT PHOTO
// ============================================================
//
// Used by:
//
// GET /api/admin/photo/:dni
//
// ============================================================

async function getStudentPhoto(
  dni
) {

  const submissions =
    await getCollection();


  const cleanDni =
    cleanString(
      dni
    );


  if (!cleanDni) {

    return null;
  }


  const document =
    await submissions.findOne(

      {
        dni:
          cleanDni,

        category:
          'approved',
      },

      {
        projection: {

          _id:
            0,

          dni:
            1,

          photo:
            1,
        },
      }
    );


  if (
    !document ||
    !document.photo ||
    !document.photo.data
  ) {

    console.warn(
      '[mongodb-photo] no stored photo for DNI:',
      cleanDni
    );


    return null;
  }


  const buffer =
    mongoBinaryToBuffer(
      document.photo.data
    );


  if (
    !buffer ||
    buffer.length ===
      0
  ) {

    console.warn(
      '[mongodb-photo] stored photo is empty for DNI:',
      cleanDni
    );


    return null;
  }


  console.log(
    '[mongodb-photo] photo loaded:',
    {
      dni:
        cleanDni,

      bytes:
        buffer.length,

      filename:
        document.photo.filename ||
        `${cleanDni}.jpg`,
    }
  );


  return {

    buffer,

    contentType:
      document.photo
        .contentType ||
      'image/jpeg',

    filename:
      document.photo
        .filename ||
      `${cleanDni}.jpg`,

    size:
      Number(
        document.photo.size ||
        buffer.length
      ),
  };
}


// ============================================================
// DELETE SUBMISSIONS
// ============================================================
//
// Since the photo is inside the MongoDB document,
// deleting the document also deletes the stored photo.
//
// ============================================================

async function deleteSubmissions(
  dniList
) {

  const submissions =
    await getCollection();


  if (
    !Array.isArray(
      dniList
    ) ||
    dniList.length ===
      0
  ) {

    return 0;
  }


  const cleanDnis =
    [
      ...new Set(
        dniList
          .map(
            cleanString
          )
          .filter(
            Boolean
          )
      ),
    ];


  if (
    cleanDnis.length ===
    0
  ) {

    return 0;
  }


  const result =
    await submissions.deleteMany({

      dni: {

        $in:
          cleanDnis,
      },
    });


  console.log(
    '[mongodb] deleted submissions:',
    result.deletedCount
  );


  return (
    result.deletedCount ||
    0
  );
}


// ============================================================
// MARK SUNEDU SENT
// ============================================================

async function markSuneduSent(
  dniList
) {

  const submissions =
    await getCollection();


  if (
    !Array.isArray(
      dniList
    ) ||
    dniList.length ===
      0
  ) {

    return 0;
  }


  const cleanDnis =
    [
      ...new Set(
        dniList
          .map(
            cleanString
          )
          .filter(
            Boolean
          )
      ),
    ];


  if (
    cleanDnis.length ===
    0
  ) {

    return 0;
  }


  const result =
    await submissions.updateMany(

      {
        dni: {

          $in:
            cleanDnis,
        },

        category:
          'approved',
      },

      {
        $set: {

          suneduStatus:
            'Enviado',

          updatedAt:
            new Date(),
        },
      }
    );


  console.log(
    '[mongodb] marked SUNEDU sent:',
    result.modifiedCount
  );


  return (
    result.modifiedCount ||
    0
  );
}


// ============================================================
// MARK SUNEDU PENDING
// ============================================================

async function markSuneduPending(
  dniList
) {

  const submissions =
    await getCollection();


  if (
    !Array.isArray(
      dniList
    ) ||
    dniList.length ===
      0
  ) {

    return 0;
  }


  const cleanDnis =
    [
      ...new Set(
        dniList
          .map(
            cleanString
          )
          .filter(
            Boolean
          )
      ),
    ];


  if (
    cleanDnis.length ===
    0
  ) {

    return 0;
  }


  const result =
    await submissions.updateMany(

      {
        dni: {

          $in:
            cleanDnis,
        },

        category:
          'approved',
      },

      {
        $set: {

          suneduStatus:
            'Pendiente',

          updatedAt:
            new Date(),
        },
      }
    );


  return (
    result.modifiedCount ||
    0
  );
}


// ============================================================
// VERIFY CONNECTION
// ============================================================

async function verifyMongoConnection() {

  await connectMongo();


  if (!database) {

    throw new Error(
      'MongoDB database is not initialized.'
    );
  }


  const result =
    await database.command({
      ping: 1,
    });


  return {

    ok:
      result.ok ===
      1,

    database:
      MONGODB_DB,

    collection:
      MONGODB_COLLECTION,
  };
}


// ============================================================
// CLOSE CONNECTION
// ============================================================

async function closeMongo() {

  if (!client) {

    connected =
      false;

    indexesCreated =
      false;

    return;
  }


  try {

    await client.close();


    console.log(
      '[mongodb] connection closed'
    );

  } finally {

    client =
      null;

    database =
      null;

    collection =
      null;

    connectionPromise =
      null;

    connected =
      false;

    indexesCreated =
      false;
  }
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

  // Connection
  connectMongo,
  closeMongo,
  getMongoStatus,
  verifyMongoConnection,

  // Submission CRUD
  upsertSubmission,
  loadSubmissions,
  loadApprovedSubmissions,
  loadRejectedSubmissions,
  getSubmissionByDni,

  // Photo
  getStudentPhoto,

  // Admin actions
  deleteSubmissions,
  markSuneduSent,
  markSuneduPending,
};