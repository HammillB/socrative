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

if (email) {
  const sql = nodeDriver(database);
  const existing = await findTeacherByEmail(sql, email);
  if (existing) {
    console.log(`Teacher already present: ${email} (id ${existing.id})`);
  } else {
    const id = await createTeacher(sql, { email, displayName: name });
    console.log(`Teacher created: ${email} (id ${id})`);
  }
} else {
  console.log(`No --teacher given; add one with:  node scripts/init.js --teacher you@school.org`);
}

database.close();
