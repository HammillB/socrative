/**
 * Launch a quiz you have already imported.
 *
 *   node scripts/launch.js --teacher you@school.org                  # list quizzes
 *   node scripts/launch.js --teacher you@school.org --quiz 3 \
 *        --section INTSCIA3 --code HEAT1 --mode sequential
 *
 * The mode, the shuffling and the score setting are chosen HERE, not when the
 * questions were imported -- so one quiz can run locked for a graded test and
 * open for a review the next day without importing it twice.
 *
 *   --mode sequential   one at a time, final, feedback after each answer
 *   --mode open         Back and Next, changeable, hand in at the end
 *
 * Also: --no-shuffle, --no-shuffle-answers, --show-score, --no-feedback
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  nodeDriver, findTeacherByEmail, findAssessment, listAssessments,
  upsertSection, createSession,
} from "../src/db.js";
import { launchSettings, describeSettings, MODES } from "../src/delivery.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const dbPath = arg("db", "classroom.db");
const email = arg("teacher");
if (!email) {
  console.error("--teacher is required");
  process.exit(1);
}

const database = new DatabaseSync(dbPath);
database.exec("PRAGMA foreign_keys = ON");
const sql = nodeDriver(database);

const teacher = await findTeacherByEmail(sql, email);
if (!teacher) {
  console.error(`No teacher with email ${email}. Run scripts/init.js first.`);
  process.exit(1);
}

// --- no quiz named: show what there is to launch ---------------------------

const quizId = arg("quiz");
if (!quizId) {
  const quizzes = await listAssessments(sql, teacher.id);
  if (!quizzes.length) {
    console.log("No quizzes yet. Import one with scripts/import.js.");
  } else {
    console.log(`\nQuizzes for ${email}:\n`);
    for (const quiz of quizzes) {
      console.log(`  ${String(quiz.id).padStart(3)}  ${quiz.title}` +
                  `  (${quiz.questions} questions)`);
    }
    console.log(`\nLaunch one with:`);
    console.log(`  node scripts/launch.js --teacher ${email} --quiz <id>` +
                ` --section <room> --code <CODE> --mode sequential|open\n`);
  }
  database.close();
  process.exit(0);
}

// --- launch -----------------------------------------------------------------

const assessment = await findAssessment(sql, teacher.id, Number(quizId));
if (!assessment) {
  console.error(`No quiz ${quizId} belonging to ${email}.`);
  process.exit(1);
}

const joinCode = arg("code");
if (!joinCode) {
  console.error("--code is required (the class code students type in)");
  process.exit(1);
}

const mode = (arg("mode", "sequential") || "").toLowerCase();
if (!MODES.includes(mode)) {
  console.error(`--mode must be one of: ${MODES.join(", ")}`);
  process.exit(1);
}

const sectionName = arg("section");
const sectionId = sectionName
  ? await upsertSection(sql, teacher.id, { name: sectionName })
  : null;

const settings = launchSettings({
  mode,
  shuffleQuestions: !flag("no-shuffle"),
  shuffleChoices: !flag("no-shuffle-answers"),
  showFinalScore: flag("show-score"),
  showQuestionFeedback: flag("no-feedback") ? false : null,
});

const dashboardToken = randomUUID().replace(/-/g, "");
try {
  await createSession(sql, teacher.id, {
    assessmentId: assessment.id,
    sectionId,
    joinCode,
    settings,
    dashboardToken,
  });
} catch (err) {
  console.error(/UNIQUE/i.test(err.message)
    ? `The class code ${joinCode.toUpperCase()} is already in use. Pick another.`
    : err.message);
  process.exit(1);
}

const host = arg("host", "http://localhost:8787");
console.log(`\n"${assessment.title}" is open.\n`);
for (const line of describeSettings(settings)) console.log(`  ${line}`);
console.log(`\nStudents go to ${host} and enter:`);
console.log(`    class code      ${joinCode.toUpperCase()}`);
console.log(`    student number  (their own)`);
console.log(`\nYour live board -- keep this link to yourself, it shows the answers:`);
console.log(`    ${host}/live.html#${dashboardToken}\n`);

database.close();
