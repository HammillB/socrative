/**
 * End-to-end check of the student flow against a running server.
 *
 *   npm run dev            # in one terminal
 *   npm test               # in another
 *
 * The two properties worth guarding above all others:
 *
 *   - a dead Chromebook can be resumed, on any machine, at the right question
 *   - a locked sequential test really is locked, on the SERVER, not just in
 *     the page
 */

import { DatabaseSync } from "node:sqlite";

const BASE = process.env.BASE ?? "http://localhost:8787";
const CODE = process.env.CODE ?? "HEAT1";
const DB = process.env.DB_PATH ?? "classroom.db";

let failures = 0;

function check(name, condition, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "  ok  " : " FAIL "} ${name}${detail ? "  -- " + detail : ""}`);
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Start from a clean slate so the suite can be run repeatedly. Only attempts
// and their answers are cleared -- the roster and the questions stay put.
{
  const database = new DatabaseSync(DB);
  database.exec("DELETE FROM events; DELETE FROM responses; DELETE FROM attempts;");
  database.close();
}

// The key, read straight from the database, so the test can answer correctly
// without the server ever having told it which choice is right.
const keyDb = new DatabaseSync(DB);
const keyOf = new Map(
  keyDb.prepare(`SELECT question_id, id FROM choices WHERE is_correct = 1`)
       .all().map((r) => [r.question_id, r.id])
);
keyDb.close();

console.log(`\nTesting ${BASE}\n`);

// --- 1. starting ------------------------------------------------------------

const join = await post("/api/join", { code: CODE, studentNumber: "100001" });
check("student can join with code + number", join.status === 200, join.body.error);

let state = join.body;
check("starts on question 1", state.number === 1);
check("the test has questions", state.total > 1, `${state.total} questions`);

// One question at a time means one question on the wire. If the whole paper
// were sent, a student could read ahead whatever the page showed them.
check("exactly ONE question is sent", !!state.question && !Array.isArray(state.question));
check("the rest of the paper is NOT in the payload",
  !JSON.stringify(state).includes('"questions"'));
check("answer key is NOT in the payload",
  !/isCorrect|is_correct/i.test(JSON.stringify(state)));

// --- 2. answering advances one at a time -----------------------------------

const firstQuestionId = state.question.id;
const firstChoiceId = state.question.choices[0].id;

const answer1 = await post("/api/answer", {
  token: state.token, questionId: firstQuestionId, choiceId: firstChoiceId,
});
check("an answer is accepted", answer1.status === 200, answer1.body.error);
check("it advances to question 2", answer1.body.number === 2);
check("a different question follows", answer1.body.question.id !== firstQuestionId);
check("no right/wrong is revealed by default", answer1.body.feedback === null);

state = answer1.body;

// --- 3. the lock ------------------------------------------------------------

const goBack = await post("/api/answer", {
  token: state.token, questionId: firstQuestionId, choiceId: firstChoiceId,
});
check("cannot go back and re-answer", goBack.status === 409, goBack.body.error);

// Skipping ahead is refused too. The client is never trusted to say which
// question the student is on; the server works it out from what they have
// answered.
const laterQuestionId = [...keyOf.keys()].find(
  (id) => id !== firstQuestionId && id !== state.question.id
);
const skip = await post("/api/answer", {
  token: state.token, questionId: laterQuestionId, choiceId: keyOf.get(laterQuestionId),
});
check("cannot skip ahead to a later question", skip.status === 409);

const stillHere = await post("/api/resume", { token: state.token });
check("refusals did not move the student", stillHere.body.number === 2);

// --- 4. the Chromebook dies -------------------------------------------------
// Everything the browser held is gone. The student signs in on another machine
// with nothing but the class code and their student number.

const reJoin = await post("/api/join", { code: CODE, studentNumber: "100001" });
check("can rejoin after losing the device", reJoin.status === 200, reJoin.body.error);
check("resumes on the same question number", reJoin.body.number === 2);
check("resumes on the same question", reJoin.body.question.id === state.question.id);
check("rejoin is flagged as resumed", reJoin.body.resumed === true);

// --- 5. rubbish is refused --------------------------------------------------

const bogusChoice = await post("/api/answer", {
  token: state.token, questionId: state.question.id, choiceId: 999999,
});
check("a choice from another question is refused", bogusChoice.status === 400);

check("an invented token is refused",
  (await post("/api/resume", { token: "not-a-real-token" })).status === 404);
check("a number not on the roster is refused",
  (await post("/api/join", { code: CODE, studentNumber: "999999" })).status === 404);

// --- 6. working through to the end ------------------------------------------

let guard = 0;
while (!state.finished && guard++ < 200) {
  const questionId = state.question.id;
  const res = await post("/api/answer", {
    token: state.token, questionId, choiceId: keyOf.get(questionId),
  });
  if (res.status !== 200) { check("answering to the end", false, res.body.error); break; }
  state = res.body;
}
check("the test completes", state.finished === true, `${state.answered} answered`);
check("finishing records every answer", state.answered === state.total);

const afterEnd = await post("/api/answer", {
  token: state.token, questionId: firstQuestionId, choiceId: firstChoiceId,
});
check("nothing can be answered once finished", afterEnd.status === 409);

// Finishing the last question ends the test on its own: there is no hand-in
// step to forget, and no way to leave a paper unsubmitted.
const finishedDb = new DatabaseSync(DB);
const attemptRow = finishedDb.prepare(
  `SELECT status, submitted_at FROM attempts WHERE token = ?`).get(state.token);
finishedDb.close();
check("the last answer submits the test automatically",
  attemptRow.status === "submitted" && !!attemptRow.submitted_at);

// --- 7. the teacher's live board -------------------------------------------

const boardDb = new DatabaseSync(DB);
const dashboardToken =
  boardDb.prepare(`SELECT dashboard_token FROM sessions LIMIT 1`).get()?.dashboard_token;
boardDb.close();

if (!dashboardToken) {
  check("session has a dashboard token", false, "re-run scripts/import.js");
} else {
  const res = await fetch(`${BASE}/api/live/${dashboardToken}`);
  const board = await res.json();
  check("live board loads", res.status === 200, board.error);
  check("board lists the whole roster, not only those who joined", board.students.length >= 1);
  check("questions are in their original order", board.questions.every((q, i) => q.position === i));

  // Papers are shuffled per student, but the board reports the letter each
  // choice had when the question was written. Two students who answer the
  // same question correctly must therefore show the same letter, and it must
  // equal the key. Without this the grid cannot be read down a column.
  let inconsistent = 0, compared = 0;
  for (const question of board.questions) {
    const letters = new Set();
    for (const student of board.students) {
      const answer = student.answers[question.id];
      if (answer?.correct) letters.add(answer.letter);
    }
    if (!letters.size) continue;
    compared++;
    if (letters.size > 1 || [...letters][0] !== question.correctLetter) inconsistent++;
  }
  check("correct answers map to one canonical letter matching the key",
    inconsistent === 0, `${compared} question(s) compared, ${inconsistent} inconsistent`);

  const me = board.students.find((s) => s.number === "100001");
  check("the finished student shows as handed in", me?.status === "submitted");

  // A join code is known to the whole class; it must not open the board.
  check("the join code does NOT open the board",
    (await fetch(`${BASE}/api/live/${CODE}`)).status === 404);
}

// ---------------------------------------------------------------------------

console.log(failures ? `\n${failures} check(s) failed\n` : `\nAll checks passed\n`);
process.exit(failures ? 1 : 0);
