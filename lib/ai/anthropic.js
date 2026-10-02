/**
 * Anthropic adapter.
 *
 * Uses structured outputs rather than tool use: forced `tool_choice` returns a
 * 400 on Claude Opus 5.5, and a schema-constrained response is the right shape
 * for "always give me exactly this JSON" anyway.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { GenerationError, GeneratedCategory } from "./shared.js";

const MODEL = "claude-opus-5-5";

export const id = "anthropic";

export function model() {
  return process.env.ANTHROPIC_MODEL?.trim() || MODEL;
}

/**
 * A hint, not a guarantee — the SDK resolves credentials from several places.
 * The real answer comes from the first call, which reports auth failures
 * clearly.
 */
export function available() {
  if (
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_PROFILE
  ) {
    return true;
  }
  // An `ant auth login` profile counts: the SDK picks it up with no env var.
  try {
    return existsSync(path.join(homedir(), ".config", "anthropic"));
  } catch {
    return false;
  }
}

export function label() {
  return `Anthropic (${model()})`;
}

let client = null;

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export async function generate({ system, prompt }) {
  let response;
  try {
    response = await getClient().messages.parse({
      model: model(),
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        // Factual accuracy is this feature's main failure mode, and it is one
        // small call per category, so the extra thinking is cheap insurance.
        effort: "high",
        format: zodOutputFormat(GeneratedCategory),
      },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new GenerationError(
        "Claude rejected the API key. Check ANTHROPIC_API_KEY and restart the server.",
      );
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new GenerationError("Rate limited by Claude. Wait a moment and try again.");
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new GenerationError("Could not reach Claude. Check your internet connection.");
    }
    if (err instanceof Anthropic.APIError) {
      throw new GenerationError("Claude returned an error: " + err.message);
    }
    // Missing credentials surface as a plain Error from the SDK's auth
    // resolution, not an APIError - and it is by far the likeliest failure on a
    // first run, so it gets a message that says what to actually do.
    if (/authentication method/i.test(String(err?.message))) {
      throw new GenerationError(
        "No Anthropic API key found. Stop the server, set ANTHROPIC_API_KEY, and start it again — or write this category yourself.",
      );
    }
    throw err;
  }

  if (response.stop_reason === "refusal") {
    throw new GenerationError(
      "Claude declined to write that category. Try a different theme, or write the clues yourself.",
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new GenerationError("Claude's reply was cut off. Try again.");
  }

  return response.parsed_output;
}
