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
   * Where this student currently stands.
   *
   * Only ONE question is ever returned. In a locked sequential test the whole
   * paper must not be in the browser: a student who can read the payload can
   * read ahead, and the point of the mode is that they cannot.
   *
   * The current index is simply how many questions they have answered, so
   * there is no cursor to drift out of step with the answers themselves.
   */
  async function stateFor(sql, { attempt, assessmentId, settingsJson, title }) {
    const settings = JSON.parse(settingsJson || "{}");
    const ordered = buildPaper(
      await db.getAssessmentQuestions(sql, assessmentId),
      attempt.seed,
      settings
    );
    const answered = await db.countResponses(sql, attempt.id);
    const current = ordered[answered] ?? null;

    return {
      token: attempt.token,
      title,
      total: ordered.length,
      number: answered + 1,          // what the student sees: "Question 7 of 25"
      answered,
      finished: answered >= ordered.length,
      question: current && {
        id: current.id,
        stem: current.stem,
        media: current.media,
        points: current.points,
        choices: current.choices,    // no isCorrect: see getAssessmentQuestions
      },
    };
  }

  /** Everything stateFor needs, gathered from an attempt row. */
  const contextOf = (attempt) => ({
    attempt,
    assessmentId: attempt.assessment_id,
    settingsJson: attempt.settings,
    title: attempt.title,
  });

  /**
   * Pick up an attempt already in progress.
   *
   * This is what a dead Chromebook comes back to, and what a reload hits. The
   * position is held by the server, so the student resumes on the question
   * they had reached -- on any machine, with nothing carried over from the old
   * one.
   */
  app.post("/api/resume", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { attempt, error } = await requireAttempt(c, body);
    if (error) return error;
    return c.json(await stateFor(c.get("sql"), contextOf(attempt)));
  });

  /** Join a test, or pick up where you left off. */
  app.post("/api/join", async (c) => {
    const sql = c.get("sql");
    const { code, studentNumber } = await c.req.json().catch(() => ({}));
    if (!code || !studentNumber) {
      return fail(c, "Enter both the class code and your student number.");
    }

    const session = await db.findSessionByCode(sql, code);
    if (!session) return fail(c, "That class code was not recognised.", 404);
    if (session.state === "closed") return fail(c, "That test is closed.", 409);
    if (session.state === "paused") return fail(c, "Your teacher has paused the test.", 409);

    const student = await db.findStudentByNumber(sql, session.teacher_id, studentNumber);
    if (!student) return fail(c, "That student number is not on this class roster.", 404);

    let attempt = await db.findAttempt(sql, session.id, student.id);
    let resumed = true;
    if (!attempt) {
      const token = randomToken();
      await db.createAttempt(sql, {
        sessionId: session.id,
        studentId: student.id,
        seed: Math.floor(Math.random() * 2 ** 31),
        token,
      });
      attempt = await db.findAttemptByToken(sql, token);
      resumed = false;
    } else {
      if (attempt.status === "submitted") {
        return fail(c, "You have already finished this test.", 409);
      }
      await db.logEvent(sql, attempt.id, "resumed");
      attempt = await db.findAttemptByToken(sql, attempt.token);
    }

    const state = await stateFor(sql, {
      attempt,
      assessmentId: session.assessment_id,
      settingsJson: session.settings,
      title: session.title,
    });
    return c.json({ ...state, resumed });
  });

  /**
   * Answer the current question and move on.
   *
   * The answer is final. The server checks that the question being answered is
   * genuinely the one the student is on, so neither skipping ahead nor going
   * back is possible whatever the page is persuaded to send.
   */
  app.post("/api/answer", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { attempt, error } = await requireAttempt(c, body);
    if (error) return error;

    const sql = c.get("sql");
    const before = await stateFor(sql, contextOf(attempt));

    if (before.finished) return fail(c, "You have answered every question.", 409);
    if (!body.questionId || body.questionId !== before.question.id) {
      return fail(c, "That is not the question you are on.", 409);
    }

    let graded;
    try {
      graded = await db.saveResponse(sql, attempt, {
        questionId: body.questionId,
        choiceId: body.choiceId,
        msSpent: body.msSpent ?? null,
        final: true,
      });
    } catch (err) {
      return fail(c, err.message);
    }

    const after = await stateFor(sql, contextOf(attempt));

    // Answering the last question finishes the test. There is no "hand in"
    // step in a locked sequential test, and no way to leave one unsubmitted.
    let score = null;
    if (after.finished) {
      await db.submitAttempt(sql, attempt.id);
      const settings = JSON.parse(attempt.settings || "{}");
      const totals = await db.scoreAttempt(sql, attempt);
      score = settings.show_final_score ? { ...totals, showToStudent: true } : null;
    }

    const settings = JSON.parse(attempt.settings || "{}");
    return c.json({
      saved: true,
      ...after,
      score,
      // Only when the test is set to show it. Off by default: in a room where
      // students finish at different times, telling them turns into telling
      // each other.
      feedback: settings.show_question_feedback
        ? {
            correct: graded.isCorrect,
            explanation: await db.getExplanation(sql, body.questionId),
          }
        : null,
    });
  });

  // There is deliberately no student-facing submit route. In a locked
  // sequential test the last answer ends it; finishing early is the teacher
  // closing the session, not the student opting out.

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
