import test from "node:test";
import assert from "node:assert/strict";

import {
  blankBoard,
  validateBoard,
  compactBoard,
  collectAnswers,
  ROUND_VALUES,
  NUM_ROUNDS,
} from "../lib/board.js";

/** A round whose every clue is filled in. */
function filledRound(round, prefix) {
  return {
    categories: [
      {
        title: prefix,
        clues: ROUND_VALUES[round].map((value) => ({
          value,
          clue: `${prefix} clue ${value}`,
          answer: `${prefix} answer ${value}`,
          revealed: false,
          wager: null,
          dailyDouble: false,
        })),
      },
    ],
  };
}

function playableBoard(options = {}) {
  return {
    rounds: [filledRound(0, "One"), filledRound(1, "Two")],
    final: null,
    options: { doubleRound: false, finalRound: false, ...options },
  };
}

test("a blank board has both rounds, at their own values, and both toggles off", () => {
  const b = blankBoard();
  assert.equal(b.rounds.length, NUM_ROUNDS);
  assert.equal(b.rounds[0].categories[0].clues[0].value, 100);
  assert.equal(b.rounds[1].categories[0].clues[0].value, 200);
  assert.equal(b.rounds[1].categories[0].clues[4].value, 1000);
  assert.equal(b.options.doubleRound, false);
  assert.equal(b.options.finalRound, false);
});

test("an old bare {categories} board is refused rather than silently accepted", () => {
  const res = validateBoard({ categories: [] });
  assert.equal(res.ok, false);
  assert.match(res.error, /rounds/);
});

test("round 2 left completely blank does not block starting the game", () => {
  const board = compactBoard({
    rounds: [filledRound(0, "One"), { categories: [] }],
    final: null,
    options: { doubleRound: false, finalRound: false },
  });
  const res = validateBoard(board);
  assert.equal(res.ok, true, res.error);
});

test("an incomplete round 2 is refused once the toggle is on", () => {
  const board = playableBoard({ doubleRound: true });
  board.rounds[1].categories[0].clues[2].answer = "   ";
  const res = validateBoard(board);
  assert.equal(res.ok, false);
  assert.match(res.error, /Two/);
});

test("round 2 content survives being toggled off", () => {
  const board = compactBoard(playableBoard({ doubleRound: false }));
  assert.equal(board.rounds.length, 2);
  assert.equal(board.rounds[1].categories[0].title, "Two");
});

test("answers are collected from every round so the AI does not repeat one", () => {
  const answers = collectAnswers(playableBoard());
  assert.ok(answers.includes("One answer 100"));
  assert.ok(answers.includes("Two answer 1000"));
});

test("a round may hold anywhere from one to six categories", () => {
  const board = playableBoard();
  const one = board.rounds[0].categories[0];
  board.rounds[0].categories = [one, { ...one, title: "Two" }, { ...one, title: "Three" }];
  assert.equal(validateBoard(board).ok, true);

  board.rounds[0].categories = Array.from({ length: 7 }, (_, i) => ({ ...one, title: "C" + i }));
  assert.equal(validateBoard(board).ok, false, "seven is past the ceiling");
});

test("a round carrying another round's values is refused", () => {
  const board = playableBoard({ doubleRound: true });
  // Round 2 authored by a drifted client: round 1's values on the second board.
  board.rounds[1].categories[0].clues.forEach((clue, i) => {
    clue.value = ROUND_VALUES[0][i];
  });
  const res = validateBoard(board);
  assert.equal(res.ok, false);
  assert.match(res.error, /should be worth \$200, not \$100/);
});

test("compacting never throws on a draft with the wrong types in it", () => {
  // A socket can send anything; compactBoard must not be the thing that dies.
  const hostile = {
    rounds: [{ categories: [{ title: 1, clues: [null, 7, "x"] }] }, { categories: [] }],
    final: null,
    options: {},
  };
  assert.doesNotThrow(() => compactBoard(hostile));
  assert.equal(compactBoard(hostile).rounds[0].categories.length, 0);
});

test("a played round with every category removed is refused", () => {
  const board = playableBoard();
  board.rounds[0].categories = [];
  const res = validateBoard(board);
  assert.equal(res.ok, false);
  assert.match(res.error, /no categories/);
});
