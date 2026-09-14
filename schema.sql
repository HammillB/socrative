-- Schema for the classroom testing platform.
--
-- Two rules run through all of it:
--
--   1. Every table that holds content carries teacher_id, and every query
--      filters on it. Two teachers share this database and must never see
--      each other's questions. Adding this later would mean revisiting every
--      query and hoping none was missed.
--
--   2. Questions are multiple choice with exactly one correct answer. There
--      is no free-text grading anywhere, so a response is always a choice_id
--      and a score is final the moment a student submits.
--
-- Written in the SQL subset that both SQLite and Cloudflare D1 accept, so the
-- same statements run locally and in production.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- people

CREATE TABLE IF NOT EXISTS teachers (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- No password column. Teachers sign in with their school Google account,
-- so there are no credentials here to leak or reset.

CREATE TABLE IF NOT EXISTS sections (
  id          INTEGER PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  period      TEXT
);

CREATE TABLE IF NOT EXISTS students (
  id              INTEGER PRIMARY KEY,
  teacher_id      INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  student_number  TEXT NOT NULL,
  -- Names are deliberately optional. When this runs outside the building,
  -- leave them empty and keep the number-to-name list in a spreadsheet on
  -- your own machine: a copy of this database is then a list of numbers.
  first_name      TEXT,
  last_name       TEXT,
  accommodations  TEXT,             -- JSON: {"extra_time": 1.5, "large_type": true}
  UNIQUE (teacher_id, student_number)
);

CREATE TABLE IF NOT EXISTS enrollments (
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  section_id  INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  PRIMARY KEY (student_id, section_id)
);

-- ------------------------------------------------------------- questions

CREATE TABLE IF NOT EXISTS standards (
  id           INTEGER PRIMARY KEY,
  teacher_id   INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,       -- HS-PS1-1, HS-ESS2-5 ...
  description  TEXT,
  UNIQUE (teacher_id, code)
);

-- A family is a set of interchangeable questions: same standard, same
-- difficulty, same points. Each student's attempt draws one sibling, and a
-- retake draws one they have not already seen. A family of one is just a
-- normal question, so this costs nothing until you use it.
CREATE TABLE IF NOT EXISTS families (
  id          INTEGER PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id                 INTEGER PRIMARY KEY,
  teacher_id         INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  stem               TEXT NOT NULL,
  media              TEXT,          -- image for the question itself
  points             REAL NOT NULL DEFAULT 1,
  standard_id        INTEGER REFERENCES standards(id) ON DELETE SET NULL,
  family_id          INTEGER REFERENCES families(id) ON DELETE SET NULL,
  explanation        TEXT,
  explanation_media  TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS choices (
  id           INTEGER PRIMARY KEY,
  question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  text         TEXT NOT NULL,
  media        TEXT,                -- a choice can be a diagram, not only words
  is_correct   INTEGER NOT NULL DEFAULT 0
);

-- ----------------------------------------------------------- assessments

CREATE TABLE IF NOT EXISTS assessments (
  id          INTEGER PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  settings    TEXT NOT NULL DEFAULT '{}',   -- JSON: shuffle_questions, shuffle_choices, ...
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assessment_items (
  assessment_id  INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  points         REAL,                      -- overrides questions.points when set
  PRIMARY KEY (assessment_id, question_id)
);

-- --------------------------------------------------------------- testing

CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY,
  teacher_id     INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  assessment_id  INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  section_id     INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  join_code      TEXT NOT NULL UNIQUE,
  state          TEXT NOT NULL DEFAULT 'open',   -- open | paused | closed
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  -- seed determines this student's question order, choice order and which
  -- family sibling they got, so their exact paper can be reproduced months
  -- later when a parent asks.
  seed          INTEGER NOT NULL,
  token         TEXT NOT NULL UNIQUE,   -- what the browser holds; never the student id
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at  TEXT,
  status        TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress | submitted
  UNIQUE (session_id, student_id)
);

CREATE TABLE IF NOT EXISTS responses (
  id             INTEGER PRIMARY KEY,
  attempt_id     INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  choice_id      INTEGER REFERENCES choices(id) ON DELETE SET NULL,
  is_correct     INTEGER,
  points_earned  REAL,
  answered_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ms_spent       INTEGER,
  UNIQUE (attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,        -- focus_lost | resumed | reconnected
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- indexes

CREATE INDEX IF NOT EXISTS idx_questions_teacher   ON questions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_assessments_teacher ON assessments(teacher_id);
CREATE INDEX IF NOT EXISTS idx_students_teacher    ON students(teacher_id);
CREATE INDEX IF NOT EXISTS idx_sections_teacher    ON sections(teacher_id);
CREATE INDEX IF NOT EXISTS idx_choices_question    ON choices(question_id);
CREATE INDEX IF NOT EXISTS idx_items_assessment    ON assessment_items(assessment_id);
CREATE INDEX IF NOT EXISTS idx_attempts_session    ON attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_responses_attempt   ON responses(attempt_id);
