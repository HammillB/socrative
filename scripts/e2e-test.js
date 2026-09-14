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
// Students join by ROOM name -- the name never changes, and the teacher
// decides what is running behind it.
const ROOM = process.env.ROOM ?? "INTSCIA3";        // running a sequential test
const OPEN_ROOM = process.env.OPEN_ROOM ?? "INTSCIA4";  // running an open one
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
//
// The two sessions it needs are also reopened, so running the suite does not
// depend on what was last done by hand in the launch screen.
{
  const database = new DatabaseSync(DB);
  database.exec("DELETE FROM events; DELETE FROM responses; DELETE FROM attempts;");

  // Reopen the most recent test in each room, so the suite does not depend
  // on what was last done by hand in the launch screen.
  const reopen = database.prepare(
    "UPDATE sessions SET state = 'open' " +
    " WHERE id = (SELECT s.id FROM sessions s" +
    "               JOIN sections sec ON sec.id = s.section_id" +
    "              WHERE LOWER(sec.name) = LOWER(?)" +
    "              ORDER BY s.created_at DESC LIMIT 1)");
  if (reopen.run(ROOM).changes + reopen.run(OPEN_ROOM).changes < 2) {
    [
      "",
      `This suite expects a test running in each of two rooms: ${ROOM}`,
      `(sequential) and ${OPEN_ROOM} (open). A room runs one at a time.`,
      "",
      "Set them up with:",
      "",
      `  node scripts/import.js --teacher demo@school.test`,
      `      --roster fixtures/roster-demo.csv --section ${ROOM}`,
      `      --quiz fixtures/heat_test.csv --mode sequential`,
      "",
      `  node scripts/import.js --teacher demo@school.test`,
      `      --roster fixtures/roster-demo.csv --section ${OPEN_ROOM}`,
      "",
      `  node scripts/launch.js --teacher demo@school.test --quiz 1`,
      `      --section ${OPEN_ROOM} --mode open`,
      "",
      "(all on one line each)",
      "",
    ].forEach((line) => console.error(line));
    process.exit(1);
  }
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

const join = await post("/api/join", { room: ROOM, studentNumber: "100001" });
check("student can join with room name + number", join.status === 200, join.body.error);

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
const shownChoices = state.question.choices;
const rightChoiceId = keyOf.get(firstQuestionId);

// Answer it deliberately WRONG, to exercise the feedback that matters.
const wrongChoice = shownChoices.find((ch) => ch.id !== rightChoiceId);

const answer1 = await post("/api/answer", {
  token: state.token, questionId: firstQuestionId, choiceId: wrongChoice.id,
});
check("an answer is accepted", answer1.status === 200, answer1.body.error);
check("it advances to question 2", answer1.body.number === 2);
check("a different question follows", answer1.body.question.id !== firstQuestionId);

// --- 2a. feedback on a wrong answer ----------------------------------------

const wrongFeedback = answer1.body.feedback;
check("feedback is returned", !!wrongFeedback);
check("a wrong answer is reported as incorrect", wrongFeedback.correct === false);
check("the correct answer is given", !!wrongFeedback.correctText);
check("an explanation is given", !!wrongFeedback.explanation);

// The letter must be the one THIS student saw. Choices are shuffled per
// student, so the position of the right answer differs between papers, and
// naming the canonical letter would point at the wrong row on their screen.
const expectedLetter = "ABCDEFGH"[shownChoices.findIndex((ch) => ch.id === rightChoiceId)];
check("the letter matches the student's own shuffled order",
  wrongFeedback.correctLetter === expectedLetter,
  `told ${wrongFeedback.correctLetter}, saw it at ${expectedLetter}`);

state = answer1.body;

// --- 2b. feedback on a right answer ----------------------------------------

const rightAnswer = await post("/api/answer", {
  token: state.token,
  questionId: state.question.id,
  choiceId: keyOf.get(state.question.id),
});
check("a right answer is reported as correct", rightAnswer.body.feedback.correct === true);
check("a student who was right is not told the answer they already gave",
  rightAnswer.body.feedback.correctText === null &&
  rightAnswer.body.feedback.correctLetter === null);

state = rightAnswer.body;

// --- 3. the lock ------------------------------------------------------------

const goBack = await post("/api/answer", {
  token: state.token, questionId: firstQuestionId, choiceId: wrongChoice.id,
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
check("refusals did not move the student", stillHere.body.number === 3);

// --- 4. the Chromebook dies -------------------------------------------------
// Everything the browser held is gone. The student signs in on another machine
// with nothing but the class code and their student number.

const reJoin = await post("/api/join", { room: ROOM, studentNumber: "100001" });
check("can rejoin after losing the device", reJoin.status === 200, reJoin.body.error);
check("resumes on the same question number", reJoin.body.number === 3);
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
  (await post("/api/join", { room: ROOM, studentNumber: "999999" })).status === 404);
check("an unknown room name is refused",
  (await post("/api/join", { room: "NOSUCHROOM", studentNumber: "100001" })).status === 404);

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
  token: state.token, questionId: firstQuestionId, choiceId: wrongChoice.id,
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

// --- 6b. open navigation ----------------------------------------------------
// A different set of rules entirely: move about freely, change answers, and
// hand in at the end -- but only once nothing is blank.

const openJoin = await post("/api/join", { room: OPEN_ROOM, studentNumber: "100002" });

if (openJoin.status !== 200) {
  check("a room is running an open-navigation test", false,
    `${openJoin.body.error} -- launch one into ${OPEN_ROOM} with --mode open`);
} else {
  let open = openJoin.body;
  check("open test reports its mode", open.delivery === "open");
  check("the whole paper is available to move through",
    Array.isArray(open.paper) && open.paper.length === open.total);
  check("open paper carries no answer key",
    !/isCorrect|is_correct/i.test(JSON.stringify(open)));
  check("nothing answered yet", Object.keys(open.answers).length === 0);

  // Out of order is fine here: answer the third question first.
  const third = open.paper[2];
  const a = await post("/api/answer", {
    token: open.token, questionId: third.id, choiceId: third.choices[0].id,
  });
  check("questions can be answered out of order", a.status === 200, a.body.error);
  check("no right/wrong is revealed in open mode", a.body.feedback === undefined);

  // And answers can be revised, which the sequential mode refuses outright.
  const changed = await post("/api/answer", {
    token: open.token, questionId: third.id, choiceId: third.choices[1].id,
  });
  check("an answer can be changed", changed.status === 200, changed.body.error);

  const afterChange = await post("/api/resume", { token: open.token });
  check("the change stuck",
    String(afterChange.body.answers[third.id]) === String(third.choices[1].id));
  check("changing does not add a second answer", afterChange.body.answered === 1);

  // Handing in with blanks is refused, and the refusal says which ones.
  const tooSoon = await post("/api/submit", { token: open.token });
  check("cannot hand in with questions unanswered", tooSoon.status === 409);
  check("the refusal lists which questions are blank",
    Array.isArray(tooSoon.body.unanswered) &&
    tooSoon.body.unanswered.length === open.total - 1);
  check("the blank list uses the numbers the student sees",
    !tooSoon.body.unanswered.includes(3) && tooSoon.body.unanswered[0] === 1);

  // Fill in the rest, then hand in.
  for (const question of open.paper) {
    if (String(afterChange.body.answers[question.id]) !== "undefined" &&
        afterChange.body.answers[question.id] != null) continue;
    await post("/api/answer", {
      token: open.token, questionId: question.id, choiceId: keyOf.get(question.id),
    });
  }

  const handedIn = await post("/api/submit", { token: open.token });
  check("hands in once everything is answered", handedIn.status === 200, handedIn.body.error);
  check("handing in reports the test finished", handedIn.body.finished === true);

  const afterHandIn = await post("/api/answer", {
    token: open.token, questionId: third.id, choiceId: third.choices[0].id,
  });
  check("nothing can be changed after handing in", afterHandIn.status === 409);
}

// --- 6c. the mode belongs to the session, not the quiz ----------------------
// HEAT1 and OPEN1 are the SAME questions launched twice with different rules.
// If delivery lived on the quiz they could not differ, and re-running a test
// in another mode would mean importing every question again.

{
  const modeDb = new DatabaseSync(DB);
  const sessions = modeDb.prepare(`
    SELECT s.assessment_id, s.settings, s.section_id
      FROM sessions s JOIN sections sec ON sec.id = s.section_id
     WHERE LOWER(sec.name) IN (LOWER(?), LOWER(?)) AND s.state <> 'closed'`)
    .all(ROOM, OPEN_ROOM);
  const questionCount = modeDb.prepare(`SELECT COUNT(*) AS n FROM questions`).get().n;
  const quizCount = modeDb.prepare(`SELECT COUNT(*) AS n FROM assessments`).get().n;
  modeDb.close();

  check("both sessions run the same quiz", sessions.length === 2 &&
    sessions[0].assessment_id === sessions[1].assessment_id);
  check("and they are in different rooms, since a room runs one at a time",
    sessions[0].section_id !== sessions[1].section_id);
  check("launching in a second mode did not duplicate the questions",
    quizCount === 1, `${quizCount} quiz(zes), ${questionCount} questions`);

  const modes = sessions.map((row) => JSON.parse(row.settings).delivery).sort();
  check("the two sessions carry different delivery modes",
    modes.join() === "open,sequential", modes.join(" / "));

  // What students are told is decided entirely by the session they joined.
  const seq = await post("/api/join", { room: ROOM, studentNumber: "100006" });
  const opn = await post("/api/join", { room: OPEN_ROOM, studentNumber: "100006" });
  check("the same student gets the mode the teacher launched",
    seq.body.delivery === "sequential" && opn.body.delivery === "open");
  check("students are given no choice of mode",
    !("modes" in seq.body) && !("modes" in opn.body));
}

// --- 6d. the teacher's launch console --------------------------------------

{
  const consoleDb = new DatabaseSync(DB);
  const consoleToken = consoleDb
    .prepare(`SELECT console_token FROM teachers WHERE email = ?`)
    .get("demo@school.test")?.console_token;
  consoleDb.close();

  if (!consoleToken) {
    check("teacher has a console link", false, "re-run scripts/init.js");
  } else {
    const res = await fetch(`${BASE}/api/teacher/${consoleToken}`);
    const console_ = await res.json();
    check("console loads", res.status === 200, console_.error);
    check("it offers exactly the modes the app supports",
      console_.modes.map((m) => m.id).sort().join() === "open,sequential");
    check("it lists quizzes to launch", console_.quizzes.length >= 1);
    check("it lists what is already running", Array.isArray(console_.sessions));

    check("an invented console link is refused",
      (await fetch(`${BASE}/api/teacher/not-a-real-token`)).status === 404);

    check("rooms report what is already open in them",
      console_.rooms.every((r) => "openSession" in r));

    const busy = console_.rooms.find((r) => r.openSession);
    check("a room already running a test says so", !!busy,
      busy ? `${busy.name}: ${busy.openSession.title}` : "none found");

    // A room runs one test at a time. Launching into a busy one is refused,
    // and the refusal points at what is already there.
    if (busy) {
      const clash = await post(`/api/teacher/${consoleToken}/launch`, {
        quizId: console_.quizzes[0].id, mode: "open", sectionId: busy.id,
      });
      check("cannot launch into a room that already has a test open",
        clash.status === 409, clash.body.error);
      check("the refusal names the test in the way",
        clash.body.openSession?.title === busy.openSession.title);
    }

    check("a launch must name a room",
      (await post(`/api/teacher/${consoleToken}/launch`, {
        quizId: console_.quizzes[0].id, mode: "open",
      })).status === 400);

    // Launching is where the mode is decided, so this is the important one.
    // It needs a free room, so make one.
    const freeRoomDb = new DatabaseSync(DB);
    const teacherId = freeRoomDb
      .prepare(`SELECT id FROM teachers WHERE email = ?`).get("demo@school.test").id;
    let spare = freeRoomDb
      .prepare(`SELECT id FROM sections WHERE teacher_id = ? AND name = ?`)
      .get(teacherId, "SPARE");
    if (!spare) {
      freeRoomDb.prepare(`INSERT INTO sections (teacher_id, name) VALUES (?, ?)`)
        .run(teacherId, "SPARE");
      spare = freeRoomDb
        .prepare(`SELECT id FROM sections WHERE teacher_id = ? AND name = ?`)
        .get(teacherId, "SPARE");
    }
    // Leave the spare room free for the next run.
    freeRoomDb.prepare(`UPDATE sessions SET state = 'closed' WHERE section_id = ?`)
      .run(spare.id);
    freeRoomDb.close();

    const launch = await post(`/api/teacher/${consoleToken}/launch`, {
      quizId: console_.quizzes[0].id,
      mode: "open",
      sectionId: spare.id,
      shuffleQuestions: true,
      shuffleChoices: true,
      showQuestionFeedback: true,     // asked for, but open mode cannot have it
      showFinalScore: true,
    });
    check("a test can be launched from the console", launch.status === 200, launch.body.error);
    check("the launched session uses the chosen mode",
      launch.body.settings.delivery === "open");
    check("feedback is refused for open navigation even when asked for",
      launch.body.settings.show_question_feedback === false);
    check("other settings are honoured", launch.body.settings.show_final_score === true);

    check("the launch names the room students will type", launch.body.room === "SPARE");

    // SPARE has no roster, so knowing the room name is not enough -- which is
    // the point: a test belongs to a room and its roster gates it.
    const stranger = await post("/api/join", { room: "SPARE", studentNumber: "100004" });
    check("a student not on that room's roster is refused", stranger.status === 404);
  }
}

// --- 7. the teacher's live board -------------------------------------------

const boardDb = new DatabaseSync(DB);
const dashboardToken = boardDb.prepare(`
  SELECT s.dashboard_token FROM sessions s
    JOIN sections sec ON sec.id = s.section_id
   WHERE LOWER(sec.name) = LOWER(?) AND s.state <> 'closed'
   ORDER BY s.created_at DESC LIMIT 1`).get(ROOM)?.dashboard_token;
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

  // Points are the same underlying data as percent, just unnormalised, and it
  // is easy for the two to quietly disagree. Check pointsEarned against an
  // independent recomputation from is_correct + each question's own points.
  check("the board reports a total point value for the test",
    typeof board.totalPoints === "number" && board.totalPoints > 0,
    `totalPoints=${board.totalPoints}`);

  const pointsOf = new Map(board.questions.map((q) => [q.id, q.points ?? 1]));
  const recomputedTotal = board.questions.reduce((sum, q) => sum + (q.points ?? 1), 0);
  check("totalPoints matches summing every question's own points",
    board.totalPoints === recomputedTotal,
    `board says ${board.totalPoints}, summed ${recomputedTotal}`);

  let pointsMismatch = 0;
  for (const student of board.students) {
    const earned = Object.entries(student.answers)
      .filter(([, a]) => a.correct)
      .reduce((sum, [qid]) => sum + (pointsOf.get(Number(qid)) ?? 1), 0);
    if (Math.abs(earned - student.pointsEarned) > 0.001) pointsMismatch++;
  }
  check("each student's pointsEarned matches recomputing from their answers",
    pointsMismatch === 0, `${pointsMismatch} student(s) disagreed`);

  // The room name is known to the whole class; it must not open the board.
  check("the room name does NOT open the board",
    (await fetch(`${BASE}/api/live/${ROOM}`)).status === 404);
}

// ---------------------------------------------------------------------------

console.log(failures ? `\n${failures} check(s) failed\n` : `\nAll checks passed\n`);
process.exit(failures ? 1 : 0);
