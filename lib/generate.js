/**
 * AI category generation.
 *
 * One call produces one category: a title plus five clues in rising difficulty.
 * Which model answers is configuration, never a game decision — nothing in the
 * UI picks a model, and the host only ever sees which one is in use.
 *
 * Selection is automatic: whichever provider has credentials. Set AI_PROVIDER to
 * force one when both do.
 */

import {
  GenerationError,
  GeneratedCategory,
  SYSTEM,
  buildPrompt,
  toCategory,
} from "./ai/shared.js";
import * as anthropic from "./ai/anthropic.js";
import * as openrouter from "./ai/openrouter.js";
import { CLUE_VALUES } from "./board.js";

export { GenerationError };

const PROVIDERS = [anthropic, openrouter];

/**
 * Picks the provider to use, or null if none is configured.
 *
 * Anthropic wins a tie because it is the better default for factual trivia;
 * AI_PROVIDER overrides that, and the host screen always names which is active
 * so the choice is never a mystery.
 */
export function activeProvider() {
  const forced = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (forced) {
    const match = PROVIDERS.find((p) => p.id === forced);
    if (!match) {
      throw new GenerationError(
        `AI_PROVIDER is set to "${forced}", which is not one of: ` +
          PROVIDERS.map((p) => p.id).join(", "),
      );
    }
    return match;
  }
  return PROVIDERS.find((p) => p.available()) ?? null;
}

export function hasCredentials() {
  try {
    const provider = activeProvider();
    return Boolean(provider && provider.available());
  } catch {
    return false;
  }
}

/** Human-readable name of the active provider, for the host screen. */
export function providerLabel() {
  try {
    return activeProvider()?.label() ?? null;
  } catch {
    return null;
  }
}

/**
 * Generates one category for `theme`.
 *
 * @param {string} theme           What the host typed, e.g. "Pokemon".
 * @param {string[]} avoidAnswers  Answers already used elsewhere on the board.
 */
export async function generateCategory(theme, avoidAnswers = []) {
  const topic = String(theme ?? "").trim();
  if (!topic) throw new GenerationError("Give the category a theme first.");
  if (topic.length > 120) throw new GenerationError("That theme is too long.");

  const provider = activeProvider();
  if (!provider) {
    throw new GenerationError(
      "No AI provider is configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY and restart the server — or write this category yourself.",
    );
  }

  const prompt = buildPrompt(topic, avoidAnswers);

  // Two attempts. Schema compliance is guaranteed by some endpoints and merely
  // likely on others, so a malformed reply is a retry rather than a failure.
  let lastProblem = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await provider.generate({ system: SYSTEM, prompt });

    const parsed = GeneratedCategory.safeParse(raw);
    if (!parsed.success) {
      lastProblem = describeIssue(parsed.error);
      continue;
    }
    if (parsed.data.clues.length !== CLUE_VALUES.length) {
      lastProblem = `it returned ${parsed.data.clues.length} clues instead of ${CLUE_VALUES.length}`;
      continue;
    }
    return toCategory(parsed.data);
  }

  throw new GenerationError(
    `${provider.label()} did not return a usable category (${lastProblem}). Try again, or write this one yourself.`,
  );
}

function describeIssue(error) {
  const first = error.issues?.[0];
  if (!first) return "the reply did not match the expected shape";
  const where = first.path.join(".") || "the reply";
  return `${where}: ${first.message}`;
}
