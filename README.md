# Classroom testing platform

A self-hosted replacement for Socrative, for multiple-choice science tests.

**Students always type the same two things: their room name and their student
number.** The room name never changes. What test sits behind it is entirely
the teacher's choice, launched and closed from the launch screen — there is
nothing new to read off the board each time.

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

## Item analysis

Difficulty and discrimination, computed after each test -- the reason this
project exists rather than staying on Socrative. Open the live board and
click **Item Analysis**, or follow the Report link from a past test.

```
25 questions · 0 flagged for review · 3 papers completed

 3  Absolute zero happens when                    Difficulty 33%  Discrimination +1.00
    A  all particles stop moving        Correct     1   33%   top 1   bottom 0
    B  water freezes                                1   33%   top 0   bottom 0
    C  we reach a vacuum                            1   33%   top 0   bottom 1
    D  coldest temperature recorded ...             0    0%   top 0   bottom 0   -- nobody picked this
    E  There is no absolute zero                    0    0%   top 0   bottom 0   -- nobody picked this
```

The method is the textbook one, unchanged since Kelley (1939): rank
students who **completed** the test by total score, take the top and bottom
~27% as the two groups likeliest to actually separate a good item from a
bad one, and compare how each group did on every question.

  * **Difficulty (p)** -- the fraction of students who got it right, over
    everyone who finished. Below 30% or above 95% gets a note.
  * **Discrimination (D)** -- how much better the top group did on this
    question than the bottom group. Negative is the flag that matters most:
    it means students who did well on the rest of the test did *worse* on
    this one, which is usually a wrong answer key, not a bad question.
  * **Distractors** -- how many students picked each wrong answer, broken
    out by group. A distractor nobody picked isn't pulling its weight. A
    distractor the *top* group preferred over the bottom group is the other
    real warning sign -- it can mean the "wrong" answer has a defensible
    reading, or that the key is wrong.

**Discrimination is also on the live board itself**, as a row underneath
Class Total -- one number per question, no click required:

```
Student                 Correct   1    2    3    4    5
6  Class Total                   67%  33%  67%  67%  67%
   Discrimination         top/bottom 1 of 3
                          +1.00 +1.00 +1.00 +1.00 +1.00
```

It is the exact same number as the full report -- both are computed by one
shared function, so the two screens cannot quietly disagree. It stays "--"
until at least two students have completed the test, since discrimination
needs a top and a bottom group to compare. A negative value turns red: the
one signal worth catching without opening the report at all. Difficulty and
the distractor breakdown are still report-only, since a 25-column strip has
no room for either.

Reached by the same dashboard link as the live board -- there's nothing in
a report that isn't already in that grid, so it needs no separate secret.
Scoped to one **administration**, not a quiz: the same quiz launched locked
for a graded test and open for a review the next day gets two separate
reports, because the students and their answers are different each time.

## Fixing a wrong answer key

Every choice row in the item analysis report has a **Mark correct** button.
Click it, confirm, and two things happen: the question's key changes, and
every response ever recorded for it is rescored against the new key --
right now, not just for whoever takes the test next.

```
A  0                               1   9%    top 0   bottom 1
B  32                    Correct  10  91%    top 5   bottom 4  [Mark correct]
C  212                             0   0%    top 0   bottom 0  [Mark correct]
...
Fixed. 11 responses rescored, 6 of them changed right/wrong for 6 students.
```

**This is global, on purpose, with no "just this test" option.** The correct
answer is a property of the *question*, not of the one time it happened to
be asked. If a key was wrong, it was wrong every time that question has ever
appeared -- a different room, a past administration, an attempt still in
progress right now -- and this fixes every one of those in a single pass
rather than leaving old attempts quietly sitting on the wrong answer. It is
the reason this exists at all: Socrative has no equivalent, so a wrong key
found after the fact used to mean manually re-grading by hand or leaving it
wrong.

Reached through the same dashboard link as the rest of the report -- there
is no separate sign-in for it, only a confirmation naming the choice before
anything changes.

## Launching a test

Import puts the questions in; **launch** decides how a particular run behaves.
`npm run init` prints a link to your launch screen: pick a quiz, pick a
delivery method, set the toggles, and it starts running in that room — with a
link to the live board.

Opens on a start screen, not straight into a quiz list -- one tile, **Quiz**,
since that is the only kind of activity this builds (no Space Race, no Exit
Ticket, no Quick Question; Socrative has all three, this deliberately does
not). Switching rooms in the top-right corner always returns here first.

Pick the room at the top, choose a quiz, then set how it runs:

```
Launch Quiz in INTSCIA3                          [ INTSCIA3  v ]

  WHICH QUIZ?           search…
  NAME                                            MODIFIED
  heat_test              25 questions          2 minutes ago
  Momentum test          18 questions              4 days ago

  ─── then ───────────────────────────────────────────────────

  DELIVERY METHOD                 SETTINGS
  (•) Instant Feedback            Shuffle Questions        [on ]
      Answers in order, final.    Shuffle Answers          [on ]
      Right or wrong after each.  Show Question Feedback   [on ]
  ( ) Open Navigation             Show Final Score         [off]
      Back and Next, changeable.
      Hand in at the end.                        [ Launch ]
```

There is no per-test code to hand out. Students type **INTSCIA3** today and
**INTSCIA3** next month; you decide what that means.

**A room runs one test at a time.** If a test is already open in the room you
picked, the quiz list is put away and the screen offers the two things worth
doing instead: open its live board, or close it. Two live codes for one class
is how half a period ends up in the wrong test.

Everything is also available from the command line:

```bash
node scripts/launch.js --teacher you@school.org            # list your quizzes
node scripts/launch.js --teacher you@school.org --quiz 1 --section INTSCIA3 --mode open
```

Also takes `--no-shuffle`, `--no-shuffle-answers`, `--show-score` and
`--no-feedback`. Settings are frozen onto the session at launch, so changing a
quiz later cannot alter a test a class is part-way through.

## Running it

```bash
npm run dev
```

Then open <http://localhost:8787> and enter the room name and a student number
from that room's roster.

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

**Finish Activity** closes the test for the whole room: nobody can join, and
anyone still mid-test is stopped at their next request with "Your teacher has
closed this test." It is the one irreversible control on this page, so it
confirms first, naming how many students are still working if any are. Once
finished, Pause and Finish give way to a plain **Finished** badge and the grid
stays up for review.

`Names`, `Answers` and `Right / wrong` toggle independently, so the board can
be projected without giving away the key. **Score Display** picks what the
score column shows -- three views of a student's test that can genuinely
disagree with each other:

  * **Progress** -- how much of the test they have gotten through, right or
    wrong. A student stalled on question 3 and one cruising through wrong
    answers can both show 100% correct at some point; progress is the field
    that tells them apart.
  * **Score %** -- accuracy on what they have answered so far.
  * **Score #** -- a running points total against the whole test, e.g. 18/25.
    Useful the moment any question is worth more than one point. **The board link contains the answer key
— keep it to yourself.** The room name will not open it.

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
web/launch.html     the teacher's launch screen
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

**A room is the front door; the test behind it is swappable.** Students
resolve a room name to whatever that room is currently running. Room names are
unique across the whole install and matched without regard to case, because
they are what students type.

**A test belongs to a room, and the roster gates it.** A student whose number
is not on that room's roster cannot join even knowing the room name —
otherwise knowing a room would be enough to sit another class's test.

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
account (still to come), so there are no credentials stored here to leak or
reset. Until then the launch screen and the live board are each reached by an
unguessable link — those links are the credential, so treat them like one.

**Two settings are deliberately missing from the launch screen.** Socrative
offers *Require Names* and *One Attempt*; here both are always on and cannot
be switched off, because students sign in with their number from your roster
and a session allows one attempt each. A toggle that cannot do anything is
worse than no toggle.

**No native dependencies.** SQLite comes from Node itself, so `npm install`
pulls two small pure-JavaScript packages and there is nothing to rebuild when
Node updates.

## Trying it with a realistic class

```bash
node scripts/demo-class.js
```

Fills whichever rooms are currently open (`INTSCIA3` and `INTSCIA4` by
default) with a class that looks like a real one instead of an empty grid or
a contrived edge case: two students finished with a solid score, one
finished but struggled, two still mid-test at different points, one who has
not shown up. Accuracy is randomised per question rather than scripted, so
the live board's Discrimination row and the Item Analysis report see the
kind of variation a real class produces -- including, some runs, a genuinely
negative discrimination worth looking at. Safe to re-run: it clears only the
attempts it is about to recreate.

## Tests

```bash
npm run dev      # in one terminal
npm test         # in another
```

103 checks covering both delivery modes, the launch console and the board, including the ones that
would be expensive to get wrong: that a dead device resumes in the right
place, that going back and skipping ahead are refused by the server in
sequential mode, that an open test cannot be handed in with blanks, that
feedback names the letter the student actually saw, that a shuffled paper
still maps to the right canonical letter on the teacher's grid, that points
and progress hold up against an independent recomputation, that Finish
Activity actually locks everyone out rather than just looking like it does,
and that difficulty and discrimination match numbers worked out by hand for
three students with fully controlled, opposite performance.

The suite expects a test running in each of two rooms — a sequential one in
`INTSCIA3` and an open one in `INTSCIA4`, since a room runs one at a time. It
reopens them itself if you closed them, and prints the commands to create them
if they are missing.

`node scripts/demo-class.js` drives a fake class through a test if you want
something to look at on the board.

## Next

Question authoring in the browser, Google sign-in for teachers, CSV export for
the gradebook, regrade-a-question, and the Cloudflare entry point.

Then the features that are the actual reason for building this: item analysis
after every test, standards mastery across the year, automatic accommodations,
and retakes generated from what each student missed.
