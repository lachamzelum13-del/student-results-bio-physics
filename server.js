const express = require('express');
const session = require('express-session');
const multer = require('multer');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Small .env loader for local development. Render supplies env vars directly.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const ANSWER_BUCKET = 'answer-sheets';

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL. Add your Supabase PostgreSQL connection string.');
  process.exit(1);
}

const useSsl = String(process.env.DATABASE_SSL || 'true').toLowerCase() !== 'false';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id BIGSERIAL PRIMARY KEY,
      admission_no TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS class TEXT');
  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS biology_marks NUMERIC');
  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS biology_status TEXT');
  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS physics_marks NUMERIC');
  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS physics_status TEXT');
  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS biology_answer_path TEXT');
  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS physics_answer_path TEXT');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_students_admission_no ON students(admission_no)');
}

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 }
});

const answerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only PDF, JPG and PNG files are allowed'));
    }
    cb(null, true);
  }
});

function requireAdmin(req, res, next) {
  if (req.session.admin) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function ensureStorageConfig() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    const err = new Error('Supabase Storage is not configured');
    err.statusCode = 500;
    throw err;
  }
}

function storageHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    ...extra
  };
}

function encodeStoragePath(objectPath) {
  return objectPath.split('/').map(encodeURIComponent).join('/');
}

async function uploadToStorage(objectPath, file) {
  ensureStorageConfig();
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(ANSWER_BUCKET)}/${encodeStoragePath(objectPath)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: storageHeaders({
      'Content-Type': file.mimetype,
      'x-upsert': 'true'
    }),
    body: file.buffer
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Storage upload failed: ${detail || response.status}`);
  }
}

async function deleteFromStorage(objectPath) {
  if (!objectPath || !SUPABASE_URL || !SUPABASE_SECRET_KEY) return;
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(ANSWER_BUCKET)}/${encodeStoragePath(objectPath)}`;
  try {
    await fetch(url, { method: 'DELETE', headers: storageHeaders() });
  } catch (_) {}
}

async function createSignedUrl(objectPath) {
  ensureStorageConfig();
  const url = `${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(ANSWER_BUCKET)}/${encodeStoragePath(objectPath)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: storageHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: 300 })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.signedURL) {
    throw new Error(data.message || data.error || 'Could not create answer-sheet link');
  }
  if (data.signedURL.startsWith('http')) {
  return data.signedURL;
}

if (data.signedURL.startsWith('/storage/v1/')) {
  return `${SUPABASE_URL}${data.signedURL}`;
}

return `${SUPABASE_URL}/storage/v1${data.signedURL.startsWith('/') ? '' : '/'}${data.signedURL}`;
}

function extensionFor(file) {
  if (file.mimetype === 'application/pdf') return 'pdf';
  if (file.mimetype === 'image/png') return 'png';
  return 'jpg';
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (_err) {
    res.status(503).json({ ok: false });
  }
});

app.get('/api/result/:admissionNo', async (req, res) => {
  try {
    const admissionNo = String(req.params.admissionNo || '').trim();
    const { rows } = await pool.query(`
      SELECT admission_no, name, class,
             biology_marks, biology_status,
             physics_marks, physics_status,
             biology_answer_path, physics_answer_path
      FROM students
      WHERE admission_no = $1
      LIMIT 1
    `, [admissionNo]);

    if (!rows[0]) return res.status(404).json({ error: 'Result not found' });
    const row = rows[0];
    return res.json({
      admission_no: row.admission_no,
      name: row.name,
      class: row.class,
      biology_marks: row.biology_marks,
      biology_status: row.biology_status,
      physics_marks: row.physics_marks,
      physics_status: row.physics_status,
      has_biology_answer: !!row.biology_answer_path,
      has_physics_answer: !!row.physics_answer_path
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/answer-sheet/:admissionNo/:subject', async (req, res) => {
  try {
    const admissionNo = String(req.params.admissionNo || '').trim();
    const subject = String(req.params.subject || '').toLowerCase();
    if (!['biology', 'physics'].includes(subject)) {
      return res.status(400).json({ error: 'Invalid subject' });
    }

    const column = subject === 'biology' ? 'biology_answer_path' : 'physics_answer_path';
    const { rows } = await pool.query(`SELECT ${column} AS object_path FROM students WHERE admission_no = $1 LIMIT 1`, [admissionNo]);
    if (!rows[0] || !rows[0].object_path) {
      return res.status(404).json({ error: 'Answer sheet not found' });
    }

    const url = await createSignedUrl(rows[0].object_path);
    return res.json({ url, expiresIn: 300 });
  } catch (err) {
    console.error(err);
    return res.status(err.statusCode || 500).json({ error: err.message || 'Could not open answer sheet' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/status', (req, res) => {
  res.json({ loggedIn: !!req.session.admin });
});

app.get('/api/admin/students', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT admission_no, name, class,
             biology_marks, biology_status,
             physics_marks, physics_status,
             biology_answer_path, physics_answer_path,
             updated_at
      FROM students
      ORDER BY admission_no
    `);
    return res.json(rows.map(row => ({
      ...row,
      has_biology_answer: !!row.biology_answer_path,
      has_physics_answer: !!row.physics_answer_path,
      biology_answer_path: undefined,
      physics_answer_path: undefined
    })));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/admin/students', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT biology_answer_path, physics_answer_path FROM students');
    for (const row of rows) {
      await deleteFromStorage(row.biology_answer_path);
      await deleteFromStorage(row.physics_answer_path);
    }
    const result = await pool.query('DELETE FROM students');
    return res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/admin/upload', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const get = (row, keys) => {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined && row[key] !== null) return row[key];
    }
    return '';
  };

  const normalize = (row) => ({
    admission_no: String(get(row, ['admission_no', 'AdmissionNo', 'Admission No', 'ကိုယ်ပိုင်နံပါတ်', 'ကျောင်းဝင်အမှတ်'])).trim(),
    name: String(get(row, ['name', 'Name', 'အမည်'])).trim(),
    class: String(get(row, ['class', 'Class', 'အတန်း'])).trim(),
    biology_marks: get(row, ['biology_marks', 'Biology Marks', 'Biology', 'biology', 'ဇီဝဗေဒအမှတ်']),
    biology_status: String(get(row, ['biology_status', 'Biology Status', 'Biology Result', 'ဇီဝဗေဒရလဒ်'])).trim(),
    physics_marks: get(row, ['physics_marks', 'Physics Marks', 'Physics', 'physics', 'ရူပဗေဒအမှတ်']),
    physics_status: String(get(row, ['physics_status', 'Physics Status', 'Physics Result', 'ရူပဗေဒရလဒ်'])).trim()
  });

  const parseMarks = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  };

  let client;
  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!data.length) throw new Error('Spreadsheet is empty');

    client = await pool.connect();
    await client.query('BEGIN');

    let imported = 0;
    let skipped = 0;

    for (const raw of data) {
      const row = normalize(raw);
      if (!row.admission_no || !row.name) {
        skipped++;
        continue;
      }

      const biologyMarks = parseMarks(row.biology_marks);
      const physicsMarks = parseMarks(row.physics_marks);
      if (Number.isNaN(biologyMarks) || Number.isNaN(physicsMarks)) {
        skipped++;
        continue;
      }

      await client.query(`
        INSERT INTO students (
          admission_no, name, class,
          biology_marks, biology_status,
          physics_marks, physics_status,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (admission_no) DO UPDATE SET
          name = EXCLUDED.name,
          class = EXCLUDED.class,
          biology_marks = EXCLUDED.biology_marks,
          biology_status = EXCLUDED.biology_status,
          physics_marks = EXCLUDED.physics_marks,
          physics_status = EXCLUDED.physics_status,
          updated_at = NOW()
      `, [
        row.admission_no, row.name, row.class,
        biologyMarks, row.biology_status,
        physicsMarks, row.physics_status
      ]);
      imported++;
    }

    await client.query('COMMIT');
    return res.json({ ok: true, imported, skipped });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error(err);
    return res.status(400).json({ error: err.message });
  } finally {
    if (client) client.release();
    try { fs.unlinkSync(req.file.path); } catch (_) {}
  }
});

app.post('/api/admin/answer-sheet/:admissionNo/:subject', requireAdmin, answerUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No answer sheet uploaded' });
    const admissionNo = String(req.params.admissionNo || '').trim();
    const subject = String(req.params.subject || '').toLowerCase();
    if (!['biology', 'physics'].includes(subject)) {
      return res.status(400).json({ error: 'Invalid subject' });
    }

    const column = subject === 'biology' ? 'biology_answer_path' : 'physics_answer_path';
    const { rows } = await pool.query(`SELECT ${column} AS old_path FROM students WHERE admission_no = $1 LIMIT 1`, [admissionNo]);
    if (!rows[0]) return res.status(404).json({ error: 'Student not found' });

    const safeAdmission = admissionNo.replace(/[^a-zA-Z0-9_-]/g, '_');
    const objectPath = `${safeAdmission}/${subject}-${Date.now()}.${extensionFor(req.file)}`;
    await uploadToStorage(objectPath, req.file);
    await pool.query(`UPDATE students SET ${column} = $1, updated_at = NOW() WHERE admission_no = $2`, [objectPath, admissionNo]);
    await deleteFromStorage(rows[0].old_path);

    return res.json({ ok: true, subject, admission_no: admissionNo });
  } catch (err) {
    console.error(err);
    return res.status(err.statusCode || 500).json({ error: err.message || 'Answer sheet upload failed' });
  }
});

app.delete('/api/admin/answer-sheet/:admissionNo/:subject', requireAdmin, async (req, res) => {
  try {
    const admissionNo = String(req.params.admissionNo || '').trim();
    const subject = String(req.params.subject || '').toLowerCase();
    if (!['biology', 'physics'].includes(subject)) return res.status(400).json({ error: 'Invalid subject' });
    const column = subject === 'biology' ? 'biology_answer_path' : 'physics_answer_path';
    const { rows } = await pool.query(`SELECT ${column} AS object_path FROM students WHERE admission_no = $1 LIMIT 1`, [admissionNo]);
    if (!rows[0]) return res.status(404).json({ error: 'Student not found' });
    await deleteFromStorage(rows[0].object_path);
    await pool.query(`UPDATE students SET ${column} = NULL, updated_at = NOW() WHERE admission_no = $1`, [admissionNo]);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Could not delete answer sheet' });
  }
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Student Results Site running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err.message);
    process.exit(1);
  });

async function shutdown() {
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
