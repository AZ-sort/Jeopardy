/**
 * OpenRouter adapter.
 *
 * Plain fetch rather than an SDK: this is a single POST with a JSON body, and
 * one fewer dependency is one fewer version to track.
 *
 * `provider: { require_parameters: true }` matters. The same model is often
 * served by several upstream providers and only some of them implement
 * structured outputs; without this the request can be routed to one that
 * silently ignores `response_format`.
 */

import { GenerationError, categoryJsonSchema, parseJsonLoosely } from "./shared.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Overridable so a proxy or gateway can stand in - and so tests can too. */
function endpoint() {
  const base = process.env.OPENROUTER_BASE_URL?.trim().replace(/\/$/, "") || DEFAULT_BASE_URL;
  return base + "/chat/completions";
}

/** Chosen for factual accuracy per dollar, which is what trivia needs. */
const DEFAULT_MODEL = "google/gemini-3.8-flash";

export const id = "openrouter";

export function model() {
  return process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
}

export function available() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export function label() {
  return `OpenRouter (${model()})`;
}

export async function generate({ system, prompt }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new GenerationError(
      "No OpenRouter API key found. Stop the server, set OPENROUTER_API_KEY, and start it again — or write this category yourself.",
    );
  }

  let res;
  try {
    res = await fetch(endpoint(), {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        // Optional attribution headers OpenRouter uses for its app listings.
        "HTTP-Referer": "http://localhost",
        "X-Title": "Buzz Night",
      },
      body: JSON.stringify({
        model: model(),
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        max_tokens: 2000,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "jeopardy_category",
            strict: true,
            schema: categoryJsonSchema(),
          },
        },
        // Only route to endpoints that actually implement response_format.
        provider: { require_parameters: true },
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new GenerationError("OpenRouter took too long to answer. Try again.");
    }
    throw new GenerationError("Could not reach OpenRouter. Check your internet connection.");
  }

  if (!res.ok) throw new GenerationError(await describeFailure(res));

  let body;
  try {
    body = await res.json();
  } catch {
    throw new GenerationError("OpenRouter sent a reply that was not JSON. Try again.");
  }

  // OpenRouter can return a 200 whose body carries an error (e.g. a mid-stream
  // upstream failure), so the status alone is not enough.
  if (body.error) {
    throw new GenerationError("OpenRouter error: " + (body.error.message ?? "unknown"));
  }

  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new GenerationError("The model's reply was cut off. Try again.");
  }

  const content = choice?.message?.content;
  if (!content) {
    throw new GenerationError("OpenRouter returned an empty reply. Try again.");
  }

  try {
    return parseJsonLoosely(content);
  } catch {
    throw new GenerationError(
      `${model()} did not return valid JSON. Try again, or set OPENROUTER_MODEL to a model that supports structured outputs.`,
    );
  }
}

async function describeFailure(res) {
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.error?.message ?? "";
  } catch {
    /* some failures have no JSON body */
  }

  switch (res.status) {
    case 401:
      return "OpenRouter rejected the API key. Check OPENROUTER_API_KEY.";
    case 402:
      return "Your OpenRouter account is out of credit.";
    case 404:
      return `OpenRouter does not know the model "${model()}". Check OPENROUTER_MODEL.`;
    case 429:
      return "Rate limited by OpenRouter. Wait a moment and try again.";
    default:
      return (
        `OpenRouter returned ${res.status}` + (detail ? ": " + detail : ".")
      );
  }
}
