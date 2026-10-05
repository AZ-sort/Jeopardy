/**
 * The host page cannot import `lib/board.js` — it pulls in zod and there is no
 * build step — so it keeps its own copy of the same constants. Nothing else
 * loads `public/js/host.js`, which left the two free to drift apart silently.
 *
 * This reads the host page as text and checks the copies still agree. It is
 * the only thing standing between a careless edit and a round 2 that plays at
 * round 1's values.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ROUND_VALUES, MAX_CATEGORIES, NUM_ROUNDS } from "../lib/board.js";

const hostSource = readFileSync(new URL("../public/js/host.js", import.meta.url), "utf8");

/**
 * Pulls a `const NAME = <literal>;` out of the host page.
 *
 * Line-ending agnostic, and tolerant of the trailing comma a formatter leaves
 * in a multi-line array — JSON.parse is not.
 */
function literal(name) {
  const match = hostSource.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\s*[\\r\\n]`));
  assert.ok(match, `public/js/host.js no longer declares ${name}`);
  const json = match[1].replace(/\s+/g, "").replace(/,(?=[\]}])/g, "");
  return JSON.parse(json);
}

test("the host page's ROUND_VALUES match lib/board.js", () => {
  assert.deepEqual(literal("ROUND_VALUES"), ROUND_VALUES);
});

test("the host page's MAX_CATEGORIES matches lib/board.js", () => {
  assert.equal(literal("MAX_CATEGORIES"), MAX_CATEGORIES);
});

test("the host page derives the same number of rounds", () => {
  assert.equal(literal("ROUND_VALUES").length, NUM_ROUNDS);
});
