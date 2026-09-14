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
import { launchSettings, MODES, MODE_LABELS, MODE_DESCRIPTIONS } from "./delivery.js";

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

/**
 * Name the unanswered questions without listing twenty of them.
 *
 * A student who missed two wants to know which two. A student who has barely
 * started wants a count and somewhere to go, not a wall of numbers.
 */
function describeUnanswered(numbers) {
  if (numbers.length === 1) return `You still need to answer question ${numbers[0]}.`;
  if (numbers.length <= 6) {
    return `You still need to answer questions ${numbers.slice(0, -1).join(", ")}` +
           ` and ${numbers[numbers.length - 1]}.`;
  }
  return `You still have ${numbers.length} questions to answer.` +
         ` The first is question ${numbers[0]}.`;
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
   * The two delivery modes differ in more than presentation, so the rules
   * live here rather than in the page:
   *
   *   sequential  one question, answered once, no way back. Only the current
   *               question is sent, because a student who can read the
   *               payload could otherwise read ahead.
   *
   *   open        the student moves freely with Back and Next, changes
   *               answers, and hands in at the end once nothing is blank.
   *               Here the whole paper may go to the browser -- they are
   *               allowed to see every question anyway -- which buys back the
   *               offline tolerance the locked mode cannot have.
   *
   * Either way the answer key stays on the server.
   */
  const deliveryOf = (settingsJson) =>
    JSON.parse(settingsJson || "{}").delivery === "open" ? "open" : "sequential";

  const forStudent = (question) => ({
    id: question.id,
    stem: question.stem,
    media: question.media,
    points: question.points,
    choices: question.choices,     // no isCorrect: see getAssessmentQuestions
  });

  async function orderedPaper(sql, assessmentId, attempt, settings) {
    return buildPaper(
      await db.getAssessmentQuestions(sql, assessmentId),
      attempt.seed,
      settings
    );
  }

  /**
   * Where this student currently stands.
   *
   * In sequential mode the position is simply how many questions they have
   * answered, so there is no cursor to drift out of step with the answers.
   */
  async function stateFor(sql, { attempt, assessmentId, settingsJson, title }) {
    const settings = JSON.parse(settingsJson || "{}");
    const delivery = deliveryOf(settingsJson);
    const ordered = await orderedPaper(sql, assessmentId, attempt, settings);
    const responses = await db.getResponses(sql, attempt.id);

    const common = {
      token: attempt.token,
      title,
      delivery,
      total: ordered.length,
      answered: responses.length,
    };

    if (delivery === "open") {
      return {
        ...common,
        finished: attempt.status === "submitted",
        paper: ordered.map(forStudent),
        answers: Object.fromEntries(responses.map((r) => [r.question_id, r.choice_id])),
      };
    }

    const current = ordered[responses.length] ?? null;
    return {
      ...common,
      number: responses.length + 1,     // what the student sees: "Question 7 of 25"
      finished: responses.length >= ordered.length,
      question: current && forStudent(current),
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
   * position is held by the server, so the student resumes where they had
   * reached -- on any machine, with nothing carried over from the old one.
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
   * Record an answer.
   *
   * Sequential: it must be the question they are on, and it is final.
   * Open: any question on the paper, and changeable until they hand in.
   */
  app.post("/api/answer", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { attempt, error } = await requireAttempt(c, body);
    if (error) return error;

    const sql = c.get("sql");
    const settings = JSON.parse(attempt.settings || "{}");

    if (deliveryOf(attempt.settings) === "open") {
      try {
        await db.saveResponse(sql, attempt, {
          questionId: body.questionId,
          choiceId: body.choiceId,
          msSpent: body.msSpent ?? null,
          final: false,
        });
      } catch (err) {
        return fail(c, err.message);
      }
      // No right/wrong here. A student who could see it would simply change
      // their answer, which is not a test.
      return c.json({
        saved: true,
        answered: await db.countResponses(sql, attempt.id),
      });
    }

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

    // Answering the last question finishes a sequential test. There is no
    // hand-in step to forget, and no way to leave a paper unsubmitted.
    let score = null;
    if (after.finished) {
      await db.submitAttempt(sql, attempt.id);
      const totals = await db.scoreAttempt(sql, attempt);
      score = settings.show_final_score ? { ...totals, showToStudent: true } : null;
    }

    return c.json({
      saved: true,
      ...after,
      score,
      feedback: settings.show_question_feedback
        ? await feedbackFor(sql, before.question, graded.isCorrect)
        : null,
    });
  });

  /**
   * Hand in an open-navigation test.
   *
   * Refused while anything is blank, and the reply names which questions --
   * by the number the student sees, not the database's -- so the page can
   * send them straight back to the first one. A sequential test has no
   * equivalent: its last answer ends it.
   */
  app.post("/api/submit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { attempt, error } = await requireAttempt(c, body);
    if (error) return error;

    const sql = c.get("sql");
    const settings = JSON.parse(attempt.settings || "{}");
    if (deliveryOf(attempt.settings) !== "open") {
      return fail(c, "This test is handed in automatically.", 400);
    }

    const ordered = await orderedPaper(sql, attempt.assessment_id, attempt, settings);
    const answered = new Set(
      (await db.getResponses(sql, attempt.id)).map((r) => r.question_id)
    );

    const unanswered = ordered
      .map((question, index) => (answered.has(question.id) ? null : index + 1))
      .filter((n) => n !== null);

    if (unanswered.length) {
      return c.json({ error: describeUnanswered(unanswered), unanswered }, 409);
    }

    await db.submitAttempt(sql, attempt.id);
    const totals = await db.scoreAttempt(sql, attempt);
    return c.json({
      submitted: true,
      finished: true,
      score: settings.show_final_score ? { ...totals, showToStudent: true } : null,
    });
  });

  /**
   * What to show the student after they answer.
   *
   * The letter reported is the one THIS student saw. Choices are shuffled per
   * student, so the correct answer sits in a different place on each screen --
   * telling them "the answer was B" when B was something else on their own
   * screen would be worse than saying nothing.
   */
  async function feedbackFor(sql, shownQuestion, wasCorrect) {
    const { explanation, correctChoiceId, correctText } =
      await db.getQuestionFeedback(sql, shownQuestion.id);

    const shownIndex = shownQuestion.choices.findIndex((ch) => ch.id === correctChoiceId);

    return {
      correct: wasCorrect,
      explanation,
      // Only sent when they got it wrong -- a student who was right does not
      // need to be told what they already chose.
      correctLetter: wasCorrect ? null : (shownIndex >= 0 ? "ABCDEFGH"[shownIndex] : null),
      correctText: wasCorrect ? null : correctText,
    };
  }

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

  // ------------------------------------------------- the teacher's console
  //
  // Reached by an unguessable per-teacher link, the same interim arrangement
  // as the live board, and replaced by Google sign-in. Everything here is
  // scoped to the teacher that link belongs to: there is no request shape
  // that reaches another teacher's quizzes.

  async function requireTeacher(c) {
    const teacher = await db.findTeacherByConsoleToken(c.get("sql"), c.req.param("token"));
    if (!teacher) return { error: fail(c, "This console link was not recognised.", 404) };
    return { teacher };
  }

  /** What the launch screen needs: quizzes, rooms, and what is already running. */
  app.get("/api/teacher/:token", async (c) => {
    const { teacher, error } = await requireTeacher(c);
    if (error) return error;

    const sql = c.get("sql");
    const sessions = await db.listSessions(sql, teacher.id);

    return c.json({
      teacher: { name: teacher.display_name, email: teacher.email },
      modes: MODES.map((mode) => ({
        id: mode,
        label: MODE_LABELS[mode],
        description: MODE_DESCRIPTIONS[mode],
      })),
      quizzes: await db.listAssessments(sql, teacher.id),
      rooms: await db.listSections(sql, teacher.id),
      sessions: sessions.map((row) => ({
        id: row.id,
        title: row.title,
        section: row.section,
        joinCode: row.join_code,
        state: row.state,
        joined: row.joined,
        created: row.created_at,
        delivery: JSON.parse(row.settings || "{}").delivery ?? "sequential",
        boardUrl: `/live.html#${row.dashboard_token}`,
      })),
    });
  });

  /** Launch a quiz. This is where the delivery mode is actually decided. */
  app.post("/api/teacher/:token/launch", async (c) => {
    const { teacher, error } = await requireTeacher(c);
    if (error) return error;

    const sql = c.get("sql");
    const body = await c.req.json().catch(() => ({}));

    const quiz = await db.findAssessment(sql, teacher.id, Number(body.quizId));
    if (!quiz) return fail(c, "Choose a quiz to launch.", 404);

    const questions = await db.getAssessmentQuestions(sql, quiz.id);
    if (!questions.length) return fail(c, "That quiz has no questions in it yet.");

    const joinCode = String(body.joinCode || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{3,12}$/.test(joinCode)) {
      return fail(c, "A class code should be 3 to 12 letters or numbers.");
    }

    let settings;
    try {
      settings = launchSettings({
        mode: body.mode,
        shuffleQuestions: body.shuffleQuestions !== false,
        shuffleChoices: body.shuffleChoices !== false,
        showQuestionFeedback: body.showQuestionFeedback ?? null,
        showFinalScore: body.showFinalScore === true,
      });
    } catch (err) {
      return fail(c, err.message);
    }

    const dashboardToken = randomToken();
    try {
      await db.createSession(sql, teacher.id, {
        assessmentId: quiz.id,
        sectionId: body.sectionId ? Number(body.sectionId) : null,
        joinCode,
        settings,
        dashboardToken,
      });
    } catch (err) {
      return fail(c, /UNIQUE/i.test(err.message)
        ? `The class code ${joinCode} is already in use. Pick another.`
        : err.message);
    }

    return c.json({
      launched: true,
      title: quiz.title,
      joinCode,
      questions: questions.length,
      settings,
      boardUrl: `/live.html#${dashboardToken}`,
    });
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  if (staticHandler) app.get("*", staticHandler);

  return app;
}
