/**
 * Everything about category generation that does not depend on which provider
 * answers: the prompt, the schema, and the conversion into a board category.
 *
 * Both adapters return a plain object and `lib/generate.js` validates it here,
 * so a provider that ignores the schema fails the same way as one that honours
 * it. OpenRouter's own docs say exact schema compliance is not guaranteed on
 * every endpoint, which makes that validation load-bearing rather than belt-
 * and-braces.
 */

import { z } from "zod";

import { CLUE_VALUES } from "../board.js";

/** Raised for problems worth showing the host verbatim. */
export class GenerationError extends Error {}

/**
 * What we ask for. Note the absence of dollar values — the caller assigns those
 * by position, so no model can mis-order them.
 */
export const GeneratedCategory = z.object({
  title: z
    .string()
    .describe("The category name, in Jeopardy style. Short — at most 24 characters."),
  clues: z
    .array(
      z.object({
        clue: z
          .string()
          .describe(
            "The clue, phrased as a statement the way Jeopardy does it. Never a question.",
          ),
        answer: z
          .string()
          .describe(
            "The correct response, as a bare noun phrase without the 'What is' wrapper.",
          ),
      }),
    )
    .describe("Exactly five clues, ordered from easiest to hardest."),
});

/**
 * The same schema as plain JSON Schema, for providers that take one directly.
 *
 * `$schema` is stripped because strict structured-output modes reject unknown
 * top-level keys.
 */
export function categoryJsonSchema() {
  const schema = z.toJSONSchema(GeneratedCategory);
  delete schema.$schema;
  return schema;
}

export const SYSTEM = `You write categories for a Jeopardy-style party game played among friends.

Rules you must follow:

1. Return EXACTLY five clues, ordered easiest first and hardest last.
2. Write clues as STATEMENTS, the way the real show does. The clue is the
   statement; the answer is what the contestant names.
   Good: "This Kanto starter evolves into Charizard." -> "Charmander"
   Bad:  "Which Pokemon evolves into Charizard?"
3. Calibrate the difficulty curve for a casual fan, not a superfan:
   - Clue 1 should be gettable by anyone with passing familiarity.
   - Clue 3 should need real knowledge of the topic.
   - Clue 5 should be genuinely hard but still fair — never obscure trivia that
     only a wiki-reader would know.
4. Every clue must have ONE unambiguous correct answer. If a clue could be
   answered two defensible ways, rewrite it.
5. No two clues in a category may share an answer.
6. Only state facts you are confident are true. A wrong clue ruins the game.
   If you are unsure about a detail, pick a different clue rather than guessing.
7. Keep clues to one sentence where you can. These get read aloud.

Reply with JSON only. No commentary, no markdown fences.`;

export function buildPrompt(topic, avoidAnswers = []) {
  let prompt = `Write a Jeopardy category about: ${topic}`;
  if (avoidAnswers.length) {
    prompt +=
      `\n\nThese answers are already used elsewhere on this board — do not reuse any of them:\n` +
      avoidAnswers.slice(0, 60).map((a) => `- ${a}`).join("\n");
  }
  return prompt;
}

/** Turns a validated model response into a board category. */
export function toCategory(parsed) {
  return {
    title: parsed.title.trim().slice(0, 40),
    clues: parsed.clues.map((c, i) => ({
      value: CLUE_VALUES[i],
      clue: c.clue.trim(),
      answer: c.answer.trim(),
      revealed: false,
      wager: null,
      dailyDouble: false,
    })),
  };
}

/**
 * Some models wrap JSON in a markdown fence even when asked not to. Cheap to
 * tolerate, and the alternative is a failed generation over punctuation.
 */
export function parseJsonLoosely(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}
