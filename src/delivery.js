/**
 * Launch settings: what the teacher chooses when they start a test.
 *
 * These belong to a session rather than to a quiz, so the same questions can
 * run locked for a graded test on Tuesday and open for a review on Wednesday
 * without being imported twice. They are frozen onto the session at launch,
 * so nothing a student is part-way through can change under them.
 *
 * Students are never asked and never told there was a choice: the page simply
 * behaves the way the session says.
 */

export const MODES = ["sequential", "open"];

export const MODE_DESCRIPTIONS = {
  sequential:
    "One question at a time, answers final, no going back. Right or wrong is " +
    "shown after each answer, and the last answer ends the test.",
  open:
    "One question at a time, but Back and Next to move about. Answers can be " +
    "changed, and the test is handed in at the end once nothing is blank.",
};

export function launchSettings({
  mode = "sequential",
  shuffleQuestions = true,
  shuffleChoices = true,
  showFinalScore = false,
  showQuestionFeedback = null,
} = {}) {
  if (!MODES.includes(mode)) {
    throw new Error(`mode must be one of: ${MODES.join(", ")}`);
  }

  // Per-question feedback only makes sense when a student cannot go back. In
  // open navigation, a student shown right or wrong would simply change their
  // answer, which is not a test -- so it is forced off rather than offered.
  const feedback = mode === "sequential"
    ? (showQuestionFeedback ?? true)
    : false;

  return {
    delivery: mode,
    shuffle_questions: !!shuffleQuestions,
    shuffle_choices: !!shuffleChoices,
    show_question_feedback: feedback,
    show_final_score: !!showFinalScore,
  };
}

/** A short line for the terminal, so the teacher can see what they launched. */
export function describeSettings(settings) {
  const lines = [MODE_DESCRIPTIONS[settings.delivery] ?? settings.delivery];
  const on = [];
  if (settings.shuffle_questions) on.push("questions shuffled");
  if (settings.shuffle_choices) on.push("answers shuffled");
  if (settings.show_final_score) on.push("final score shown");
  if (on.length) lines.push(on.join(", "));
  return lines;
}
