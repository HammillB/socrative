# Classroom testing platform

A self-hosted replacement for Socrative, for multiple-choice science tests.

Students join with a class code and their student number, take the test on a
Chromebook, and it grades itself. Everything runs on your own database.

Students are served **one question at a time**. They pick a letter, submit,
and are told straight away whether they were right — with the correct answer
and an explanation when they were not. Answers are final and there is no
going back.

**Status: Phase 2, in progress.** The student side works end to end and the
teacher's live results board is running. Tests are still set up from the
command line; authoring and sign-in are next.

---

## What you need

Node.js 22.5 or newer — that is when SQLite became part of Node itself, which
is why this project has no database to install and nothing to compile. Check
with:

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

The import command also prints a **live board** link. Open it on your own
screen during a test:

```
6 of 6 joined · 1 handed in

Student                 Correct   1    2    3    4    5
Bell, Aurora    ON Q17    100%   ✓A   ✓B   ·    ✓A   ✓D
Chen, George    ON Q12     75%   ✓A   ✕E   ·    ✓A   ·
6  Class Total                   100% 50%  —    100% 100%
```

Green is right, red is wrong, and the letter shown is the answer's **original**
letter. Every student's paper is shuffled, so a choice sits somewhere different
on each screen — the board undoes that, so a column reads straight down and
thirty students who picked the same wrong answer all show the same letter.

A question the class is failing in real time gets its column highlighted, which
is worth knowing before the period ends rather than at marking.

`Names`, `Answers` and `Right / wrong` toggle independently, so the board can be
projected without giving away the key. **The board link contains the answer key
— keep it to yourself.** The class code will not open it.

---

## How it is built

Two rules shape most of the code.

**Every table carries `teacher_id`, and every query filters on it.** Two
teachers share this database and must never see each other's questions.
Retrofitting that later would mean revisiting every query and hoping none was
missed — so it is there from the first line of schema.

**All the SQL lives in `src/db.js`.** The app is handed a driver rather than
opening a database itself, and there are two drivers: Node's built-in SQLite
for a local file and Cloudflare D1 for production. The SQL is identical, so
moving between them is a deploy change, not a rewrite.

```
schema.sql          the whole data model, with the reasoning in comments
src/db.js           every SQL statement in the application
src/app.js          routes, seeded shuffling, paper assembly
src/dev-server.js   local Node server (the D1 entry point is still to come)
scripts/init.js     create the database, add a teacher
scripts/import.js   load a roster, load a quiz, open a session
scripts/e2e-test.js the test suite
scripts/demo-class.js  drive a fake class through a test
web/test.html       the student test page
web/live.html       the teacher's live results board
```

### Things worth knowing

**One question at a time, enforced by the server.** The browser is never told
which question a student is on; the server works it out from how many they
have answered. Answering anything other than the current question is refused,
so neither going back nor skipping ahead is possible however the page is
tampered with. A rule the browser enforces is not a rule.

**Only one question is ever sent.** The whole paper is never in the browser,
so a student who reads the network traffic still cannot read ahead.

**Answers are graded and final as they are submitted.** Answering the last
question ends the test by itself — there is no hand-in step to forget, and no
way to leave a paper unsubmitted.

**A dead device loses nothing.** The position lives on the server, so a
student logs back in — on that Chromebook or any other — and lands on the
question they had reached, with everything before it recorded.

**The trade-off worth knowing:** because the next question comes from the
server, a student cannot advance while the network is down. The page retries
and keeps their selection, but they wait. An open-navigation test could cache
the whole paper and carry on offline; a locked sequential one cannot. That is
the cost of the mode, not a defect in it.

**Correct answers never reach the browser before they are earned.** What a
student is sent contains no `isCorrect` anywhere — checking the page source
finds nothing. The right answer arrives only in the reply to their own
answer, once it is already committed.

**Feedback names the letter the student saw.** Choices are shuffled per
student, so the correct answer sits in a different position on every screen.
Telling a student "the answer was B" when B was something else on their own
page would be worse than saying nothing, so the letter is translated into
their shuffled order before it is sent.

**Explanations come from the spreadsheet.** Socrative's PDF export does not
contain them, so the converter cannot either. Add an `Explanation` column to
the CSV before importing and it is shown to students after they answer; the
importer reports how many questions still have none.

**Each attempt stores a `seed`** that determines question order, choice order
and which family sibling the student saw. Their exact paper can be rebuilt
months later when someone asks.

**"All of the above" is never shuffled.** Choices that refer to one another
are detected and left in place, and the importer tells you which questions
those are. Socrative will happily shuffle them into nonsense.

**There is no password column.** Teachers sign in with their school Google
account (Phase 2), so there are no credentials stored here to leak or reset.
Until then the live board is reached by an unguessable per-session link.

**No native dependencies.** SQLite comes from Node itself, so `npm install`
pulls two small pure-JavaScript packages and there is nothing to rebuild when
Node updates.

## Tests

```bash
npm run dev      # in one terminal
npm test         # in another
```

34 checks covering the student flow and the board, including the ones that
would be expensive to get wrong: that a dead device resumes on the right
question, that going back and skipping ahead are refused by the server, that
feedback names the letter the student actually saw, and that a shuffled paper
still maps to the right canonical letter on the teacher's grid.

`node scripts/demo-class.js` drives a fake class through a test if you want
something to look at on the board.

## Next

Question authoring in the browser, Google sign-in for teachers, CSV export for
the gradebook, regrade-a-question, and the Cloudflare entry point.

Then the features that are the actual reason for building this: item analysis
after every test, standards mastery across the year, automatic accommodations,
and retakes generated from what each student missed.
