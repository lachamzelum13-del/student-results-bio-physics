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
  // Keep the existing table and migrate it safely so the current Supabase project can be reused.
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

function requireAdmin(req, res, next) {
  if (req.session.admin) return next();
  return res.status(401).json({ error: 'Unauthorized' });
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
             physics_marks, physics_status
      FROM students
      WHERE admission_no = $1
      LIMIT 1
    `, [admissionNo]);

    if (!rows[0]) return res.status(404).json({ error: 'Result not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error' });
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
             updated_at
      FROM students
      ORDER BY admission_no
    `);
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/admin/students', requireAdmin, async (_req, res) => {
  try {
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
      if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined && row[key] !== null) {
        return row[key];
      }
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
