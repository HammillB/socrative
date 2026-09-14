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
  createQuestion, createAssessment, addAssessmentItem, createSession,
} from "../src/db.js";
import { choicesAreShuffleSafe } from "../src/app.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** Minimal RFC-4180 CSV reader: handles quoted fields and embedded commas. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift().map((h) => h.replace(/^﻿/, "").trim());
  return rows
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/** Find a column by any of several likely spellings. */
function pick(row, ...names) {
  for (const name of names) {
    const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key && row[key] !== "") return row[key];
  }
  return null;
}

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
let assessmentId = null;

if (quizPath) {
  const rows = parseCsv(readFileSync(quizPath, "utf8"));
  const title = arg("title", basename(quizPath).replace(/\.csv$/i, "").replace(/^Quiz_/, ""));

  assessmentId = await createAssessment(sql, teacher.id, {
    title,
    settings: { shuffle_questions: true, shuffle_choices: true, show_final_score: false },
  });

  const flagged = [], unshuffleable = [], skipped = [];
  let position = 0;

  for (const row of rows) {
    const stem = pick(row, "Question");
    const correct = (pick(row, "Correct") || "").trim().toUpperCase();
    const review = pick(row, "Review");

    const choices = [];
    for (const letter of "ABCDEFGH") {
      const text = pick(row, `Answer ${letter}`);
      if (text) choices.push({ text, isCorrect: letter === correct });
    }

    const number = pick(row, "#") || String(position + 1);
    if (!stem || choices.length < 2) { skipped.push(`Q${number}: no stem or too few choices`); continue; }
    if (!correct || !choices.some((c) => c.isCorrect)) {
      skipped.push(`Q${number}: no correct answer marked -- not imported`);
      continue;
    }

    const questionId = await createQuestion(sql, teacher.id, { stem, choices });
    await addAssessmentItem(sql, teacher.id, assessmentId, questionId, position++);

    if (review) flagged.push(`Q${number}: ${review}`);
    if (!choicesAreShuffleSafe(choices)) unshuffleable.push(`Q${number}`);
  }

  console.log(`Quiz: "${title}" -- ${position} questions imported`);

  if (skipped.length) {
    console.log(`\n  NOT IMPORTED (${skipped.length}):`);
    skipped.forEach((s) => console.log(`    ${s}`));
  }
  if (flagged.length) {
    console.log(`\n  Flagged by the converter -- check these against the PDF:`);
    flagged.forEach((s) => console.log(`    ${s}`));
  }
  if (unshuffleable.length) {
    console.log(`\n  Choices will NOT be shuffled (they refer to each other):`);
    console.log(`    ${unshuffleable.join(", ")}`);
  }
}

// ------------------------------------------------------------------ session

const joinCode = arg("code");
if (joinCode && assessmentId) {
  const sessionId = await createSession(sql, teacher.id, { assessmentId, sectionId, joinCode });

  // The live board shows the answer key, so it gets its own unguessable link
  // rather than being reachable by the join code the whole class knows.
  const dashboardToken = randomUUID().replace(/-/g, "");
  database
    .prepare(`UPDATE sessions SET dashboard_token = ? WHERE id = ?`)
    .run(dashboardToken, sessionId);

  const host = arg("host", "http://localhost:8787");
  console.log(`\nTest is open. Students go to ${host} and enter:`);
  console.log(`    class code      ${joinCode.toUpperCase()}`);
  console.log(`    student number  (their own)`);
  console.log(`\nYour live board -- keep this link to yourself, it shows the answers:`);
  console.log(`    ${host}/live.html#${dashboardToken}`);
}

database.close();
