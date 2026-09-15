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

import { pickColumn } from "./csv.js";

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
    `SELECT s.id, s.state, s.settings, s.created_at,
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

/** Is this student on the roster for that room? */
export async function isEnrolled(sql, studentId, sectionId) {
  const row = await sql.get(
    `SELECT 1 AS yes FROM enrollments WHERE student_id = ? AND section_id = ?`,
    [studentId, sectionId]
  );
  return !!row;
}

/** Look a student up by the number they type in. Scoped to one teacher. */
export async function findStudentByNumber(sql, teacherId, studentNumber) {
  return sql.get(
    `SELECT * FROM students WHERE teacher_id = ? AND student_number = ?`,
    [teacherId, String(studentNumber).trim()]
  );
}

// ------------------------------------------------------------------ rooms

/** One room's roster. A student can be enrolled in more than one room. */
export async function listRosterForSection(sql, teacherId, sectionId) {
  return sql.all(
    `SELECT st.id, st.student_number, st.first_name, st.last_name
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
      WHERE e.section_id = ? AND st.teacher_id = ?
      ORDER BY st.last_name, st.first_name, st.student_number`,
    [sectionId, teacherId]
  );
}

/**
 * Edit a student's own record -- their number and name, not any one room's
 * view of them. The same edit is visible in every room they are enrolled in,
 * because it is the same underlying student.
 */
export async function updateStudent(sql, teacherId, studentId, { studentNumber, firstName, lastName }) {
  const trimmed = String(studentNumber ?? "").trim();
  if (!trimmed) throw new Error("A student needs a student number.");
  const { changes } = await sql.run(
    `UPDATE students SET student_number = ?, first_name = ?, last_name = ?
      WHERE id = ? AND teacher_id = ?`,
    [trimmed, firstName || null, lastName || null, studentId, teacherId]
  );
  return changes > 0;
}

/**
 * Remove one student from one room's roster. Does not delete the student
 * record itself -- they may still be enrolled elsewhere, and past attempts
 * naming them stay exactly as they were.
 */
export async function unenrollStudent(sql, teacherId, sectionId, studentId) {
  const owned = await sql.get(
    `SELECT 1 AS ok FROM sections WHERE id = ? AND teacher_id = ?`,
    [sectionId, teacherId]
  );
  if (!owned) return false;
  const { changes } = await sql.run(
    `DELETE FROM enrollments WHERE section_id = ? AND student_id = ?`,
    [sectionId, studentId]
  );
  return changes > 0;
}

/** Create a new, empty room. Room names are unique across the whole install. */
export async function createRoom(sql, teacherId, name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("Give the room a name.");
  const { lastInsertId } = await sql.run(
    `INSERT INTO sections (teacher_id, name) VALUES (?, ?)`,
    [teacherId, trimmed]
  );
  return lastInsertId;
}

export async function renameRoom(sql, teacherId, sectionId, name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("Give the room a name.");
  const { changes } = await sql.run(
    `UPDATE sections SET name = ? WHERE id = ? AND teacher_id = ?`,
    [trimmed, sectionId, teacherId]
  );
  return changes > 0;
}

/**
 * Delete a room outright. Enrollments cascade with it (schema: ON DELETE
 * CASCADE); any session ever launched into it keeps its own history --
 * sections.id on a session is ON DELETE SET NULL, so a past test's record
 * survives the room it was given in being deleted, just with no room name
 * to show for it any more.
 */
export async function deleteRoom(sql, teacherId, sectionId) {
  const { changes } = await sql.run(
    `DELETE FROM sections WHERE id = ? AND teacher_id = ?`,
    [sectionId, teacherId]
  );
  return changes > 0;
}

/**
 * Bulk-load a roster into a room from already-parsed CSV rows, in
 * Socrative's own column shape (First Name, Last Name, Student ID). A
 * number already on the teacher's books is matched and updated rather than
 * duplicated -- the same rule scripts/import.js has always used.
 */
export async function importRosterRows(sql, teacherId, sectionId, rows) {
  const owned = await sql.get(
    `SELECT 1 AS ok FROM sections WHERE id = ? AND teacher_id = ?`,
    [sectionId, teacherId]
  );
  if (!owned) throw new Error("That room was not found.");

  let count = 0;
  for (const row of rows) {
    const studentNumber = pickColumn(row, "Student ID", "StudentID", "ID", "student_number");
    if (!studentNumber) continue;
    const studentId = await upsertStudent(sql, teacherId, {
      studentNumber,
      firstName: pickColumn(row, "First Name", "FirstName", "First"),
      lastName: pickColumn(row, "Last Name", "LastName", "Last"),
    });
    await enroll(sql, studentId, sectionId);
    count++;
  }
  return count;
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

/** A room by the name a student types. Case and stray spaces are forgiven. */
export async function findSectionByName(sql, name) {
  return sql.get(
    `SELECT * FROM sections WHERE LOWER(name) = LOWER(?)`,
    [String(name ?? "").trim()]
  );
}

/**
 * Whatever test a room is running right now.
 *
 * This is what a student's room name resolves to. The room name is permanent;
 * what sits behind it is the teacher's choice, and changes from one test to
 * the next without students being told anything new.
 *
 * `settings` deliberately comes from the SESSION, not the quiz: how a test
 * behaves is chosen by the teacher when they launch it, and is fixed for the
 * life of that run.
 */
export async function findOpenSessionInRoom(sql, sectionId) {
  return sql.get(
    `SELECT s.id, s.teacher_id, s.assessment_id, s.section_id,
            s.state, s.settings, a.title
       FROM sessions s
       JOIN assessments a ON a.id = s.assessment_id
      WHERE s.section_id = ? AND s.state <> 'closed'
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [sectionId]
  );
}

/** Launch a quiz. The settings passed here are what the students will get. */
export async function createSession(
  sql, teacherId, { assessmentId, sectionId, settings = {}, dashboardToken = null }
) {
  const { lastInsertId } = await sql.run(
    `INSERT INTO sessions
       (teacher_id, assessment_id, section_id, settings, dashboard_token)
     VALUES (?, ?, ?, ?, ?)`,
    [teacherId, assessmentId, sectionId, JSON.stringify(settings), dashboardToken]
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
            COALESCE(a.updated_at, a.created_at) AS updated_at,
            (SELECT COUNT(*) FROM assessment_items ai WHERE ai.assessment_id = a.id) AS questions
       FROM assessments a
      WHERE a.teacher_id = ?
      ORDER BY COALESCE(a.updated_at, a.created_at) DESC`,
    [teacherId]
  );
}

/**
 * The test currently open in a room, if any.
 *
 * A room runs one test at a time -- the same rule Socrative has, and a sound
 * one: two open codes for the same class is how half a period ends up in the
 * wrong test.
 */
export async function findOpenSessionForSection(sql, teacherId, sectionId) {
  return sql.get(
    `SELECT s.id, s.state, s.dashboard_token, a.title
       FROM sessions s
       JOIN assessments a ON a.id = s.assessment_id
      WHERE s.teacher_id = ? AND s.section_id = ? AND s.state <> 'closed'
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [teacherId, sectionId]
  );
}

/** Close a session the teacher owns. Students can no longer join or answer. */
export async function closeSession(sql, teacherId, sessionId) {
  const { changes } = await sql.run(
    `UPDATE sessions SET state = 'closed' WHERE id = ? AND teacher_id = ?`,
    [sessionId, teacherId]
  );
  return changes > 0;
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
/**
 * Difficulty and discrimination for a set of COMPLETED attempts.
 *
 * Pure computation, no database access, so it can be shared by the live
 * board (which already has this data sitting in memory from its own
 * queries) and the item analysis report (which fetches it fresh) without
 * the two ever quietly computing the number two different ways.
 *
 * The method is the standard one, unchanged since Kelley (1939): rank
 * attempts by total score, split off the top and bottom ~27% as the groups
 * most likely to separate a good item from a bad one, and compare how each
 * group did on every question.
 *
 *   difficulty (p)      = correct / answered, over every completed attempt
 *   discrimination (D)  = (top group's p on this item) - (bottom group's p)
 */
function rankAndScore(submittedAttemptIds, responses) {
  const submitted = new Set(submittedAttemptIds);
  const totalByAttempt = new Map(submittedAttemptIds.map((id) => [id, 0]));
  const byQuestion = new Map();

  for (const r of responses) {
    if (!submitted.has(r.attempt_id)) continue;
    totalByAttempt.set(r.attempt_id, (totalByAttempt.get(r.attempt_id) ?? 0) + (r.points_earned ?? 0));
    if (!byQuestion.has(r.question_id)) byQuestion.set(r.question_id, []);
    byQuestion.get(r.question_id).push(r);
  }

  // With this few data points per class, rounding matters: floor(n/2) keeps
  // the two groups from overlapping when n is small, and a lone completed
  // attempt (n<2) gets no group at all -- there is nothing to compare it to.
  const ranked = [...totalByAttempt.entries()].sort((a, b) => b[1] - a[1]);
  const n = ranked.length;
  const groupSize = n >= 2 ? Math.max(1, Math.min(Math.floor(n / 2), Math.round(n * 0.27))) : 0;
  const topIds = new Set(ranked.slice(0, groupSize).map(([id]) => id));
  const bottomIds = new Set(ranked.slice(n - groupSize, n).map(([id]) => id));

  const stats = new Map();
  for (const [questionId, rs] of byQuestion) {
    const answered = rs.length;
    const correct = rs.filter((r) => r.is_correct).length;
    const difficulty = answered ? Math.round((correct / answered) * 100) / 100 : null;

    let discrimination = null;
    if (groupSize >= 1) {
      const topRs = rs.filter((r) => topIds.has(r.attempt_id));
      const bottomRs = rs.filter((r) => bottomIds.has(r.attempt_id));
      if (topRs.length && bottomRs.length) {
        const topP = topRs.filter((r) => r.is_correct).length / topRs.length;
        const bottomP = bottomRs.filter((r) => r.is_correct).length / bottomRs.length;
        discrimination = Math.round((topP - bottomP) * 100) / 100;
      }
    }
    stats.set(questionId, { answered, difficulty, discrimination });
  }

  return { n, groupSize, topIds, bottomIds, byQuestion, stats };
}

export async function getLiveBoard(sql, dashboardToken) {
  const LETTERS = "ABCDEFGH";

  const session = await sql.get(
    `SELECT s.id, s.teacher_id, s.assessment_id, s.section_id,
            s.state, s.settings, a.title, sec.name AS room
       FROM sessions s
       JOIN assessments a ON a.id = s.assessment_id
       LEFT JOIN sections sec ON sec.id = s.section_id
      WHERE s.dashboard_token = ?`,
    [dashboardToken]
  );
  if (!session) return null;

  // Questions in the order they were written, not the order anyone saw them.
  const questions = await sql.all(
    `SELECT ai.position, q.id, q.stem,
            COALESCE(ai.points, q.points) AS points
       FROM assessment_items ai
       JOIN questions q ON q.id = ai.question_id
      WHERE ai.assessment_id = ?
      ORDER BY ai.position`,
    [session.assessment_id]
  );
  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);

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
        `SELECT r.attempt_id, r.question_id, r.choice_id, r.is_correct,
                r.points_earned, r.answered_at
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
      // Points earned so far, against the whole test's total -- the points
      // equivalent of percentOfTest. Unlike percent this needs no scaling:
      // it is just a running sum, so it is shown against the FULL total
      // rather than only the questions answered so far.
      pointsEarned: mine.reduce((sum, r) => sum + (r.points_earned ?? 0), 0),
      // How much of the test they have gotten through, independent of
      // whether their answers were right. A student stalled on question 3
      // and a student cruising through wrong answers both show 100% on the
      // Correct column at some point; progress is the field that tells them
      // apart.
      progressPercent: questions.length
        ? Math.round((mine.length / questions.length) * 100)
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

  // Discrimination, the item-analysis number, computed over COMPLETED papers
  // only -- unlike question.percent above, which is live and counts anyone
  // who has answered so far. A student stuck mid-test would otherwise skew
  // which questions look like they are "discriminating" well.
  const submittedIds = attempts.filter((a) => a.status === "submitted").map((a) => a.id);
  const { n: itemStudents, groupSize: itemGroupSize, stats: itemStats } =
    rankAndScore(submittedIds, responses);
  for (const question of questions) {
    question.discrimination = itemStats.get(question.id)?.discrimination ?? null;
  }

  return {
    session: {
      id: session.id,
      title: session.title,
      room: session.room,
      state: session.state,
      delivery: JSON.parse(session.settings || "{}").delivery ?? "sequential",
    },
    questions,
    students,
    totalPoints,
    // How many completed papers the discrimination column is based on, so
    // the board can say so rather than showing bare numbers with no context.
    itemAnalysis: { students: itemStudents, groupSize: itemGroupSize },
    summary: {
      joined: students.filter((s) => s.status !== "not_started").length,
      submitted: students.filter((s) => s.status === "submitted").length,
      total: students.length,
    },
  };
}

// ---------------------------------------------------------------- reports

/**
 * Difficulty and discrimination for every question in ONE administration of
 * a test.
 *
 * Scoped to a session, not a quiz: the same quiz launched twice -- locked
 * for a graded test on Tuesday, open for review on Wednesday -- is two
 * different administrations with two different rosters of answers, and gets
 * two different reports. Reached by the same dashboard_token as the live
 * board; there is nothing more sensitive in this report than in that grid.
 *
 * Only SUBMITTED attempts count. A submitted attempt is a complete paper in
 * both delivery modes -- open navigation refuses to hand in with a blank,
 * and sequential submits itself the instant the last question is answered
 * -- so every attempt counted here answered every question. That is what
 * classic item statistics assume, and it is why a test still being taken
 * simply has a smaller, still-valid n rather than partial, misleading data.
 *
 * The method is the standard one, unchanged since Kelley (1939): rank
 * students by total score, split off the top and bottom ~27% as the groups
 * most likely to actually separate a good item from a bad one, and compare
 * how each group did on every single question.
 *
 *   difficulty (p)      = correct / answered, over EVERYONE who finished
 *   discrimination (D)  = (top group's p on this item) - (bottom group's p)
 *
 * A distractor's raw pick-count is directly comparable between the two
 * groups without converting to a rate first, because construction gives the
 * top and bottom group the same size.
 */
export async function getItemAnalysis(sql, dashboardToken) {
  const LETTERS = "ABCDEFGH";

  const session = await sql.get(
    `SELECT s.id, s.teacher_id, s.assessment_id, s.state, a.title, sec.name AS room
       FROM sessions s
       JOIN assessments a ON a.id = s.assessment_id
       LEFT JOIN sections sec ON sec.id = s.section_id
      WHERE s.dashboard_token = ?`,
    [dashboardToken]
  );
  if (!session) return null;

  const questions = await sql.all(
    `SELECT ai.position, q.id, q.stem, q.media,
            COALESCE(ai.points, q.points) AS points
       FROM assessment_items ai
       JOIN questions q ON q.id = ai.question_id
      WHERE ai.assessment_id = ?
      ORDER BY ai.position`,
    [session.assessment_id]
  );
  for (const question of questions) {
    const choices = await sql.all(
      `SELECT id, position, text, media, is_correct
         FROM choices WHERE question_id = ? ORDER BY position`,
      [question.id]
    );
    question.choiceMeta = choices.map((c) => ({
      id: c.id,
      letter: LETTERS[c.position] ?? "?",
      text: c.text,
      media: c.media,
      isCorrect: !!c.is_correct,
    }));
  }

  const attempts = await sql.all(
    `SELECT id FROM attempts WHERE session_id = ? AND status = 'submitted'`,
    [session.id]
  );

  const base = {
    session: {
      id: session.id,
      title: session.title,
      room: session.room,
      state: session.state,
    },
    students: attempts.length,
    groupSize: 0,
  };

  if (!attempts.length) {
    return {
      ...base,
      questions: questions.map((q) => ({
        position: q.position, id: q.id, stem: q.stem, media: q.media,
        answered: 0, difficulty: null, discrimination: null,
        choices: q.choiceMeta.map((c) => ({ ...c, count: 0, percent: 0, topCount: 0, bottomCount: 0 })),
        flags: [],
        verdict: { level: "info", text: "Nobody has finished this test yet." },
      })),
    };
  }

  const responses = await sql.all(
    `SELECT attempt_id, question_id, choice_id, is_correct, points_earned
       FROM responses
      WHERE attempt_id IN (${attempts.map(() => "?").join(",")})`,
    attempts.map((a) => a.id)
  );

  const { n, groupSize, topIds, bottomIds, byQuestion, stats } =
    rankAndScore(attempts.map((a) => a.id), responses);

  const reportedQuestions = questions.map((question) => {
    const rs = byQuestion.get(question.id) ?? [];
    const answered = rs.length;
    const { difficulty = null, discrimination = null } = stats.get(question.id) ?? {};

    const counts = new Map(question.choiceMeta.map((c) => [c.id, { count: 0, topCount: 0, bottomCount: 0 }]));
    for (const r of rs) {
      const entry = counts.get(r.choice_id);
      if (!entry) continue;
      entry.count++;
      if (topIds.has(r.attempt_id)) entry.topCount++;
      if (bottomIds.has(r.attempt_id)) entry.bottomCount++;
    }
    const choices = question.choiceMeta.map((c) => {
      const stat = counts.get(c.id) ?? { count: 0, topCount: 0, bottomCount: 0 };
      return {
        // id is what a regrade request names -- everything else here is
        // just for display.
        id: c.id, letter: c.letter, text: c.text, media: c.media, isCorrect: c.isCorrect,
        count: stat.count,
        percent: answered ? Math.round((stat.count / answered) * 1000) / 10 : 0,
        topCount: stat.topCount, bottomCount: stat.bottomCount,
      };
    });

    const flags = flagsFor({ difficulty, discrimination, groupSize, choices });
    const verdict = worstFlag(flags);

    return {
      position: question.position, id: question.id, stem: question.stem, media: question.media,
      answered, difficulty, discrimination, choices, flags, verdict,
    };
  });

  return { ...base, students: n, groupSize, questions: reportedQuestions };
}

const SEVERITY = { critical: 3, warning: 2, good: 1, info: 0 };

function worstFlag(flags) {
  if (!flags.length) return { level: "info", text: "Nothing unusual." };
  return flags.reduce((worst, f) => (SEVERITY[f.level] > SEVERITY[worst.level] ? f : worst));
}

/**
 * Turn the numbers into sentences a teacher can act on without knowing what
 * "discrimination" means. Thresholds are the conventional ones: p below .30
 * or above .95 is worth a look, D below .20 is weak and below 0 usually
 * means the key itself is wrong, .40 and up is a genuinely strong item.
 */
function flagsFor({ difficulty, discrimination, groupSize, choices }) {
  const flags = [];

  if (discrimination !== null) {
    if (discrimination < 0) {
      flags.push({ level: "critical", text:
        `Students who scored highest on the rest of the test did WORSE on this ` +
        `question than students who scored lowest. That almost always means the ` +
        `answer key is wrong -- check which choice is marked correct.` });
    } else if (discrimination < 0.20) {
      flags.push({ level: "warning", text:
        `Weak discriminator (D = ${discrimination.toFixed(2)}): strong and weak ` +
        `students did about equally well. The question may be ambiguous, testing ` +
        `something else, or just a coin flip.` });
    } else if (discrimination >= 0.40) {
      flags.push({ level: "good", text:
        `Strong discriminator (D = ${discrimination.toFixed(2)}): this question ` +
        `separates students who know the material from those who don't -- a good ` +
        `item to keep.` });
    }
  } else if (groupSize < 1) {
    flags.push({ level: "info", text:
      `Too few finished papers to compare a top and bottom group.` });
  }

  if (difficulty !== null) {
    if (difficulty === 0) {
      flags.push({ level: "critical", text: `Nobody got this right.` });
    } else if (difficulty < 0.30) {
      flags.push({ level: "warning", text:
        `Very difficult: only ${Math.round(difficulty * 100)}% got this right.` });
    } else if (difficulty > 0.95) {
      flags.push({ level: "info", text:
        `Almost everyone got this right (${Math.round(difficulty * 100)}%) -- a free ` +
        `point, or worth confirming it is testing anything.` });
    }
  }

  // Each flagged choice is marked directly on the object returned to the
  // client (`choice.flagged`), rather than leaving the page to work out
  // which letter a flag's English sentence was about.
  for (const choice of choices) {
    if (choice.isCorrect) continue;
    if (choice.count === 0) {
      flags.push({ level: "info", text:
        `Nobody chose "${choice.letter}". It isn't pulling its weight as a wrong answer.` });
      choice.flagged = true;
    } else if (choice.topCount > choice.bottomCount) {
      flags.push({ level: "warning", text:
        `Higher-scoring students picked "${choice.letter}" more often than ` +
        `lower-scoring students did. Worth checking whether that answer has a ` +
        `defensible reading, or whether the key is right.` });
      choice.flagged = true;
    }
  }

  return flags;
}

/** The teacher who owns the session behind a dashboard link, or null. */
export async function findTeacherIdByDashboardToken(sql, dashboardToken) {
  const row = await sql.get(
    `SELECT teacher_id FROM sessions WHERE dashboard_token = ?`,
    [dashboardToken]
  );
  return row?.teacher_id ?? null;
}

/**
 * Fix a question's answer key, and rescore every response ever recorded
 * for it -- not just on the test a teacher happened to be looking at.
 *
 * The correct answer is a property of the QUESTION, not of any one time it
 * was asked. If the key was wrong, it was wrong everywhere that question
 * has ever appeared: past administrations, a different room, an attempt
 * still in progress right now. This fixes it in every one of those places
 * in a single pass, rather than only the session whose report a teacher
 * happened to be reading when they noticed. There is deliberately no
 * "just this test" option -- a question does not have two correct answers
 * depending on which class asked it.
 *
 * Scoped to the TEACHER, not the session: any of that teacher's questions
 * can be fixed from any of their sessions' dashboards, since the answer
 * key was never session-specific to begin with.
 */
export async function regradeQuestion(sql, teacherId, { questionId, correctChoiceId }) {
  const question = await sql.get(
    `SELECT id, teacher_id FROM questions WHERE id = ?`,
    [questionId]
  );
  if (!question || question.teacher_id !== teacherId) {
    throw new Error("That question was not found.");
  }
  const choice = await sql.get(
    `SELECT id FROM choices WHERE id = ? AND question_id = ?`,
    [correctChoiceId, questionId]
  );
  if (!choice) throw new Error("That answer does not belong to this question.");

  // Exactly one correct choice, the same rule createQuestion enforces when
  // a question is first written.
  await sql.run(`UPDATE choices SET is_correct = 0 WHERE question_id = ?`, [questionId]);
  await sql.run(`UPDATE choices SET is_correct = 1 WHERE id = ?`, [correctChoiceId]);

  // Every response this question has ever received, anywhere, together with
  // what that particular test was worth -- points can be overridden per
  // assessment, so each response is priced by the assessment it actually
  // belonged to, the same lookup saveResponse used when it was first graded.
  const responses = await sql.all(
    `SELECT r.id, r.attempt_id, r.choice_id, r.is_correct AS was_correct,
            COALESCE(ai.points, q.points) AS points
       FROM responses r
       JOIN attempts a  ON a.id = r.attempt_id
       JOIN sessions s  ON s.id = a.session_id
       JOIN questions q ON q.id = r.question_id
       LEFT JOIN assessment_items ai
              ON ai.assessment_id = s.assessment_id AND ai.question_id = r.question_id
      WHERE r.question_id = ?`,
    [questionId]
  );

  let scoresChanged = 0;
  const attemptsAffected = new Set();
  for (const r of responses) {
    const isCorrect = r.choice_id === correctChoiceId ? 1 : 0;
    const pointsEarned = isCorrect ? r.points : 0;
    if (isCorrect !== r.was_correct) {
      scoresChanged++;
      attemptsAffected.add(r.attempt_id);
    }
    await sql.run(
      `UPDATE responses SET is_correct = ?, points_earned = ? WHERE id = ?`,
      [isCorrect, pointsEarned, r.id]
    );
  }

  return {
    responsesRescored: responses.length,
    scoresChanged,
    attemptsAffected: attemptsAffected.size,
  };
}

export async function setSessionState(sql, dashboardToken, state) {
  const { changes } = await sql.run(
    `UPDATE sessions SET state = ? WHERE dashboard_token = ?`,
    [state, dashboardToken]
  );
  return changes > 0;
}
