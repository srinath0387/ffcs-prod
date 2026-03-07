const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// Determine mode: PostgreSQL (production) or SQLite (local dev)
const USE_POSTGRES = !!process.env.DATABASE_URL;

let pool = null; // PostgreSQL pool
let sqliteDb = null; // SQLite db

// ============ PostgreSQL Setup ============
async function initPostgres() {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('.internal') ? false : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false),
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Create tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'faculty', 'student')),
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      regno TEXT DEFAULT '',
      year TEXT DEFAULT '',
      must_change_password BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS courses (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      department TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS course_faculty (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      faculty_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      max_seats INTEGER NOT NULL DEFAULT 30,
      enrolled_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(course_id, faculty_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS selections (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_faculty_id INTEGER NOT NULL REFERENCES course_faculty(id) ON DELETE CASCADE,
      selected_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(student_id, course_faculty_id)
    )
  `);

  // Create session table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")`);

  // Seed admin if needed
  const result = await pool.query('SELECT COUNT(*) as count FROM users');
  if (parseInt(result.rows[0].count) === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, role, name, email, must_change_password) VALUES ($1, $2, $3, $4, $5, $6)',
      ['admin', hash, 'admin', 'System Administrator', 'admin@ffcs.edu', false]
    );
    console.log('✅ Admin account created (admin / admin123)');
  }

  console.log('✅ PostgreSQL connected & initialized');
}

// ============ SQLite Setup ============
async function initSqlite() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const DB_PATH = path.join(__dirname, 'ffcs.db');

  if (fs.existsSync(DB_PATH)) {
    sqliteDb = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    sqliteDb = new SQL.Database();
  }

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','faculty','student')),
    name TEXT NOT NULL, email TEXT DEFAULT '', regno TEXT DEFAULT '', year TEXT DEFAULT '',
    must_change_password INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL, department TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS course_faculty (
    id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL,
    faculty_id INTEGER NOT NULL, max_seats INTEGER NOT NULL DEFAULT 30,
    enrolled_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
    FOREIGN KEY (faculty_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(course_id, faculty_id)
  )`);

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS selections (
    id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL,
    course_faculty_id INTEGER NOT NULL, selected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (course_faculty_id) REFERENCES course_faculty(id) ON DELETE CASCADE,
    UNIQUE(student_id, course_faculty_id)
  )`);

  // Check for must_change_password column (migration for existing DBs)
  try {
    sqliteDb.run('SELECT must_change_password FROM users LIMIT 1');
  } catch (e) {
    sqliteDb.run('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 1');
    saveSqlite();
  }

  const stmt = sqliteDb.prepare('SELECT COUNT(*) as count FROM users');
  stmt.step();
  const count = stmt.get()[0];
  stmt.free();

  if (count === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    sqliteDb.run('INSERT INTO users (username, password_hash, role, name, email, must_change_password) VALUES (?, ?, ?, ?, ?, ?)',
      ['admin', hash, 'admin', 'System Administrator', 'admin@ffcs.edu', 0]);
    console.log('✅ Admin account created (admin / admin123)');
  }

  saveSqlite();
  console.log('✅ SQLite initialized (local mode)');
}

function saveSqlite() {
  if (sqliteDb) {
    const DB_PATH = path.join(__dirname, 'ffcs.db');
    fs.writeFileSync(DB_PATH, Buffer.from(sqliteDb.export()));
  }
}

// ============ Unified Query Interface ============
// All functions return Promises with consistent row format

async function dbRun(sql, params = []) {
  if (USE_POSTGRES) {
    // Convert ? placeholders to $1, $2, etc.
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    await pool.query(pgSql, params);
  } else {
    sqliteDb.run(sql, params);
    saveSqlite();
  }
}

async function dbGet(sql, params = []) {
  if (USE_POSTGRES) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const result = await pool.query(pgSql, params);
    return result.rows[0] || null;
  } else {
    const stmt = sqliteDb.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      stmt.free();
      const row = {};
      cols.forEach((c, i) => row[c] = vals[i]);
      return row;
    }
    stmt.free();
    return null;
  }
}

async function dbAll(sql, params = []) {
  if (USE_POSTGRES) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const result = await pool.query(pgSql, params);
    return result.rows;
  } else {
    const results = [];
    const stmt = sqliteDb.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      const row = {};
      cols.forEach((c, i) => row[c] = vals[i]);
      results.push(row);
    }
    stmt.free();
    return results;
  }
}

async function dbLastInsertId() {
  if (USE_POSTGRES) {
    // For Postgres, we use RETURNING id in the query itself
    return null; // Handled differently
  } else {
    return (await dbGet('SELECT last_insert_rowid() as id')).id;
  }
}

// PostgreSQL-specific insert that returns the ID
async function dbInsert(sql, params = []) {
  if (USE_POSTGRES) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`) + ' RETURNING id';
    const result = await pool.query(pgSql, params);
    return result.rows[0].id;
  } else {
    sqliteDb.run(sql, params);
    saveSqlite();
    return (await dbGet('SELECT last_insert_rowid() as id')).id;
  }
}

async function initializeDatabase() {
  if (USE_POSTGRES) {
    await initPostgres();
  } else {
    await initSqlite();
  }
}

function getPool() { return pool; }
function isPostgres() { return USE_POSTGRES; }

module.exports = { initializeDatabase, dbRun, dbGet, dbAll, dbInsert, getPool, isPostgres };
