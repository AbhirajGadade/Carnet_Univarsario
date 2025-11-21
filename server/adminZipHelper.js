// server/adminZipHelper.js
// Helper to build SUNEDU ZIP packages with rich JSON metadata.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const archiver = require('archiver');

const PHOTOS_DIR = process.env.UMA_PHOTOS_DIR || path.join(__dirname, '..', 'photos');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'student-photos';

/**
 * Normalise a submission record coming from /api/admin/submissions
 */
function normalizeRecord(r) {
  const n = {
    dni: String(r.dni || '').trim(),
    codigo: r.code || r.codigo || '',
    nombre: r.name || '',
    email: r.email || '',
    especialidad: r.esp || r.especialidad || '',
    categoria: r.category || r.categoria || '',
    suneduStatus: r.suneduStatus || 'Pendiente',
    updatedAt: r.updatedAt || null,
    createdAt: r.createdAt || null,
    photoUrl: r.photoUrl || null,
    filename: r.filename || null,
    relative_path: r.relative_path || null,
    issues: Array.isArray(r.issues) ? r.issues : [],
    data_url: r.data_url || null,
    supabase_url: r.supabase_url || null,
  };

  // If supabase_url wasn't stored but we know dni, guess it
  if (!n.supabase_url && SUPABASE_URL && n.dni) {
    n.supabase_url = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/approved/${n.dni}.jpg`;
  }

  return n;
}

/**
 * Decide which file path to use for the photo on disk
 */
function resolvePhotoPath(rec) {
  // 1) explicit relative_path coming from validator_api
  if (rec.relative_path) {
    const rel = String(rec.relative_path).replace(/^[/\\]+/, '');
    const p = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
    if (fs.existsSync(p)) return p;
  }

  // 2) local /photos/... path from photoUrl
  if (rec.photoUrl && rec.photoUrl.startsWith('/photos/')) {
    const p = path.join(PHOTOS_DIR, rec.photoUrl.replace('/photos/', ''));
    if (fs.existsSync(p)) return p;
  }

  return null;
}

/**
 * Create ZIP with:
 *  - photos/<dni>_<codigo>.jpg
 *  - metadata/<dni>.json (one file per student)
 *  - lote.json (array with all records)
 *
 * @param {Array<object>} records - approved submissions
 * @param {object} [opts]
 * @returns {Promise<{zipPath: string, total: number, fileName: string}>}
 */
async function createAdminZip(records, opts = {}) {
  const cleaned = records
    .map(normalizeRecord)
    .filter(r => r.dni);

  const total = cleaned.length;

  const outDir = opts.outDir || path.join(__dirname, '..', 'tmp_zips');
  await fsp.mkdir(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
  const fileName = `uma_sunedu_${stamp}.zip`;
  const zipPath = path.join(outDir, fileName);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('end', resolve);
    archive.on('warning', err => {
      console.warn('[zip warning]', err);
    });
    archive.on('error', reject);

    archive.pipe(output);

    // 1) Photos
    cleaned.forEach(rec => {
      const photoPath = resolvePhotoPath(rec);
      if (!photoPath) return;

      const niceName = `${rec.dni}_${rec.codigo || 'NA'}.jpg`;
      archive.file(photoPath, { name: path.join('photos', niceName) });
    });

    // 2) Per-student JSON
    cleaned.forEach(rec => {
      const metaName = `${rec.dni}.json`;
      archive.append(JSON.stringify(rec, null, 2), {
        name: path.join('metadata', metaName),
      });
    });

    // 3) Global list
    archive.append(JSON.stringify(cleaned, null, 2), { name: 'lote.json' });

    archive.finalize();
  });

  return { zipPath, total, fileName };
}

module.exports = {
  createAdminZip,
};
