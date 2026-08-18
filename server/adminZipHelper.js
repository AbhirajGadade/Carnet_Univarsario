const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const archiver =
  require('archiver');


const ROOT_DIR =
  path.join(
    __dirname,
    '..'
  );


const configuredPhotosDir =
  String(
    process.env.UMA_PHOTOS_DIR ||
    'photo/photos'
  ).trim();


const PHOTOS_DIR =
  path.isAbsolute(
    configuredPhotosDir
  )
    ? configuredPhotosDir
    : path.join(
        ROOT_DIR,
        configuredPhotosDir
      );


function normalizeRecord(
  record
) {
  return {
    dni:
      String(
        record.dni ||
        ''
      ).trim(),

    codigo:
      record.code ||
      record.codigo ||
      '',

    nombre:
      record.name ||
      '',

    email:
      record.email ||
      '',

    facultad:
      record.facultad ||
      '',

    especialidad:
      record.carrera ||
      record.esp ||
      record.especialidad ||
      '',

    categoria:
      record.category ||
      record.categoria ||
      '',

    suneduStatus:
      record.suneduStatus ||
      'Pendiente',

    updatedAt:
      record.updatedAt ||
      null,

    createdAt:
      record.createdAt ||
      null,

    drive_file_id:
      record.drive_file_id ||
      null,

    drive_url:
      record.drive_url ||
      null,

    photoUrl:
      record.photoUrl ||
      null,

    filename:
      record.filename ||
      null,

    relative_path:
      record.relative_path ||
      null,

    issues:
      Array.isArray(
        record.issues
      )
        ? record.issues
        : [],
  };
}


function resolvePhotoPath(
  record
) {
  if (
    record.relative_path
  ) {
    const raw =
      String(
        record.relative_path
      );

    const explicitPath =
      path.isAbsolute(raw)
        ? raw
        : path.join(
            ROOT_DIR,
            raw.replace(
              /^[/\\]+/,
              ''
            )
          );

    if (
      fs.existsSync(
        explicitPath
      )
    ) {
      return explicitPath;
    }
  }


  if (record.dni) {
    const byDni =
      path.join(
        PHOTOS_DIR,
        'approved',
        `${record.dni}.jpg`
      );

    if (
      fs.existsSync(
        byDni
      )
    ) {
      return byDni;
    }
  }


  if (record.dni) {
    const approvedDir =
      path.join(
        PHOTOS_DIR,
        'approved'
      );

    try {
      const hit =
        fs
          .readdirSync(
            approvedDir
          )
          .find(
            (name) =>
              name.startsWith(
                String(
                  record.dni
                )
              )
          );

      if (hit) {
        return path.join(
          approvedDir,
          hit
        );
      }

    } catch (_) {
      // Folder may not exist.
    }
  }

  return null;
}


async function createAdminZip(
  records,
  options = {}
) {
  const cleaned =
    records
      .map(
        normalizeRecord
      )
      .filter(
        (record) =>
          record.dni
      );


  const total =
    cleaned.length;


  const outDir =
    options.outDir ||
    path.join(
      ROOT_DIR,
      'tmp_zips'
    );


  await fsp.mkdir(
    outDir,
    {
      recursive: true,
    }
  );


  const stamp =
    new Date()
      .toISOString()
      .replace(
        /[:.]/g,
        ''
      )
      .replace(
        'T',
        '_'
      )
      .slice(
        0,
        15
      );


  const fileName =
    `uma_sunedu_${stamp}.zip`;


  const zipPath =
    path.join(
      outDir,
      fileName
    );


  await new Promise(
    (
      resolve,
      reject
    ) => {

      const output =
        fs.createWriteStream(
          zipPath
        );


      const archive =
        archiver(
          'zip',
          {
            zlib: {
              level: 9,
            },
          }
        );


      output.on(
        'close',
        resolve
      );

      output.on(
        'end',
        resolve
      );


      archive.on(
        'warning',
        (error) =>
          console.warn(
            '[zip warning]',
            error
          )
      );


      archive.on(
        'error',
        reject
      );


      archive.pipe(
        output
      );


      cleaned.forEach(
        (record) => {

          const photoPath =
            resolvePhotoPath(
              record
            );


          if (!photoPath) {
            console.warn(
              '[zip] local approved photo not found for DNI:',
              record.dni
            );

            return;
          }


          const niceName =
            `${record.dni}_${record.codigo || 'NA'}.jpg`;


          archive.file(
            photoPath,
            {
              name:
                path.join(
                  'photos',
                  niceName
                ),
            }
          );
        }
      );


      cleaned.forEach(
        (record) => {

          archive.append(
            JSON.stringify(
              record,
              null,
              2
            ),
            {
              name:
                path.join(
                  'metadata',
                  `${record.dni}.json`
                ),
            }
          );
        }
      );


      archive.append(
        JSON.stringify(
          cleaned,
          null,
          2
        ),
        {
          name:
            'lote.json',
        }
      );


      archive.finalize();
    }
  );


  return {
    zipPath,
    total,
    fileName,
  };
}


module.exports = {
  createAdminZip,
};