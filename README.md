# Classroom testing platform

A self-hosted replacement for Socrative, for multiple-choice science tests.

Students join with a class code and their student number, take the test on a
Chromebook, and it grades itself. Everything runs on your own database.

**Status: Phase 1.** The student side works end to end — join, answer, resume
after a dropped connection, hand in, score. The teacher dashboard is Phase 2;
for now tests are set up from the command line.

---

## What you need

Node.js 20 or newer. Check with:

```bash
node --version
```

If that errors, install it from [nodejs.org](https://nodejs.org) (the LTS
build) or run `winget install OpenJS.NodeJS.LTS` on Windows, then open a new
terminal.

## Setup

```bash
npm install
npm run init -- --teacher you@school.org --name "Your Name"
```

That creates `classroom.db` in this folder — one file holding everything.
Copy it to back it up; that is the whole backup procedure.

## Loading a roster and a test

Rosters come straight from Socrative's roster export. Quizzes come from the
PDF converter (`extract_socrative.py`), which turns a Socrative answer-key PDF
into a CSV.

```bash
node scripts/import.js \
  --teacher you@school.org \
  --roster "INTSCIA3.csv" --section INTSCIA3 \
  --quiz "converted/Quiz_Heat Test.csv" \
  --code HEAT1
```

Any question the converter flagged is listed again at the end, so a row you
have not looked at does not quietly become part of a graded test. Questions
with no correct answer marked are refused outright rather than imported
ungradeable.

## Running it

```bash
npm run dev
```

Then open <http://localhost:8787>, enter the class code and a student number
from the roster.

---

## How it is built

Two rules shape most of the code.

**Every table carries `teacher_id`, and every query filters on it.** Two
teachers share this database and must never see each other's questions.
Retrofitting that later would mean revisiting every query and hoping none was
missed — so it is there from the first line of schema.

**All the SQL lives in `src/db.js`.** The app is handed a driver rather than
opening a database itself, and there are two drivers: `better-sqlite3` for a
local file and Cloudflare D1 for production. The SQL is identical, so moving
between them is a deploy change, not a rewrite.

```
schema.sql          the whole data model, with the reasoning in comments
src/db.js           every SQL statement in the application
src/app.js          routes, seeded shuffling, paper assembly
src/dev-server.js   local Node server (the D1 entry point is Phase 2)
scripts/init.js     create the database, add a teacher
scripts/import.js   load a roster, load a quiz, open a session
web/test.html       the student test page
```

### Things worth knowing

**Answers are graded as they are saved, not on submit.** A student whose
battery dies, or who never presses Hand in, still has a scored paper.

**The test page keeps working without a network.** Every answer is written to
the browser's own storage the instant it is picked, then uploaded in the
background; a dropped connection shows a banner and nothing is lost. Reloading
the page resumes where the student was. All images are fetched before the
first question appears, so a diagram is never missing mid-test.

**Correct answers never reach the browser during a test.** The paper sent to a
student contains no `isCorrect` anywhere — checking the page source finds
nothing.

**Each attempt stores a `seed`** that determines question order, choice order
and which family sibling the student saw. Their exact paper can be rebuilt
months later when someone asks.

**"All of the above" is never shuffled.** Choices that refer to one another
are detected and left in place, and the importer tells you which questions
those are. Socrative will happily shuffle them into nonsense.

**There is no password column.** Teachers sign in with their school Google
account (Phase 2), so there are no credentials stored here to leak or reset.

## Next

Phase 2: teacher dashboard and live results grid, sessions you can open and
close from the browser, CSV export, regrade-a-question, and Google sign-in.
