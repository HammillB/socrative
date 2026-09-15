/**
 * Fill both demo rooms with a believable class taking a real test: a couple
 * of students finished with a strong score, one finished but weak, two still
 * mid-test at different points, and one who has not shown up yet -- so the
 * live board, every Score Display mode, and item analysis all have something
 * real to look at instead of an empty grid.
 *
 *   npm run dev              # in one terminal
 *   node scripts/demo-class.js
 *
 * Reads whatever quiz and delivery mode is CURRENTLY live in each room --
 * it does not launch anything itself -- so run scripts/launch.js first if a
 * room is not already open. Safe to re-run: it clears only the attempts it
 * is about to recreate, so the class looks the same every time rather than
 * piling more students onto whatever was there.
 */

import { DatabaseSync } from "node:sqlite";

const BASE = process.env.BASE ?? "http://localhost:8787";
const ROOMS = [process.env.ROOM ?? "INTSCIA3", process.env.OPEN_ROOM ?? "INTSCIA4"];
const DB = process.env.DB_PATH ?? "classroom.db";

// Six seats, six different pictures of "how a class is doing right now".
// accuracy is a per-question probability, not a fixed script, so item
// analysis sees the kind of variation a real class produces rather than an
// artificial all-right/all-wrong split.
const CLASS = [
  { number: "100001", through: 1.00, accuracy: 0.92, submit: true },   // finished, strong
  { number: "100002", through: 1.00, accuracy: 0.80, submit: true },   // finished, solid
  { number: "100003", through: 1.00, accuracy: 0.42, submit: true },   // finished, struggled
  { number: "100004", through: 0.64, accuracy: 0.70 },                 // well into it
  { number: "100005", through: 0.16, accuracy: 0.60 },                 // just started
  { number: "100006", through: 0 },                                    // has not joined
];

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Sequential: walk the CURRENT question forward, the only order allowed. */
async function runSequential(room, person, correctChoice, target) {
  let state = (await post("/api/join", { room, studentNumber: person.number })).body;
  let right = 0, answered = 0;

  while (!state.finished && answered < target) {
    const key = correctChoice.get(state.question.id);
    const wantCorrect = Math.random() < person.accuracy;
    const choice = wantCorrect
      ? state.question.choices.find((c) => c.id === key)
      : state.question.choices.find((c) => c.id !== key);
    const res = await post("/api/answer", {
      token: state.token, questionId: state.question.id, choiceId: choice.id,
    });
    if (choice.id === key) right++;
    answered++;
    state = res.body;
  }
  return { answered, right, total: state.total, finished: state.finished };
}

/** Open navigation: the paper arrives all at once; answer the first N. */
async function runOpen(room, person, correctChoice, target, wantSubmit) {
  let state = (await post("/api/join", { room, studentNumber: person.number })).body;
  let right = 0, answered = 0;

  for (const question of state.paper.slice(0, target)) {
    const key = correctChoice.get(question.id);
    const wantCorrect = Math.random() < person.accuracy;
    const choice = wantCorrect
      ? question.choices.find((c) => c.id === key)
      : question.choices.find((c) => c.id !== key);
    await post("/api/answer", { token: state.token, questionId: question.id, choiceId: choice.id });
    if (choice.id === key) right++;
    answered++;
  }

  let finished = false;
  if (wantSubmit && answered === state.paper.length) {
    finished = (await post("/api/submit", { token: state.token })).status === 200;
  }
  return { answered, right, total: state.paper.length, finished };
}

// --- clear just the seats this script is about to fill again ---------------

{
  const db = new DatabaseSync(DB);
  const sessionOf = db.prepare(`
    SELECT s.id FROM sessions s JOIN sections sec ON sec.id = s.section_id
     WHERE LOWER(sec.name) = LOWER(?) AND s.state <> 'closed'
     ORDER BY s.created_at DESC LIMIT 1`);
  for (const room of ROOMS) {
    const session = sessionOf.get(room);
    if (!session) continue;
    db.prepare(`DELETE FROM events WHERE attempt_id IN
      (SELECT id FROM attempts WHERE session_id = ?)`).run(session.id);
    db.prepare(`DELETE FROM responses WHERE attempt_id IN
      (SELECT id FROM attempts WHERE session_id = ?)`).run(session.id);
    db.prepare(`DELETE FROM attempts WHERE session_id = ?`).run(session.id);
  }
  db.close();
}

// --- fill each room ----------------------------------------------------------

for (const room of ROOMS) {
  console.log(`\n${room}`);

  const probe = await post("/api/join", { room, studentNumber: CLASS[0].number });
  if (probe.status !== 200) {
    console.log(`  no open test in this room -- ${probe.body.error}`);
    console.log(`  launch one first: node scripts/launch.js --teacher <you> --quiz <id> --section ${room} --mode sequential|open`);
    continue;
  }
  const delivery = probe.body.delivery;
  const total = delivery === "open" ? probe.body.paper.length : probe.body.total;

  const db = new DatabaseSync(DB);
  const correctChoice = new Map(
    db.prepare(`
      SELECT c.question_id, c.id
        FROM choices c
        JOIN assessment_items ai ON ai.question_id = c.question_id
       WHERE c.is_correct = 1
         AND ai.assessment_id = (
           SELECT s.assessment_id FROM sessions s JOIN sections sec ON sec.id = s.section_id
            WHERE LOWER(sec.name) = LOWER(?) AND s.state <> 'closed'
            ORDER BY s.created_at DESC LIMIT 1)`).all(room)
      .map((r) => [r.question_id, r.id])
  );
  db.close();

  for (const person of CLASS) {
    if (person.through === 0) {
      console.log(`  ${person.number}: not started`);
      continue;
    }
    const target = Math.max(1, Math.round(total * person.through));
    const run = delivery === "sequential"
      ? await runSequential(room, person, correctChoice, target)
      : await runOpen(room, person, correctChoice, target, person.submit);

    console.log(
      `  ${person.number}: answered ${run.answered} of ${run.total}, ${run.right} correct` +
      (run.finished ? ", handed in" : person.submit && !run.finished ? " (not enough answered to hand in)" : "")
    );
  }
}

console.log(`\nOpen the live board or the launch console to look around.`);
