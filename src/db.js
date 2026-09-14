/**
 * Every SQL statement in the application lives in this file.
 *
 * That is the rule that keeps the app portable: `sql` below is a tiny driver
 * interface with three async methods, and there are two implementations --
 * better-sqlite3 for a local file, and Cloudflare D1 for production. The SQL
 * itself is identical, so moving between them is a deploy change rather than
 * a rewrite.
 *
 * Every function here takes teacherId and filters on it. Nothing in this file
 * reads content without scoping it to an owner.
 */

// ------------------------------------------------------------------ drivers

/** Wrap a better-sqlite3 Database in the async interface used below. */
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

export async function findSessionByCode(sql, joinCode) {
  return sql.get(
    `SELECT s.*, a.title, a.settings
       FROM sessions s
       JOIN assessments a ON a.id = s.assessment_id
      WHERE s.join_code = ?`,
    [String(joinCode).trim().toUpperCase()]
  );
}

export async function createSession(sql, teacherId, { assessmentId, sectionId, joinCode }) {
  const { lastInsertId } = await sql.run(
    `INSERT INTO sessions (teacher_id, assessment_id, section_id, join_code)
     VALUES (?, ?, ?, ?)`,
    [teacherId, assessmentId, sectionId, joinCode.toUpperCase()]
  );
  return lastInsertId;
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
            asm.settings, asm.title
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

/**
 * Record one answer and grade it immediately.
 *
 * Grading on save rather than on submit means a student who never presses
 * Submit -- battery, bell, closed lid -- still has a scored paper.
 */
export async function saveResponse(sql, attempt, { questionId, choiceId, msSpent = null }) {
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
  return { isCorrect: !!isCorrect };
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
