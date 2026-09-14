# Classroom testing platform

A self-hosted replacement for Socrative, for multiple-choice science tests.

Students join with a class code and their student number, take the test on a
Chromebook, and it grades itself. Everything runs on your own database.

Students always see **one question at a time**. Two delivery modes decide what
they can do with it:

| | Sequential | Open navigation |
|---|---|---|
| Moving about | forward only | Back and Next |
| Changing an answer | no | yes, until they hand in |
| Right/wrong after each | yes, with the answer and why | no |
| Finishing | the last answer ends it | Hand in, blocked while anything is blank |

**The teacher chooses the mode when launching a test, not when writing it.**
Students are never asked and never told there was a choice — the page simply
behaves the way the session says. So one quiz can run locked for a graded test
on Tuesday and open for a review on Wednesday, without importing the questions
twice.

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

## Running the same quiz again

Import puts the questions in; **launch** decides how a particular run behaves.

```bash
node scripts/launch.js --teacher you@school.org            # list your quizzes
node scripts/launch.js --teacher you@school.org --quiz 1   --section INTSCIA3 --code REVIEW --mode open
```

Also takes `--no-shuffle`, `--no-shuffle-answers`, `--show-score` and
`--no-feedback`. Settings are frozen onto the session at launch, so changing a
quiz later cannot alter a test a class is part-way through.

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
src/delivery.js     launch settings, and what each delivery mode means
scripts/import.js   load a roster, load a quiz, open a session
scripts/launch.js   run an already-imported quiz, in either mode
scripts/e2e-test.js the test suite
scripts/demo-class.js  drive a fake class through a test
web/test.html       the student test page
web/live.html       the teacher's live results board
```

### Things worth knowing

**The sequential lock is enforced by the server.** The browser is never told
which question a student is on; the server works it out from how many they
have answered. Answering anything other than the current question is refused,
so neither going back nor skipping ahead is possible however the page is
tampered with. A rule the browser enforces is not a rule.

**In sequential mode only one question is ever sent.** The whole paper never
reaches the browser, so a student reading the network traffic still cannot
read ahead. Open navigation does send the whole paper — a student may see
every question there anyway — which is what lets that mode keep working
through a dropped connection.

**Handing in is refused while anything is blank**, and the refusal names the
questions and offers to jump to the first one. It is checked in the page so a
student with no connection still gets a useful answer, and again on the server
so it cannot be clicked past.

**Open navigation gives no per-question feedback.** A student who could see
right or wrong before handing in would simply change their answer, so it is
forced off for that mode rather than offered.

**Launch settings live on the session, not the quiz.** How a test behaves is a
property of a particular run, so the same questions can be launched twice with
different rules and neither run changes when the quiz is edited.

**Answers are graded and final as they are submitted.** Answering the last
question ends the test by itself — there is no hand-in step to forget, and no
way to leave a paper unsubmitted.

**A dead device loses nothing.** The position lives on the server, so a
student logs back in — on that Chromebook or any other — and lands on the
question they had reached, with everything before it recorded.

**The trade-off worth knowing:** in sequential mode the next question comes
from the server, so a student cannot advance while the network is down. The
page retries and keeps their selection, but they wait. Open navigation has the
whole paper already and carries on regardless, syncing when the connection
returns. That difference is the cost of locking a test, not a defect in it.

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

53 checks covering both delivery modes and the board, including the ones that
would be expensive to get wrong: that a dead device resumes in the right
place, that going back and skipping ahead are refused by the server in
sequential mode, that an open test cannot be handed in with blanks, that
feedback names the letter the student actually saw, and that a shuffled paper
still maps to the right canonical letter on the teacher's grid.

The suite expects two sessions — a sequential one on `HEAT1` and an open one
on `OPEN1`.

`node scripts/demo-class.js` drives a fake class through a test if you want
something to look at on the board.

## Next

Question authoring in the browser, Google sign-in for teachers, CSV export for
the gradebook, regrade-a-question, and the Cloudflare entry point.

Then the features that are the actual reason for building this: item analysis
after every test, standards mastery across the year, automatic accommodations,
and retakes generated from what each student missed.
