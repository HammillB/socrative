/**
 * Every SQL statement in the application lives in this file.
 *
 * That is the rule that keeps the app portable: `sql` below is a tiny driver
 * interface with three async methods, and there are two implementations --
 * Node's built-in SQLite for a local file, and Cloudflare D1 for production.
 * The SQL itself is identical, so moving between them is a deploy change
 * rather than a rewrite.
 *
 * Every function here takes teacherId and filters on it. Nothing in this file
 * reads content without scoping it to an owner.
 */

// ------------------------------------------------------------------ drivers

/**
 * Wrap a node:sqlite DatabaseSync in the async interface used below.
 *
 * node:sqlite ships with Node itself, so there is no native module to compile
 * and nothing to rebuild when Node updates -- which is worth a great deal in a
 * project that gets touched twice a year.
 */
export function nodeDriver(database) {
  return {
    async all(query, params = []) {
      return database.prepare(query).all(...params);
    },
    async get(query, params = []) {
      return database.prepare(query).get(...params) ?? null;
    },
    async run(query, params = []) {
      const info = database.prepare(query).run(...params);
      return { lastInsertId: Number(info.lastInsertRowid), changes: info.changes };
    },
  };
}

/** Wrap a Cloudflare D1 binding in the same interface. */
export function d1Driver(database) {
  return {
    async all(query, params = []) {
      const { results } = await database.prepare(query).bind(...params).all();
      return results ?? [];
    },
    async get(query, params = []) {
      return (await database.prepare(query).bind(...params).first()) ?? null;
    },
    async run(query, params = []) {
      const { meta } = await database.prepare(query).bind(...params).run();
      return { lastInsertId: Number(meta?.last_row_id ?? 0), changes: meta?.changes ?? 0 };
    },
  };
}

// ------------------------------------------------------------------ people

/** The teacher a console link belongs to. Interim until Google sign-in. */
export async function findTeacherByConsoleToken(sql, token) {
  if (!token) return null;
  return sql.get(`SELECT * FROM teachers WHERE console_token = ?`, [token]);
}

export async function listSections(sql, teacherId) {
  return sql.all(
    `SELECT s.id, s.name,
            (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) AS students
       FROM sections s WHERE s.teacher_id = ? ORDER BY s.name`,
    [teacherId]
  );
}

export async function listSessions(sql, teacherId) {
  return sql.all(
    `SELECT s.id, s.join_code, s.state, s.settings, s.created_at,
            s.dashboard_token, a.title, sec.name AS section,
            (SELECT COUNT(*) FROM attempts at WHERE at.session_id = s.id) AS joined
       FROM sessions s
       JOIN assessments a ON a.id = s.assessment_id
       LEFT JOIN sections sec ON sec.id = s.section_id
      WHERE s.teacher_id = ?
      ORDER BY s.created_at DESC
      LIMIT 20`,
    [teacherId]
  );
}

export async function findTeacherByEmail(sql, email) {
  return sql.get(`SELECT * FROM teachers WHERE email = ?`, [email]);
}

export async function createTeacher(sql, { email, displayName }) {
  const { lastInsertId } = await sql.run(
    `INSERT INTO teachers (email, display_name) VALUES (?, ?)`,
    [email, displayName]
  );
  return lastInsertId;
}

export async function upsertSection(sql, teacherId, { name, period = null }) {
  const found = await sql.get(
    `SELECT id FROM sections WHERE teacher_id = ? AND name = ?`,
    [teacherId, name]
  );
  if (found) return found.id;
  const { lastInsertId } = await sql.run(
    `INSERT INTO sections (teacher_id, name, period) VALUES (?, ?, ?)`,
    [teacherId, name, period]
  );
  return lastInsertId;
}

export async function upsertStudent(sql, teacherId, student) {
  const { studentNumber, firstName = null, lastName = null } = student;
  const found = await sql.get(
    `SELECT id FROM students WHERE teacher_id = ? AND student_number = ?`,
    [teacherId, studentNumber]
  );
  if (found) {
    await sql.run(
      `UPDATE students SET first_name = ?, last_name = ?
        WHERE id = ? AND teacher_id = ?`,
      [firstName, lastName, found.id, teacherId]
    );
    return found.id;
  }
  const { lastInsertId } = await sql.run(
    `INSERT INTO students (teacher_id, student_number, first_name, last_name)
     VALUES (?, ?, ?, ?)`,
    [teacherId, studentNumber, firstName, lastName]
  );
  return lastInsertId;
}

export async function enroll(sql, studentId, sectionId) {
  await sql.run(
    `INSERT OR IGNORE INTO enrollments (student_id, section_id) VALUES (?, ?)`,
    [studentId, sectionId]
  );
}

/** Look a student up by the number they type in. Scoped to one teacher. */
export async function findStudentByNumber(sql, teacherId, studentNumber) {
  return sql.get(
    `SELECT * FROM students WHERE teacher_id = ? AND student_number = ?`,
    [teacherId, String(studentNumber).trim()]
  );
}

// --------------------------------------------------------------- questions

export async function createQuestion(sql, teacherId, question) {
  const {
    stem, choices, points = 1,
    standardId = null, familyId = null,
    explanation = null, media = null, explanationMedia = null,
  } = question;

  const correctCount = choices.filter((c) => c.isCorrect).length;
  if (correctCount !== 1) {
    throw new Error(
      `"${stem.slice(0, 50)}..." has ${correctCount} correct answers; exactly one is required`
    );
  }

  const { lastInsertId: questionId } = await sql.run(
    `INSERT INTO questions
       (teacher_id, stem, media, points, standard_id, family_id, explanation, explanation_media)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [teacherId, stem, media, points, standardId, familyId, explanation, explanationMedia]
  );

  for (const [index, choice] of choices.entries()) {
    await sql.run(
      `INSERT INTO choices (question_id, position, text, media, is_correct)
       VALUES (?, ?, ?, ?, ?)`,
      [questionId, index, choice.text, choice.media ?? null, choice.isCorrect ? 1 : 0]
    );
  }
  return questionId;
}

export async function createAssessment(sql, teacherId, { title, settings = {} }) {
  const { lastInsertId } = await sql.run(
    `INSERT INTO assessments (teacher_id, title, settings) VALUES (?, ?, ?)`,
    [teacherId, title, JSON.stringify(settings)]
  );
  return lastInsertId;
}

export async function addAssessmentItem(sql, teacherId, assessmentId, questionId, position) {
  // Both sides are checked against teacher_id so an assessment can never be
  // built from another teacher's questions, even by a crafted request.
  const owned = await sql.get(
    `SELECT 1 AS ok
       FROM assessments a
       JOIN questions  q ON q.teacher_id = a.teacher_id
      WHERE a.id = ? AND q.id = ? AND a.teacher_id = ?`,
    [assessmentId, questionId, teacherId]
  );
  if (!owned) throw new Error("assessment or question does not belong to this teacher");

  await sql.run(
    `INSERT OR REPLACE INTO assessment_items (assessment_id, question_id, position)
     VALUES (?, ?, ?)`,
    [assessmentId, questionId, position]
  );
}

/**
 * The questions on an assessment, with their choices.
 *
 * `includeAnswers` defaults to false and must stay that way for anything a
 * student can reach. The correct answer never leaves the server during a test.
 */
export async function getAssessmentQuestions(sql, assessmentId, { includeAnswers = false } = {}) {
  const questions = await sql.all(
    `SELECT q.id, q.stem, q.media, q.explanation,
            COALESCE(ai.points, q.points) AS points,
            ai.position
       FROM assessment_items ai
       JOIN questions q ON q.id = ai.question_id
      WHERE ai.assessment_id = ?
      ORDER BY ai.position`,
    [assessmentId]
  );

  for (const question of questions) {
    const choices = await sql.all(
      `SELECT id, position, text, media, is_correct
         FROM choices WHERE question_id = ? ORDER BY position`,
      [question.id]
    );
    question.choices = choices.map((choice) => ({
      id: choice.id,
      text: choice.text,
      media: choice.media,
      ...(includeAnswers ? { isCorrect: !!choice.is_correct } : {}),
    }));
  }
  return questions;
}

// ----------------------------------------------------------------- testing

/**
 * A session by its join code.
 *
 * `settings` deliberately comes from the SESSION, not the quiz: how a test
 * behaves is chosen by the teacher when they launch it, and is fixed for the
 * life of that run.
 */
export async function findSessionByCode(sql, joinCode) {
  return sql.get(
    `SELECT s.id, s.teacher_id, s.assessment_id, s.section_id, s.join_code,
            s.state, s.settings, a.title
       FROM sessions s
       JOIN assessments a ON a.id = s.assessment_id
      WHERE s.join_code = ?`,
    [String(joinCode).trim().toUpperCase()]
  );
}

/** Launch a quiz. The settings passed here are what the students will get. */
export async function createSession(
  sql, teacherId, { assessmentId, sectionId, joinCode, settings = {}, dashboardToken = null }
) {
  const { lastInsertId } = await sql.run(
    `INSERT INTO sessions
       (teacher_id, assessment_id, section_id, join_code, settings, dashboard_token)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [teacherId, assessmentId, sectionId, joinCode.toUpperCase(),
     JSON.stringify(settings), dashboardToken]
  );
  return lastInsertId;
}

/** A quiz belonging to this teacher, with its default settings. */
export async function findAssessment(sql, teacherId, assessmentId) {
  return sql.get(
    `SELECT * FROM assessments WHERE id = ? AND teacher_id = ?`,
    [assessmentId, teacherId]
  );
}

export async function listAssessments(sql, teacherId) {
  return sql.all(
    `SELECT a.id, a.title, a.created_at,
            (SELECT COUNT(*) FROM assessment_items ai WHERE ai.assessment_id = a.id) AS questions
       FROM assessments a
      WHERE a.teacher_id = ?
      ORDER BY a.created_at DESC`,
    [teacherId]
  );
}

export async function findAttempt(sql, sessionId, studentId) {
  return sql.get(
    `SELECT * FROM attempts WHERE session_id = ? AND student_id = ?`,
    [sessionId, studentId]
  );
}

export async function createAttempt(sql, { sessionId, studentId, seed, token }) {
  const { lastInsertId } = await sql.run(
    `INSERT INTO attempts (session_id, student_id, seed, token) VALUES (?, ?, ?, ?)`,
    [sessionId, studentId, seed, token]
  );
  return lastInsertId;
}

export async function findAttemptByToken(sql, token) {
  return sql.get(
    `SELECT a.*, s.assessment_id, s.state AS session_state,
            s.settings, asm.title
       FROM attempts a
       JOIN sessions s    ON s.id   = a.session_id
       JOIN assessments asm ON asm.id = s.assessment_id
      WHERE a.token = ?`,
    [token]
  );
}

export async function getResponses(sql, attemptId) {
  return sql.all(
    `SELECT question_id, choice_id FROM responses WHERE attempt_id = ?`,
    [attemptId]
  );
}

export async function countResponses(sql, attemptId) {
  const row = await sql.get(
    `SELECT COUNT(*) AS n FROM responses WHERE attempt_id = ?`,
    [attemptId]
  );
  return row?.n ?? 0;
}

/**
 * Record one answer and grade it immediately.
 *
 * Grading on save rather than on submit means a student who never presses
 * Submit -- battery, bell, closed lid -- still has a scored paper.
 *
 * `final` is the locked sequential mode: an answer, once given, cannot be
 * revised. The refusal lives here rather than in the page, because a rule the
 * browser enforces is not a rule.
 */
export async function saveResponse(sql, attempt, { questionId, choiceId, msSpent = null, final = false }) {
  const onPaper = await sql.get(
    `SELECT COALESCE(ai.points, q.points) AS points
       FROM assessment_items ai
       JOIN questions q ON q.id = ai.question_id
      WHERE ai.assessment_id = ? AND ai.question_id = ?`,
    [attempt.assessment_id, questionId]
  );
  if (!onPaper) throw new Error("that question is not on this test");

  const choice = await sql.get(
    `SELECT is_correct FROM choices WHERE id = ? AND question_id = ?`,
    [choiceId, questionId]
  );
  if (!choice) throw new Error("that choice is not on that question");

  if (final) {
    const already = await sql.get(
      `SELECT 1 AS yes FROM responses WHERE attempt_id = ? AND question_id = ?`,
      [attempt.id, questionId]
    );
    if (already) throw new Error("that question has already been answered");
  }

  const isCorrect = choice.is_correct ? 1 : 0;
  await sql.run(
    `INSERT INTO responses (attempt_id, question_id, choice_id, is_correct, points_earned, ms_spent)
          VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (attempt_id, question_id) DO UPDATE SET
          choice_id     = excluded.choice_id,
          is_correct    = excluded.is_correct,
          points_earned = excluded.points_earned,
          answered_at   = datetime('now'),
          ms_spent      = excluded.ms_spent`,
    [attempt.id, questionId, choiceId, isCorrect, isCorrect ? onPaper.points : 0, msSpent]
  );
  return { isCorrect: !!isCorrect, points: isCorrect ? onPaper.points : 0 };
}

/**
 * What to tell a student after they have answered: the right choice and why.
 *
 * Fetched only once the answer is committed, so nothing here can reach a
 * student before they have made their choice.
 */
export async function getQuestionFeedback(sql, questionId) {
  const question = await sql.get(
    `SELECT explanation FROM questions WHERE id = ?`, [questionId]
  );
  const correct = await sql.get(
    `SELECT id, text FROM choices WHERE question_id = ? AND is_correct = 1`,
    [questionId]
  );
  return {
    explanation: question?.explanation ?? null,
    correctChoiceId: correct?.id ?? null,
    correctText: correct?.text ?? null,
  };
}

export async function submitAttempt(sql, attemptId) {
  await sql.run(
    `UPDATE attempts SET status = 'submitted', submitted_at = datetime('now')
      WHERE id = ? AND status <> 'submitted'`,
    [attemptId]
  );
}

export async function scoreAttempt(sql, attempt) {
  const earned = await sql.get(
    `SELECT COALESCE(SUM(points_earned), 0) AS points,
            COALESCE(SUM(is_correct), 0)    AS correct
       FROM responses WHERE attempt_id = ?`,
    [attempt.id]
  );
  const possible = await sql.get(
    `SELECT COALESCE(SUM(COALESCE(ai.points, q.points)), 0) AS points,
            COUNT(*) AS questions
       FROM assessment_items ai
       JOIN questions q ON q.id = ai.question_id
      WHERE ai.assessment_id = ?`,
    [attempt.assessment_id]
  );
  return {
    pointsEarned: earned.points,
    pointsPossible: possible.points,
    correct: earned.correct,
    questions: possible.questions,
    percent: possible.points ? Math.round((earned.points / possible.points) * 1000) / 10 : 0,
  };
}

export async function logEvent(sql, attemptId, kind) {
  await sql.run(`INSERT INTO events (attempt_id, kind) VALUES (?, ?)`, [attemptId, kind]);
}

// -------------------------------------------------------------- live board

/**
 * Everything the teacher's live grid needs, in CANONICAL order.
 *
 * This is the point of storing choice_id on a response rather than the letter
 * the student saw. Each student's paper is shuffled -- different question
 * order, different choice order -- but a choice has one permanent identity,
 * and `choices.position` is its original place. So the board can show
 * question 7 as question 7 for everyone, and report an answer as "D" if D is
 * what it was when you wrote it, whatever letter that student saw on screen.
 *
 * Without that conversion the grid is unreadable: thirty students picking the
 * same wrong answer would show up as thirty different letters.
 */
export async function getLiveBoard(sql, dashboardToken) {
  const LETTERS = "ABCDEFGH";

  const session = await sql.get(
    `SELECT s.id, s.teacher_id, s.assessment_id, s.section_id, s.join_code,
            s.state, s.settings, a.title
       FROM sessions s
       JOIN assessments a ON a.id = s.assessment_id
      WHERE s.dashboard_token = ?`,
    [dashboardToken]
  );
  if (!session) return null;

  // Questions in the order they were written, not the order anyone saw them.
  const questions = await sql.all(
    `SELECT ai.position, q.id, q.stem
       FROM assessment_items ai
       JOIN questions q ON q.id = ai.question_id
      WHERE ai.assessment_id = ?
      ORDER BY ai.position`,
    [session.assessment_id]
  );

  // choice id -> its canonical letter, and each question's correct letter
  const letterOf = new Map();
  for (const question of questions) {
    const choices = await sql.all(
      `SELECT id, position, is_correct FROM choices WHERE question_id = ? ORDER BY position`,
      [question.id]
    );
    for (const choice of choices) {
      letterOf.set(choice.id, LETTERS[choice.position] ?? "?");
      if (choice.is_correct) question.correctLetter = LETTERS[choice.position] ?? "?";
    }
    question.choiceCount = choices.length;
  }

  // The roster, so a student who never signed in still gets a row. Silence is
  // information: an empty row is a student to walk over to.
  const roster = session.section_id
    ? await sql.all(
        `SELECT st.id, st.student_number, st.first_name, st.last_name
           FROM enrollments e
           JOIN students st ON st.id = e.student_id
          WHERE e.section_id = ? AND st.teacher_id = ?
          ORDER BY st.last_name, st.first_name, st.student_number`,
        [session.section_id, session.teacher_id]
      )
    : await sql.all(
        `SELECT st.id, st.student_number, st.first_name, st.last_name
           FROM attempts a
           JOIN students st ON st.id = a.student_id
          WHERE a.session_id = ?
          ORDER BY st.last_name, st.first_name, st.student_number`,
        [session.id]
      );

  const attempts = await sql.all(
    `SELECT id, student_id, status, started_at, submitted_at FROM attempts WHERE session_id = ?`,
    [session.id]
  );
  const attemptByStudent = new Map(attempts.map((a) => [a.student_id, a]));

  const responses = attempts.length
    ? await sql.all(
        `SELECT r.attempt_id, r.question_id, r.choice_id, r.is_correct, r.answered_at
           FROM responses r
           JOIN attempts a ON a.id = r.attempt_id
          WHERE a.session_id = ?
          ORDER BY r.answered_at`,
        [session.id]
      )
    : [];

  const byAttempt = new Map();
  for (const r of responses) {
    if (!byAttempt.has(r.attempt_id)) byAttempt.set(r.attempt_id, []);
    byAttempt.get(r.attempt_id).push(r);
  }

  const positionOf = new Map(questions.map((q) => [q.id, q.position]));

  const students = roster.map((student) => {
    const attempt = attemptByStudent.get(student.id);
    const mine = attempt ? byAttempt.get(attempt.id) ?? [] : [];

    const answers = {};
    for (const r of mine) {
      answers[r.question_id] = {
        letter: letterOf.get(r.choice_id) ?? "?",
        correct: !!r.is_correct,
      };
    }

    const last = mine[mine.length - 1];
    return {
      id: student.id,
      number: student.student_number,
      name: [student.last_name, student.first_name].filter(Boolean).join(", ")
            || student.student_number,
      status: !attempt ? "not_started"
            : attempt.status === "submitted" ? "submitted"
            : "in_progress",
      answers,
      answered: mine.length,
      // With Open Navigation a student roams, so "where they are" is the last
      // question they touched rather than a cursor position.
      lastPosition: last ? (positionOf.get(last.question_id) ?? null) : null,
      correct: mine.filter((r) => r.is_correct).length,
      // Accuracy on what they have answered so far -- not a fraction of the
      // whole test. Mid-period, "8 of 8 right" is the useful fact; showing it
      // as 32% because they are a third of the way through reads like a
      // struggling student and would send you to the wrong desk.
      percent: mine.length
        ? Math.round((mine.filter((r) => r.is_correct).length / mine.length) * 100)
        : null,
      // What the score will be if they stop now, for the end of the period.
      percentOfTest: questions.length
        ? Math.round((mine.filter((r) => r.is_correct).length / questions.length) * 100)
        : 0,
    };
  });

  // Per-question difficulty, live. Anything the class is failing in real time
  // is worth knowing before the period ends, not after marking.
  for (const question of questions) {
    const seen = students.filter((s) => s.answers[question.id]);
    question.answered = seen.length;
    question.correct = seen.filter((s) => s.answers[question.id].correct).length;
    question.percent = seen.length ? Math.round((question.correct / seen.length) * 100) : null;
    question.struggling = seen.length >= 3 && question.percent !== null && question.percent < 40;
  }

  return {
    session: {
      id: session.id,
      title: session.title,
      joinCode: session.join_code,
      state: session.state,
      delivery: JSON.parse(session.settings || "{}").delivery ?? "sequential",
    },
    questions,
    students,
    summary: {
      joined: students.filter((s) => s.status !== "not_started").length,
      submitted: students.filter((s) => s.status === "submitted").length,
      total: students.length,
    },
  };
}

export async function setSessionState(sql, dashboardToken, state) {
  const { changes } = await sql.run(
    `UPDATE sessions SET state = ? WHERE dashboard_token = ?`,
    [state, dashboardToken]
  );
  return changes > 0;
}
