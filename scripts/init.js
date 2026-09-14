/**
 * Create the database and apply the schema.
 *
 *   node scripts/init.js [--db classroom.db] [--teacher you@school.org] [--name "B Hammill"]
 *
 * Safe to run again: the schema uses CREATE TABLE IF NOT EXISTS and the
 * teacher is only added if that email is not already present.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { nodeDriver, findTeacherByEmail, createTeacher } from "../src/db.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const dbPath = arg("db", "classroom.db");
const email = arg("teacher");
const name = arg("name", email);

const database = new DatabaseSync(dbPath);
database.exec("PRAGMA journal_mode = WAL");
database.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
console.log(`Schema applied to ${dbPath}`);

// Small forward migrations, so an existing database is never thrown away.
const columns = database.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name);
if (!columns.includes("dashboard_token")) {
  database.exec(`ALTER TABLE sessions ADD COLUMN dashboard_token TEXT`);
  console.log("Migrated: sessions.dashboard_token added");
}
if (!columns.includes("settings")) {
  database.exec(`ALTER TABLE sessions ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'`);
  // Existing sessions inherit whatever their quiz was set to, so nothing
  // already running changes behaviour.
  database.exec(`
    UPDATE sessions SET settings =
      COALESCE((SELECT a.settings FROM assessments a WHERE a.id = sessions.assessment_id), '{}')
    WHERE settings = '{}'`);
  console.log("Migrated: sessions.settings added, back-filled from each quiz");
}

if (columns.includes("join_code")) {
  // Students now type the room name, so per-test codes are gone. SQLite
  // cannot drop a column carrying a UNIQUE constraint, so the table is
  // rebuilt and the rows carried across.
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec(`
    CREATE TABLE sessions_rebuilt (
      id              INTEGER PRIMARY KEY,
      teacher_id      INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      assessment_id   INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      section_id      INTEGER REFERENCES sections(id) ON DELETE SET NULL,
      dashboard_token TEXT UNIQUE,
      settings        TEXT NOT NULL DEFAULT '{}',
      position        INTEGER NOT NULL DEFAULT 0,
      state           TEXT NOT NULL DEFAULT 'open',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO sessions_rebuilt
      (id, teacher_id, assessment_id, section_id, dashboard_token, settings, state, created_at)
    SELECT id, teacher_id, assessment_id, section_id, dashboard_token, settings, state, created_at
      FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_rebuilt RENAME TO sessions;
  `);
  database.exec("PRAGMA foreign_keys = ON");
  console.log("Migrated: sessions.join_code removed -- students join by room name");
}

const quizColumns = database.prepare(`PRAGMA table_info(assessments)`).all().map((c) => c.name);
if (!quizColumns.includes("updated_at")) {
  database.exec(`ALTER TABLE assessments ADD COLUMN updated_at TEXT`);
  database.exec(`UPDATE assessments SET updated_at = created_at WHERE updated_at IS NULL`);
  console.log("Migrated: assessments.updated_at added");
}

// Room names became globally unique when students started typing them.
const roomIndex = database.prepare(`PRAGMA index_info('idx_sections_name')`).all();
if (roomIndex.length > 1) {
  database.exec(`DROP INDEX idx_sections_name`);
  database.exec(`CREATE UNIQUE INDEX idx_sections_name ON sections(LOWER(name))`);
  console.log("Migrated: room names are now unique across the whole install");
}

const teacherColumns = database.prepare(`PRAGMA table_info(teachers)`).all().map((c) => c.name);
if (!teacherColumns.includes("console_token")) {
  database.exec(`ALTER TABLE teachers ADD COLUMN console_token TEXT`);
  console.log("Migrated: teachers.console_token added");
}

if (email) {
  const sql = nodeDriver(database);
  const existing = await findTeacherByEmail(sql, email);
  let id;
  if (existing) {
    id = existing.id;
    console.log(`Teacher already present: ${email} (id ${id})`);
  } else {
    id = await createTeacher(sql, { email, displayName: name });
    console.log(`Teacher created: ${email} (id ${id})`);
  }

  // Interim stand-in for signing in, exactly like the live board's link.
  // Replaced by Google sign-in; until then this link IS the credential.
  let row = database.prepare(`SELECT console_token FROM teachers WHERE id = ?`).get(id);
  if (!row.console_token) {
    const token = randomUUID().replace(/-/g, "");
    database.prepare(`UPDATE teachers SET console_token = ? WHERE id = ?`).run(token, id);
    row = { console_token: token };
  }
  console.log(`\nYour teacher console -- keep this link to yourself:`);
  console.log(`    http://localhost:8787/launch.html#${row.console_token}\n`);
} else {
  console.log(`No --teacher given; add one with:  node scripts/init.js --teacher you@school.org`);
}

database.close();
