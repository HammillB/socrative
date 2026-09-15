/**
 * Small pure helpers about question content, with no database or server
 * dependency -- kept separate from app.js and db.js specifically so both
 * can import from here without a circular dependency between them.
 */

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
