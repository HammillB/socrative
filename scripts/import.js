/**
 * Load a roster and a quiz, then open a test session.
 *
 *   node scripts/import.js --teacher you@school.org \
 *        --roster "roster.csv" --section INTSCIA3 \
 *        --quiz "converted/Quiz_Heat Test.csv" --code HEAT1
 *
 * --roster expects Socrative's own roster export:
 *     First Name, Last Name, Student ID, Email
 *
 * --quiz expects the output of the PDF converter:
 *     #, Question Type, Question, Answer A..E, Correct, Review
 *
 * Rows the converter flagged for review are imported but listed at the end,
 * so nothing is silently accepted that a human has not looked at.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  nodeDriver, findTeacherByEmail, upsertSection, upsertStudent, enroll,
  createSession, importQuizRows,
} from "../src/db.js";
import { parseCsv, pickColumn as pick } from "../src/csv.js";
import { launchSettings, describeSettings, MODES } from "../src/delivery.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

// parseCsv/pick now live in src/csv.js, shared with the Rooms screen's
// browser-side roster upload -- see the import above.

// ---------------------------------------------------------------------------

const dbPath = arg("db", "classroom.db");
const email = arg("teacher");
if (!email) {
  console.error("--teacher is required (the email you used with scripts/init.js)");
  process.exit(1);
}

const database = new DatabaseSync(dbPath);
database.exec("PRAGMA journal_mode = WAL");
database.exec("PRAGMA foreign_keys = ON");
const sql = nodeDriver(database);

const teacher = await findTeacherByEmail(sql, email);
if (!teacher) {
  console.error(`No teacher with email ${email}. Run scripts/init.js first.`);
  process.exit(1);
}

// ------------------------------------------------------------------- roster

const rosterPath = arg("roster");
const sectionName = arg("section");
let sectionId = null;

if (rosterPath) {
  if (!sectionName) {
    console.error("--roster also needs --section (the room name, e.g. INTSCIA3)");
    process.exit(1);
  }
  sectionId = await upsertSection(sql, teacher.id, { name: sectionName });

  const rows = parseCsv(readFileSync(rosterPath, "utf8"));
  let count = 0;
  for (const row of rows) {
    const studentNumber = pick(row, "Student ID", "StudentID", "ID", "student_number");
    if (!studentNumber) continue;
    const studentId = await upsertStudent(sql, teacher.id, {
      studentNumber,
      firstName: pick(row, "First Name", "FirstName", "First"),
      lastName: pick(row, "Last Name", "LastName", "Last"),
    });
    await enroll(sql, studentId, sectionId);
    count++;
  }
  console.log(`Roster: ${count} students in ${sectionName}`);
}

// --------------------------------------------------------------------- quiz

const quizPath = arg("quiz");
const mode = (arg("mode", "sequential") || "").toLowerCase();
if (!MODES.includes(mode)) {
  console.error(`--mode must be one of: ${MODES.join(", ")}`);
  process.exit(1);
}
let assessmentId = null;

if (quizPath) {
  const rows = parseCsv(readFileSync(quizPath, "utf8"));
  const title = arg("title", basename(quizPath).replace(/\.csv$/i, "").replace(/^Quiz_/, ""));

  // Defaults for this quiz. What students actually get is decided when a
  // session is launched, below or later via scripts/launch.js.
  const result = await importQuizRows(sql, teacher.id, title, rows, launchSettings({ mode }));
  assessmentId = result.assessmentId;

  console.log(`Quiz: "${title}" -- ${result.imported} questions imported`);

  if (result.withExplanation < result.imported) {
    console.log(`
  ${result.imported - result.withExplanation} of ${result.imported} questions have no explanation.`);
    console.log(`  Students will be told the correct answer but not why. To fix,`);
    console.log(`  add an "Explanation" column to the spreadsheet and re-import.`);
  }

  if (result.skipped.length) {
    console.log(`\n  NOT IMPORTED (${result.skipped.length}):`);
    result.skipped.forEach((s) => console.log(`    ${s}`));
  }
  if (result.flagged.length) {
    console.log(`\n  Flagged by the converter -- check these against the PDF:`);
    result.flagged.forEach((s) => console.log(`    ${s}`));
  }
  if (result.unshuffleable.length) {
    console.log(`\n  Choices will NOT be shuffled (they refer to each other):`);
    console.log(`    ${result.unshuffleable.join(", ")}`);
  }
}

// ------------------------------------------------------------------ session

// --- launch it straight away, if a room was given ---------------------------

if (sectionName && assessmentId) {
  const settings = launchSettings({ mode });

  // The live board shows the answer key, so it gets its own unguessable link
  // rather than being reachable by anyone who knows the room.
  const dashboardToken = randomUUID().replace(/-/g, "");
  await createSession(sql, teacher.id, {
    assessmentId, sectionId, settings, dashboardToken,
  });

  const host = arg("host", "http://localhost:8787");
  console.log(`\nTest is open in ${sectionName}.\n`);
  for (const line of describeSettings(settings)) console.log(`  ${line}`);
  console.log(`\nStudents go to ${host} and enter:`);
  console.log(`    room name       ${sectionName}`);
  console.log(`    student number  (their own)`);
  console.log(`\nYour live board -- keep this link to yourself, it shows the answers:`);
  console.log(`    ${host}/live.html#${dashboardToken}`);
  console.log(`\nTo run these same questions again in a different mode:`);
  console.log(`    node scripts/launch.js --teacher ${email} --quiz ${assessmentId}` +
              ` --section ${sectionName} --mode open --close-open\n`);
}

database.close();
