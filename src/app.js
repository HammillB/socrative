/**
 * The application: one Hono app that runs unchanged on Node and on Cloudflare
 * Workers. It is handed a driver (see db.js) rather than opening a database
 * itself, which is what keeps it portable.
 *
 * Phase 1 covers the student side only -- join, answer, resume, submit. The
 * teacher dashboard is Phase 2; for now tests are set up by scripts/import.js.
 */

import { Hono } from "hono";
import * as db from "./db.js";

// ------------------------------------------------------- deterministic order

/**
 * A small seeded generator (mulberry32).
 *
 * The point is reproducibility, not cryptography: the same seed always yields
 * the same paper, so a student's exact test can be rebuilt months later from
 * the seed stored on their attempt.
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Choices that refer to one another cannot be safely reordered.
 *
 * "All of the above" is the obvious case and the one Socrative will happily
 * shuffle into nonsense. Detecting it costs nothing and prevents a question
 * that is wrong through no fault of the student.
 */
const SELF_REFERENTIAL = /\b(all|none|both)\b.*\b(above|these|answers)\b|\b(a|b|c|d)\s+and\s+(a|b|c|d)\b/i;

export function choicesAreShuffleSafe(choices) {
  return !choices.some((choice) => SELF_REFERENTIAL.test(choice.text));
}

/** Build one student's paper from the assessment and their seed. */
export function buildPaper(questions, seed, settings) {
  const random = seededRandom(seed);
  const ordered = settings.shuffle_questions ? shuffled(questions, random) : questions;

  return ordered.map((question) => ({
    ...question,
    choices:
      settings.shuffle_choices && choicesAreShuffleSafe(question.choices)
        ? shuffled(question.choices, random)
        : question.choices,
  }));
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// -------------------------------------------------------------------- routes

export function createApp({ getDriver, staticHandler }) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.set("sql", getDriver(c));
    await next();
  });

  const fail = (c, message, status = 400) => c.json({ error: message }, status);

  /**
   * Load the attempt named by a token, or explain why it cannot be used.
   * The body is passed in already parsed -- reading it twice in one request
   * is a subtle way to end up with an empty object on the second read.
   */
  async function requireAttempt(c, body) {
    const token = c.req.header("x-attempt-token") || body.token;
    if (!token) return { error: fail(c, "No attempt token supplied.") };

    const attempt = await db.findAttemptByToken(c.get("sql"), token);
    if (!attempt) return { error: fail(c, "That test session was not found.", 404) };
    if (attempt.status === "submitted") {
      return { error: fail(c, "This test has already been handed in.", 409) };
    }
    if (attempt.session_state === "closed") {
      return { error: fail(c, "Your teacher has closed this test.", 409) };
    }
    return { attempt };
  }

  /**
   * Assemble the paper for one attempt: the questions in this student's
   * order, plus every answer already recorded on the server.
   */
  async function paperFor(sql, { assessmentId, settingsJson, title, attempt, resumed }) {
    const settings = JSON.parse(settingsJson || "{}");
    const questions = await db.getAssessmentQuestions(sql, assessmentId);
    const answers = await db.getResponses(sql, attempt.id);
    return {
      token: attempt.token,
      title,
      resumed,
      questions: buildPaper(questions, attempt.seed, settings),
      answers: Object.fromEntries(answers.map((a) => [a.question_id, a.choice_id])),
    };
  }

  /**
   * Pick up an attempt already in progress.
   *
   * This is what a dead Chromebook comes back to. The answers come from the
   * server, not the browser, so a student can finish on a different machine
   * entirely -- which is the case that actually matters when a device fails
   * mid-test.
   */
  app.post("/api/resume", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { attempt, error } = await requireAttempt(c, body);
    if (error) return error;

    return c.json(await paperFor(c.get("sql"), {
      assessmentId: attempt.assessment_id,
      settingsJson: attempt.settings,
      title: attempt.title,
      attempt,
      resumed: true,
    }));
  });

  /**
   * Join a test, or pick up where you left off.
   *
   * Rejoining is the normal case, not an error: a dropped connection, a closed
   * lid or a reloaded tab all land here, and all of them should return the
   * same paper with the same answers already filled in.
   */
  app.post("/api/join", async (c) => {
    const sql = c.get("sql");
    const { code, studentNumber } = await c.req.json().catch(() => ({}));
    if (!code || !studentNumber) {
      return fail(c, "Enter both the class code and your student number.");
    }

    const session = await db.findSessionByCode(sql, code);
    if (!session) return fail(c, "That class code was not recognised.", 404);
    if (session.state === "closed") return fail(c, "That test is closed.", 409);

    const student = await db.findStudentByNumber(sql, session.teacher_id, studentNumber);
    if (!student) return fail(c, "That student number is not on this class roster.", 404);

    let attempt = await db.findAttempt(sql, session.id, student.id);
    let resumed = true;
    if (!attempt) {
      const seed = Math.floor(Math.random() * 2 ** 31);
      const token = randomToken();
      const id = await db.createAttempt(sql, {
        sessionId: session.id, studentId: student.id, seed, token,
      });
      attempt = { id, seed, token, status: "in_progress" };
      resumed = false;
    } else {
      await db.logEvent(sql, attempt.id, "resumed");
    }

    if (attempt.status === "submitted") {
      return fail(c, "You have already handed this test in.", 409);
    }

    return c.json(await paperFor(sql, {
      assessmentId: session.assessment_id,
      settingsJson: session.settings,
      title: session.title,
      attempt,
      resumed,
    }));
  });

  /** Save one answer. Called the instant a student picks a choice. */
  app.post("/api/answer", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { attempt, error } = await requireAttempt(c, body);
    if (error) return error;

    try {
      await db.saveResponse(c.get("sql"), attempt, {
        questionId: body.questionId,
        choiceId: body.choiceId,
        msSpent: body.msSpent ?? null,
      });
    } catch (err) {
      return fail(c, err.message);
    }
    // Deliberately no correct/incorrect in the reply: this is Open Navigation,
    // and telling the student would turn the test into a guessing game.
    return c.json({ saved: true });
  });

  app.post("/api/submit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { attempt, error } = await requireAttempt(c, body);
    if (error) return error;

    const sql = c.get("sql");
    await db.submitAttempt(sql, attempt.id);

    // The score is always recorded. Whether the student sees it is the
    // "Show Final Score" setting, and it is off by default.
    const settings = JSON.parse(attempt.settings || "{}");
    const score = await db.scoreAttempt(sql, attempt);
    return c.json({
      submitted: true,
      score: settings.show_final_score ? { ...score, showToStudent: true } : null,
    });
  });

  app.post("/api/event", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { attempt, error } = await requireAttempt(c, body);
    if (error) return error;
    await db.logEvent(c.get("sql"), attempt.id, String(body.kind || "unknown").slice(0, 32));
    return c.json({ logged: true });
  });

  // ---------------------------------------------------------------- teacher
  //
  // These carry the answer key, so they are reached only by a session's
  // unguessable dashboard token -- never by the join code a whole class
  // knows. Replaced by Google sign-in when that lands.

  app.get("/api/live/:token", async (c) => {
    const board = await db.getLiveBoard(c.get("sql"), c.req.param("token"));
    if (!board) return fail(c, "No such dashboard.", 404);
    return c.json(board);
  });

  app.post("/api/live/:token/state", async (c) => {
    const { state } = await c.req.json().catch(() => ({}));
    if (!["open", "paused", "closed"].includes(state)) {
      return fail(c, "State must be open, paused or closed.");
    }
    const ok = await db.setSessionState(c.get("sql"), c.req.param("token"), state);
    if (!ok) return fail(c, "No such dashboard.", 404);
    return c.json({ state });
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  if (staticHandler) app.get("*", staticHandler);

  return app;
}
