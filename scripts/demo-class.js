/**
 * Drive a fake class through a test, for looking at the live board.
 *
 *   npm run dev              # in one terminal
 *   node scripts/demo-class.js
 *
 * Each student gets their own shuffled paper, so this also proves the thing
 * the board depends on: two students who answer the same question correctly
 * must show the SAME letter on the board, even though the choice sat in a
 * different place on each of their screens.
 */

import { DatabaseSync } from "node:sqlite";

const BASE = process.env.BASE ?? "http://localhost:8787";
const CODE = process.env.CODE ?? "HEAT1";
const DB = process.env.DB_PATH ?? "classroom.db";

// how many of the first questions each student answers, and how accurate
const PLAN = [
  { number: "100001", answers: 8, accuracy: 1.00 },
  { number: "100002", answers: 8, accuracy: 0.62 },
  { number: "100003", answers: 6, accuracy: 0.34 },
  { number: "100004", answers: 8, accuracy: 0.80 },
  { number: "100005", answers: 5, accuracy: 0.80 },
  { number: "100006", answers: 8, accuracy: 1.00, submit: true },
];

const db = new DatabaseSync(DB);
const correctChoice = new Map(
  db.prepare(`SELECT question_id, id FROM choices WHERE is_correct = 1`)
    .all().map((r) => [r.question_id, r.id])
);
db.close();

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

for (const person of PLAN) {
  const join = await post("/api/join", { code: CODE, studentNumber: person.number });
  if (join.status !== 200) {
    console.log(`  ${person.number}: could not join -- ${join.body.error}`);
    continue;
  }
  const paper = join.body;
  let right = 0;

  for (const question of paper.questions.slice(0, person.answers)) {
    const key = correctChoice.get(question.id);
    const wantCorrect = Math.random() < person.accuracy;
    const choice = wantCorrect
      ? question.choices.find((c) => c.id === key)
      : question.choices.find((c) => c.id !== key);
    if (!choice) continue;
    await post("/api/answer", {
      token: paper.token, questionId: question.id, choiceId: choice.id,
    });
    if (choice.id === key) right++;
  }

  if (person.submit) await post("/api/submit", { token: paper.token });
  console.log(
    `  ${person.number}: answered ${person.answers}, ${right} correct` +
    (person.submit ? ", handed in" : "")
  );
}

console.log(`\nLive board: ${BASE}/live.html#<dashboard token from the import output>`);
