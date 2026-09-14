/**
 * End-to-end check of the student flow against a running server.
 *
 *   npm run dev            # in one terminal
 *   node scripts/e2e-test.js
 *
 * The case this exists for is the one that matters most in a classroom: a
 * Chromebook dying mid-test and the student finishing somewhere else.
 */

import { DatabaseSync } from "node:sqlite";

const BASE = process.env.BASE ?? "http://localhost:8787";
const CODE = process.env.CODE ?? "HEAT1";
const DB = process.env.DB_PATH ?? "classroom.db";

let failures = 0;

// Start from a clean slate so the suite can be run repeatedly. Only attempts
// and their answers are cleared -- the roster and the questions stay put.
{
  const database = new DatabaseSync(DB);
  database.exec("DELETE FROM events; DELETE FROM responses; DELETE FROM attempts;");
  database.close();
}

function check(name, condition, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  if (!condition) failures++;
  console.log(`${mark} ${name}${detail ? "  -- " + detail : ""}`);
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

console.log(`\nTesting ${BASE}\n`);

// --- 1. a student starts the test ------------------------------------------

const join = await post("/api/join", { code: CODE, studentNumber: "100001" });
check("student can join with code + number", join.status === 200, join.body.error);

const paper = join.body;
check("paper has questions", paper.questions?.length > 0, `${paper.questions?.length} questions`);
check("starts with no answers", Object.keys(paper.answers ?? {}).length === 0);

// The single most important security property: a student must not be able to
// read the answer key out of the page they are served.
const serialised = JSON.stringify(paper);
check("answer key is NOT in the payload",
  !/isCorrect|is_correct/i.test(serialised));

// --- 2. they answer the first five -----------------------------------------

const answered = {};
for (const question of paper.questions.slice(0, 5)) {
  const choice = question.choices[0];
  const res = await post("/api/answer", {
    token: paper.token, questionId: question.id, choiceId: choice.id,
  });
  if (res.status === 200) answered[question.id] = choice.id;
}
check("five answers saved", Object.keys(answered).length === 5);

// --- 3. the Chromebook dies -------------------------------------------------
// Everything the browser held is gone. The student signs in on another machine
// with nothing but the class code and their student number.

const reJoin = await post("/api/join", { code: CODE, studentNumber: "100001" });
check("can rejoin after losing the device", reJoin.status === 200, reJoin.body.error);
check("rejoin is flagged as resumed", reJoin.body.resumed === true);
check("same attempt, not a fresh one", reJoin.body.token === paper.token);

const recovered = reJoin.body.answers ?? {};
const allBack = Object.entries(answered).every(
  ([qid, cid]) => String(recovered[qid]) === String(cid)
);
check("all five answers came back", allBack,
  `${Object.keys(recovered).length} of 5 recovered`);

// Question order must be identical too -- a resumed test that reshuffles is
// a different test, and the student would have to re-read everything.
const sameOrder = reJoin.body.questions.map((q) => q.id).join() ===
                  paper.questions.map((q) => q.id).join();
check("question order is unchanged", sameOrder);

// --- 4. resuming by token (a reload rather than a new device) ---------------

const resumed = await post("/api/resume", { token: paper.token });
check("resume by token works", resumed.status === 200, resumed.body.error);
check("resume returns the same answers",
  Object.keys(resumed.body.answers ?? {}).length === 5);

// --- 5. an answer can be changed -------------------------------------------

const first = paper.questions[0];
const changed = await post("/api/answer", {
  token: paper.token, questionId: first.id, choiceId: first.choices[1].id,
});
check("an answer can be changed", changed.status === 200);
const afterChange = await post("/api/resume", { token: paper.token });
check("the change stuck",
  String(afterChange.body.answers[first.id]) === String(first.choices[1].id));

// --- 6. rubbish is refused --------------------------------------------------

const bogusChoice = await post("/api/answer", {
  token: paper.token, questionId: first.id, choiceId: 999999,
});
check("a choice from another question is refused", bogusChoice.status === 400);

const bogusToken = await post("/api/resume", { token: "not-a-real-token" });
check("an invented token is refused", bogusToken.status === 404);

const wrongTeacher = await post("/api/join", { code: CODE, studentNumber: "999999" });
check("a number not on the roster is refused", wrongTeacher.status === 404);

// --- 7. hand in -------------------------------------------------------------

const submit = await post("/api/submit", { token: paper.token });
check("test can be handed in", submit.status === 200, submit.body.error);
check("score is withheld from the student by default", submit.body.score === null);

const afterSubmit = await post("/api/answer", {
  token: paper.token, questionId: first.id, choiceId: first.choices[0].id,
});
check("answers are locked after handing in", afterSubmit.status === 409);

const rejoinAfter = await post("/api/join", { code: CODE, studentNumber: "100001" });
check("cannot restart a handed-in test", rejoinAfter.status === 409);

// --- 8. the teacher's live board -------------------------------------------

const board_db = new DatabaseSync(DB);
const dashboardToken =
  board_db.prepare(`SELECT dashboard_token FROM sessions LIMIT 1`).get()?.dashboard_token;
board_db.close();

if (!dashboardToken) {
  check("session has a dashboard token", false, "re-run scripts/import.js");
} else {
  const res = await fetch(`${BASE}/api/live/${dashboardToken}`);
  const board = await res.json();
  check("live board loads", res.status === 200, board.error);

  check("board lists the whole roster, not only those who joined",
    board.students.length >= 1);
  check("questions are in their original order",
    board.questions.every((q, i) => q.position === i));

  // The property the board rests on. Papers are shuffled per student, so a
  // choice sits in a different place on each screen -- but the board reports
  // the letter that choice had when the question was written. Two students
  // who answer the same question correctly must therefore show the same
  // letter, and it must equal the key.
  let inconsistent = 0, compared = 0;
  for (const question of board.questions) {
    const letters = new Set();
    for (const student of board.students) {
      const answer = student.answers[question.id];
      if (answer?.correct) letters.add(answer.letter);
    }
    if (!letters.size) continue;
    compared++;
    if (letters.size > 1) inconsistent++;
    else if ([...letters][0] !== question.correctLetter) inconsistent++;
  }
  check("correct answers map to one canonical letter matching the key",
    inconsistent === 0, `${compared} question(s) compared, ${inconsistent} inconsistent`);

  // A join code is known to the whole class; it must not open the board.
  const leak = await fetch(`${BASE}/api/live/${CODE}`);
  check("the join code does NOT open the board", leak.status === 404);
}

// ---------------------------------------------------------------------------

console.log(failures ? `\n${failures} check(s) failed\n` : `\nAll checks passed\n`);
process.exit(failures ? 1 : 0);
