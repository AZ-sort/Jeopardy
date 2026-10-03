# Two Rounds (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare `{categories}` board with a `{rounds, final, options}` wrapper and let a host play an optional second round at 200–1000 with two Daily Doubles.

**Architecture:** `lib/board.js` grows the wrapper and per-round values; `lib/game.js` holds `rounds`/`roundIndex` while `game.board` keeps meaning "the board being played now", so every existing rule is untouched. A new `round-end` phase sits between boards, advanced by a host press. Final Jeopardy is **not** built here — its fields exist in the schema so the saved shape is settled, and nothing reads them yet.

**Tech Stack:** Node ≥20, ESM, zod 4, express, ws, `node:test`. No build step, no framework.

**Spec:** `docs/specs/2026-10-03-rounds-and-final-jeopardy-design.md`

## Global Constraints

- `lib/game.js` stays pure — plain functions over a state object, no I/O, no timers. Randomness is injected as a `random` argument defaulting to `Math.random`.
- Every mutating rule returns `{ok: true}` or `{ok: false, reason}` rather than throwing.
- Round 1 values are `[100, 200, 300, 400, 500]`; round 2 values are `[200, 400, 600, 800, 1000]`.
- Round 1 hides 1 Daily Double; round 2 hides 2.
- `NUM_CATEGORIES = 6`, `NUM_ROUNDS = 2`.
- The player payload must never carry `dailyDouble` for any round — host-only until a square is opened.
- No conversion of old-shape `{categories}` boards. `validateBoard` rejects them with a clear error.
- Branch, commit, push, open a PR with a test plan — never merge, force-push, or push to `main`.

## Review Focus

1. **Round 2 toggled on but left completely blank** — *Start the game* must still work and play round 1 only, never block on empty round-2 slots. (Task 1)
2. **Round 2 filled, then toggled off** — the authored content must survive in the draft and in a save, and simply not be played. (Task 1)
3. **Two Daily Doubles in a round with only one filled category** — must still land on two *distinct squares* rather than looping or double-marking one. (Task 2)
4. **"Start round 2" pressed twice** — the second press must be refused, not skip a round or re-place Daily Doubles on a board in progress. (Task 2)
5. **A generate request with a missing or out-of-range `roundIndex`** — must be rejected, never silently write a category into round 1. (Task 3)

---

### Task 1: The board wrapper

**Files:**
- Modify: `lib/board.js`
- Test: `test/board.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `ROUND_VALUES`, `NUM_ROUNDS`, `blankBoard()`, `blankRound(round)`, `blankCategory(title, round)`, `validateBoard(input) -> {ok,board}|{ok:false,error}`, `compactBoard(board) -> board`, `collectAnswers(board) -> string[]`. The validated board is `{rounds, final, options}`.

- [ ] **Step 1: Write the failing tests**

Create `test/board.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test test/board.test.js`
Expected: FAIL — `ROUND_VALUES`/`NUM_ROUNDS` are not exported yet, so the module does not load.

- [ ] **Step 3: Rewrite the schema and helpers**

In `lib/board.js`, replace the exports block and schemas:

```js
export const ROUND_VALUES = [
  [100, 200, 300, 400, 500],
  [200, 400, 600, 800, 1000],
];
/** Round 1's values. Kept under the old name because the host UI imports it. */
export const CLUE_VALUES = ROUND_VALUES[0];
export const NUM_CATEGORIES = 6;
export const NUM_ROUNDS = ROUND_VALUES.length;

const CategorySchema = z.object({
  title: z.string().max(40),
  clues: z.array(ClueSchema).length(ROUND_VALUES[0].length),
});

// No `.min(1)`: a round the host never filled in compacts to zero categories,
// and that must stay parseable so an untouched round 2 cannot block the game.
const RoundSchema = z.object({
  categories: z.array(CategorySchema).max(NUM_CATEGORIES),
});

const FinalSchema = z
  .object({
    category: z.string().max(40),
    clue: z.string().max(400),
    answer: z.string().max(200),
  })
  .nullable()
  .default(null);

export const BoardSchema = z.object({
  rounds: z.array(RoundSchema).min(1).max(NUM_ROUNDS),
  final: FinalSchema,
  options: z
    .object({
      doubleRound: z.boolean().default(false),
      finalRound: z.boolean().default(false),
    })
    .default({ doubleRound: false, finalRound: false }),
});

export function blankCategory(title = "", round = 0) {
  return {
    title,
    clues: ROUND_VALUES[round].map((value) => ({
      value,
      clue: "",
      answer: "",
      revealed: false,
      wager: null,
      dailyDouble: false,
    })),
  };
}

export function blankRound(round) {
  return {
    categories: Array.from({ length: NUM_CATEGORIES }, () => blankCategory("", round)),
  };
}

export function blankBoard() {
  return {
    rounds: Array.from({ length: NUM_ROUNDS }, (_, r) => blankRound(r)),
    final: null,
    options: { doubleRound: false, finalRound: false },
  };
}
```

- [ ] **Step 4: Rewrite validate, compact and collect**

```js
/** The rounds that will actually be played, given the toggles. */
export function playedRounds(board) {
  return board.options?.doubleRound ? board.rounds.slice(0, NUM_ROUNDS) : board.rounds.slice(0, 1);
}

export function validateBoard(input) {
  if (!input || !Array.isArray(input.rounds)) {
    return { ok: false, error: "board: expected a rounds array" };
  }

  const parsed = BoardSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first.path.join(".") || "board"}: ${first.message}` };
  }

  const board = parsed.data;

  // Only a round that will be played has to be complete. An untouched round 2
  // sitting behind an off toggle must never block the game.
  const empties = [];
  playedRounds(board).forEach((round, r) => {
    if (round.categories.length === 0) {
      empties.push(`round ${r + 1} has no categories`);
      return;
    }
    round.categories.forEach((cat, i) => {
      if (!cat.title.trim()) {
        empties.push(`round ${r + 1} category ${i + 1} has no title`);
        return;
      }
      cat.clues.forEach((clue) => {
        if (!clue.clue.trim() || !clue.answer.trim()) {
          empties.push(`"${cat.title}" $${clue.value} is incomplete`);
        }
      });
    });
  });
  if (empties.length) return { ok: false, error: empties.slice(0, 4).join("; ") };

  return { ok: true, board };
}

/**
 * Drops unfilled categories from every round. Both rounds are kept whatever
 * the toggles say, so turning round 2 off and on again does not lose the work.
 */
export function compactBoard(board) {
  return {
    rounds: (board.rounds ?? []).map((round) => ({
      categories: (round.categories ?? []).filter(
        (cat) => cat.title.trim() && cat.clues.some((c) => c.clue.trim() || c.answer.trim()),
      ),
    })),
    final: board.final ?? null,
    options: {
      doubleRound: Boolean(board.options?.doubleRound),
      finalRound: Boolean(board.options?.finalRound),
    },
  };
}

/** Every answer anywhere on the board — fed back to the model to avoid repeats. */
export function collectAnswers(board) {
  if (!board?.rounds) return [];
  const fromRounds = board.rounds.flatMap((round) =>
    round.categories.flatMap((cat) => cat.clues.map((c) => c.answer)),
  );
  return [...fromRounds, board.final?.answer ?? ""].map((a) => String(a).trim()).filter(Boolean);
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `node --test test/board.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/board.js test/board.test.js
git commit -m "Give a board rounds, a final slot and toggles"
```

---

### Task 2: Round rules in the game state

**Files:**
- Modify: `lib/game.js`
- Test: `test/game.test.js`

**Interfaces:**
- Consumes: `ROUND_VALUES`, `playedRounds` from Task 1.
- Produces: `PHASE.ROUND_END` (`"round-end"`), `DAILY_DOUBLES_PER_ROUND`, `startNextRound(game, {random})`, and `game.rounds` / `game.roundIndex` / `game.options`. `setBoard(game, board)` now takes the wrapper.

- [ ] **Step 1: Write the failing tests**

Append to `test/game.test.js` (the existing `testBoard()` helper returns the old bare shape — wrap it rather than rewriting every test):

```js
// ---------------------------------------------------------------- rounds

/** Wraps the existing single-board fixture in the round wrapper. */
function wrapped(options = {}) {
  return {
    rounds: [testBoard(), testBoard()],
    final: null,
    options: { doubleRound: false, finalRound: false, ...options },
  };
}

function twoRoundGame(random = LAST_CLUE) {
  const g = createGame("ABCD");
  addPlayer(g, { id: "p1", name: "Ann" });
  addPlayer(g, { id: "p2", name: "Bo" });
  setBoard(g, wrapped({ doubleRound: true }));
  startGame(g, { random });
  return g;
}

function playWholeBoard(g) {
  for (let c = 0; c < g.board.categories.length; c++) {
    for (let q = 0; q < g.board.categories[c].clues.length; q++) {
      openClue(g, c, q);
      closeClue(g);
    }
  }
}

test("a one-round game still ends at done, exactly as before", () => {
  const g = createGame("ABCD");
  addPlayer(g, { id: "p1", name: "Ann" });
  setBoard(g, wrapped({ doubleRound: false }));
  startGame(g, { random: LAST_CLUE });
  playWholeBoard(g);
  assert.equal(g.phase, PHASE.DONE);
});

test("finishing round 1 with a second round to come pauses at the round end", () => {
  const g = twoRoundGame();
  playWholeBoard(g);
  assert.equal(g.phase, PHASE.ROUND_END);
  assert.equal(g.roundIndex, 0);
});

test("starting round 2 loads the second board at its own values", () => {
  const g = twoRoundGame();
  playWholeBoard(g);
  const res = startNextRound(g, { random: LAST_CLUE });

  assert.equal(res.ok, true);
  assert.equal(g.phase, PHASE.BOARD);
  assert.equal(g.roundIndex, 1);
  assert.equal(g.board.categories[0].clues[0].revealed, false);
});

test("round 2 hides two daily doubles, round 1 hides one", () => {
  const g = twoRoundGame();
  const inRound1 = g.board.categories.flatMap((c) => c.clues).filter((c) => c.dailyDouble);
  assert.equal(inRound1.length, 1);

  playWholeBoard(g);
  startNextRound(g, { random: LAST_CLUE });
  const inRound2 = g.board.categories.flatMap((c) => c.clues).filter((c) => c.dailyDouble);
  assert.equal(inRound2.length, 2);
});

test("two daily doubles land on different squares even in a one-category round", () => {
  const g = createGame("ABCD");
  addPlayer(g, { id: "p1", name: "Ann" });
  const board = wrapped({ doubleRound: true });
  board.rounds[1] = { categories: [testBoard().categories[0]] };
  setBoard(g, board);
  startGame(g, { random: LAST_CLUE });
  playWholeBoard(g);
  startNextRound(g, { random: () => 0.5 });

  const marked = g.board.categories.flatMap((c) => c.clues).filter((c) => c.dailyDouble);
  assert.equal(marked.length, 2, "two squares must be marked, not one square twice");
});

test("starting the next round twice is refused rather than skipping one", () => {
  const g = twoRoundGame();
  playWholeBoard(g);
  assert.equal(startNextRound(g, { random: LAST_CLUE }).ok, true);

  const second = startNextRound(g, { random: LAST_CLUE });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "wrong-phase");
  assert.equal(g.roundIndex, 1, "the board in progress must not be reshuffled");
});

test("finishing the last round ends the game", () => {
  const g = twoRoundGame();
  playWholeBoard(g);
  startNextRound(g, { random: LAST_CLUE });
  playWholeBoard(g);
  assert.equal(g.phase, PHASE.DONE);
});

test("the player view says which round is being played", () => {
  const g = twoRoundGame();
  const view = publicState(g, { forHost: false });
  assert.equal(view.round, 1);
  assert.equal(view.rounds, 2);
});
```

Add `startNextRound` to the import list at the top of the file.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test test/game.test.js`
Expected: FAIL — `startNextRound` is not exported, so the module does not load.

- [ ] **Step 3: Add the phase, the state and the round advance**

In `lib/game.js`:

```js
export const PHASE = {
  LOBBY: "lobby",
  BOARD: "board",
  CLUE: "clue",
  WAGER: "wager",
  BUZZED: "buzzed",
  /** A board is finished and another round is still to come. */
  ROUND_END: "round-end",
  DONE: "done",
};

/** Round 1 hides one Daily Double; round 2 hides two, as the show does. */
export const DAILY_DOUBLES_PER_ROUND = [1, 2];
```

In `createGame`, alongside the existing fields:

```js
    rounds: [],
    roundIndex: 0,
    options: { doubleRound: false, finalRound: false },
    final: null,
```

Replace `setBoard`:

```js
/** Takes a validated board wrapper and keeps only the rounds that will be played. */
export function setBoard(game, board) {
  if (game.phase !== PHASE.LOBBY) return fail("already-started");
  game.rounds = playedRounds(board);
  game.options = { ...board.options };
  game.final = board.final ?? null;
  game.roundIndex = 0;
  game.board = game.rounds[0] ?? null;
  return ok();
}
```

Import `playedRounds` from `./board.js` at the top of `lib/game.js`.

- [ ] **Step 4: Generalise Daily Double placement and add the advance**

Replace `placeDailyDouble` with:

```js
/**
 * Hides `count` Daily Doubles, preferring one per category — the show never
 * puts two in the same column, but a short round may leave no choice. Squares
 * are always distinct.
 */
function placeDailyDoubles(game, random, count) {
  const squares = game.board.categories.flatMap((cat, c) =>
    cat.clues.map((_, q) => ({ c, q })),
  );
  for (const { c, q } of squares) game.board.categories[c].clues[q].dailyDouble = false;
  if (squares.length === 0) return;

  const pick = (from) =>
    from[Math.min(Math.floor(random() * from.length), from.length - 1)];

  let pool = squares.slice();
  const usedCategories = new Set();
  for (let n = 0; n < Math.min(count, squares.length); n++) {
    const fresh = pool.filter((s) => !usedCategories.has(s.c));
    const chosen = pick(fresh.length ? fresh : pool);
    game.board.categories[chosen.c].clues[chosen.q].dailyDouble = true;
    usedCategories.add(chosen.c);
    pool = pool.filter((s) => !(s.c === chosen.c && s.q === chosen.q));
  }
}
```

In `startGame`, replace the `placeDailyDouble(game, random)` call with:

```js
  placeDailyDoubles(game, random, DAILY_DOUBLES_PER_ROUND[0]);
```

Add the advance:

```js
/** The host's press at the round-end screen. */
export function startNextRound(game, { random = Math.random } = {}) {
  if (game.phase !== PHASE.ROUND_END) return fail("wrong-phase");
  const next = game.roundIndex + 1;
  if (next >= game.rounds.length) return fail("no-more-rounds");

  game.roundIndex = next;
  game.board = game.rounds[next];
  placeDailyDoubles(game, random, DAILY_DOUBLES_PER_ROUND[next] ?? 1);
  game.phase = PHASE.BOARD;
  return ok();
}
```

- [ ] **Step 5: Gate the end of a board**

In `closeClue`, replace the final phase assignment:

```js
  game.phase = isBoardComplete(game) ? endOfBoardPhase(game) : PHASE.BOARD;
```

and add:

```js
/** A finished board pauses for the next round, or ends the game. */
function endOfBoardPhase(game) {
  return game.roundIndex + 1 < game.rounds.length ? PHASE.ROUND_END : PHASE.DONE;
}
```

In `publicState`, add to the returned object:

```js
    round: game.roundIndex + 1,
    rounds: game.rounds.length,
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. The pre-existing Daily Double tests must still pass unchanged — `placeDailyDoubles` with `count: 1` picks the same square the old function did for the same `random`.

- [ ] **Step 7: Commit**

```bash
git add lib/game.js test/game.test.js
git commit -m "Play an optional second round at 200-1000"
```

---

### Task 3: Server wiring

**Files:**
- Modify: `server.js`
- Test: exercised by Task 5's smoke test; the rules are already covered by Task 2.

**Interfaces:**
- Consumes: `startNextRound`, `PHASE.ROUND_END` from Task 2; `blankBoard`, `compactBoard`, `validateBoard`, `collectAnswers` from Task 1.
- Produces: host socket message `{type: "startNextRound"}`; the generate endpoint now takes `roundIndex`.

- [ ] **Step 1: Point the room draft at the new shape**

`room.draft` is already `blankBoard()` (`server.js:155`) and needs no change — `blankBoard` returns the wrapper as of Task 1.

In the `startGame` host message case, nothing changes either: `compactBoard(room.draft)` then `validateBoard(board)` then `G.setBoard` already carry the wrapper through.

Add the new case next to `openClue`:

```js
    case "startNextRound":
      result = G.startNextRound(game);
      break;
```

And add to the rejection reasons map in `handleHostMessage`:

```js
      "no-more-rounds": "That was the last round.",
```

- [ ] **Step 2: Make generation round-aware**

In the generate endpoint, replace the category-index validation and the write:

```js
  const round = Number(req.body?.roundIndex ?? 0);
  const index = Number(req.body?.categoryIndex);
  if (!Number.isInteger(round) || round < 0 || round >= NUM_ROUNDS) {
    return res.status(400).json({ error: "Bad round." });
  }
  if (!Number.isInteger(index) || index < 0 || index >= NUM_CATEGORIES) {
    return res.status(400).json({ error: "Bad category slot." });
  }

  // One in-flight generation per square, not per category index, or the two
  // rounds would block each other's slot 3.
  const slot = `${round}:${index}`;
  if (room.generating.has(slot)) {
    return res.status(409).json({ error: "That category is already generating." });
  }
```

then `room.generating.add(slot)`, `room.draft.rounds[round].categories[index] = category`, and `room.generating.delete(slot)` in the `finally`.

Import `NUM_ROUNDS` and `ROUND_VALUES` from `./lib/board.js`.

A generated category comes back at round 1's values (`lib/ai/shared.js` uses `CLUE_VALUES`), so re-stamp them for round 2 before storing:

```js
    category.clues.forEach((clue, i) => {
      clue.value = ROUND_VALUES[round][i];
    });
```

- [ ] **Step 3: Fix the saved-board endpoint**

In `POST /api/boards`, replace the empty check, since `board.categories` no longer exists:

```js
  const board = compactBoard(req.body?.board ?? blankBoard());
  if (!board.rounds[0]?.categories.length) {
    return res.status(400).json({ error: "Nothing to save yet." });
  }
```

Import `blankBoard` alongside the other board helpers.

- [ ] **Step 4: Check the server still boots and serves**

Run: `npm start` in one terminal, then `curl -s localhost:3000/api/health`
Expected: `{"ok":true,...}`.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "Carry the round through the socket and the generate endpoint"
```

---

### Task 4: Authoring two rounds

**Files:**
- Modify: `public/host.html`, `public/js/host.js`, `public/css/app.css`

**Interfaces:**
- Consumes: the draft wrapper from Task 1; `roundIndex` on the generate POST from Task 3.
- Produces: nothing other tasks read.

- [ ] **Step 1: Add the toggles to the markup**

In `public/host.html`, immediately above the `id="slots"` container:

```html
<div class="toggles">
  <label class="toggle">
    <input type="checkbox" id="s-double" />
    <span>Second round <small>another board at $200–$1000</small></span>
  </label>
  <label class="toggle">
    <input type="checkbox" id="s-final" disabled />
    <span>Final Jeopardy <small>coming soon</small></span>
  </label>
</div>
```

The Final Jeopardy box ships disabled in this PR so the setup screen does not change shape again when PR 2 lands.

- [ ] **Step 2: Make the setup builder round-aware**

In `public/js/host.js`, `buildSetup` currently walks `draft.categories`. Replace it:

```js
function buildSetup() {
  const slots = el("slots");
  slots.textContent = "";

  const rounds = draft.options.doubleRound ? NUM_ROUNDS : 1;
  for (let r = 0; r < rounds; r++) {
    if (!draft.rounds[r]) draft.rounds[r] = blankRound(r);

    if (rounds > 1) {
      const head = document.createElement("h2");
      head.className = "slots__round";
      head.textContent = r === 0 ? "Round 1" : "Round 2 — double values";
      slots.append(head);
    }

    for (let c = 0; c < NUM_CATEGORIES; c++) {
      if (!draft.rounds[r].categories[c]) {
        draft.rounds[r].categories[c] = blankCategory("", r);
      }
      slots.append(buildSlot(r, c));
    }
  }
  setupBuilt = true;
  refreshAccount();
}
```

Import `blankRound`, `blankCategory`, `NUM_ROUNDS` and `ROUND_VALUES` wherever `CLUE_VALUES` and `NUM_CATEGORIES` come from today.

- [ ] **Step 3: Thread the round through the slot builder**

`buildSlot(c)` becomes `buildSlot(r, c)`, and its first line becomes
`const cat = draft.rounds[r].categories[c];`.

The visible heading stays `"Category " + (c + 1)` — the round heading above it
already says which round this is. But every `aria-label` built from
`"Category " + (c + 1)` becomes `"Round " + (r + 1) + " category " + (c + 1)`,
so a screen reader can tell two otherwise identical grids apart.

The generate call is the error-prone edit, because it both sends and writes
back. It becomes:

```js
      const { category } = await postJson("/api/rooms/" + code + "/generate", {
        hostToken,
        roundIndex: r,
        categoryIndex: c,
        theme: wanted,
      });
      draft.rounds[r].categories[c] = category;
      // Replace the slot wholesale: every field in it changed.
      slot.replaceWith(buildSlot(r, c));
```

- [ ] **Step 4: Wire the toggle**

```js
el("s-double").addEventListener("change", (e) => {
  draft.options.doubleRound = e.target.checked;
  queueDraftSave();
  // Round 2's slots appear or disappear; everything typed into them is kept
  // in the draft either way.
  buildSetup();
});
```

And when the draft first arrives, reflect its state: `el("s-double").checked = Boolean(draft.options.doubleRound);`

- [ ] **Step 5: Style the toggles and the round heading**

In `public/css/app.css`, following the existing token conventions:

```css
.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-bottom: 18px;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--cream);
}

.toggle small {
  display: block;
  color: var(--cream-dim);
}

.toggle input:disabled + span {
  opacity: 0.45;
}

.slots__round {
  font-family: var(--display);
  font-size: clamp(1.4rem, 3vw, 2.2rem);
  color: var(--brass);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 26px 0 10px;
}
```

- [ ] **Step 6: Verify by hand**

Start the server, open the host screen. Confirm: the second grid appears only when the box is ticked; typing into round 2, unticking, and re-ticking preserves what was typed; "Fill with AI" on a round 2 category returns clues at 200–1000.

- [ ] **Step 7: Commit**

```bash
git add public/host.html public/js/host.js public/css/app.css
git commit -m "Author both rounds from one setup screen"
```

---

### Task 5: The round-end screen

**Files:**
- Modify: `public/host.html`, `public/js/host.js`, `public/js/play.js`, `public/css/app.css`

**Interfaces:**
- Consumes: `PHASE.ROUND_END`, `round`, `rounds` on the state payload from Task 2; the `startNextRound` host message from Task 3.

- [ ] **Step 1: Add the screen**

In `public/host.html`, as a sibling of the `id="clue"` takeover:

```html
<div class="roundend" id="roundend" hidden>
  <p class="roundend__done" id="re-done"></p>
  <div class="roundend__scores" id="re-scores"></div>
  <button class="btn btn--go" id="re-next">Start round 2</button>
</div>
```

- [ ] **Step 2: Render it**

In `public/js/host.js`, in the top-level `render(state)`:

```js
const atRoundEnd = state.phase === "round-end";
el("roundend").hidden = !atRoundEnd;
if (atRoundEnd) {
  el("re-done").textContent = `End of round ${state.round}.`;
  const scores = el("re-scores");
  scores.textContent = "";
  for (const p of [...state.players].sort((a, b) => b.score - a.score)) {
    const row = document.createElement("div");
    row.className = "roundend__row";
    const name = document.createElement("span");
    name.textContent = p.name;
    const score = document.createElement("b");
    score.textContent = (p.score < 0 ? "−$" : "$") + Math.abs(p.score);
    row.append(name, score);
    scores.append(row);
  }
}

el("re-next").addEventListener("click", () => socket.send({ type: "startNextRound" }));
```

Register the listener once at module level, not inside `render`.

- [ ] **Step 3: Tell the phones**

In `public/js/play.js`, in the `else` branch that sets `meta.textContent` when there is no active clue, add the round-end case ahead of the `done` case:

```js
      state.phase === "round-end"
        ? "End of the round. Scores are on the big screen."
        : state.phase === "lobby"
```

- [ ] **Step 4: Style it**

```css
.roundend {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 40px 20px;
}

.roundend__done {
  font-family: var(--display);
  font-size: clamp(2rem, 6vw, 4rem);
  text-transform: uppercase;
  color: var(--brass);
  margin: 0;
}

.roundend__row {
  display: flex;
  justify-content: space-between;
  gap: 40px;
  min-width: min(420px, 80vw);
  padding: 6px 0;
  border-bottom: 1px solid var(--panel);
  color: var(--cream);
}
```

- [ ] **Step 5: Verify by hand**

Play a two-round game locally with one player: finish round 1, confirm the scoreboard appears with the button, press it, confirm round 2 opens at 200–1000 with two Daily Doubles somewhere in it, and that finishing round 2 reaches the normal end screen.

- [ ] **Step 6: Commit**

```bash
git add public/host.html public/js/host.js public/js/play.js public/css/app.css
git commit -m "Pause on a scoreboard between rounds"
```

---

### Task 6: End-to-end coverage and the docs

**Files:**
- Modify: `scripts/smoke.mjs`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Make the smoke board a wrapper**

`makeBoard()` in `scripts/smoke.mjs` returns the bare old shape. Wrap it:

```js
function makeBoard(options = {}) {
  const cat = (title, values) => ({
    title,
    clues: values.map((value) => ({
      value,
      clue: title + " clue worth " + value,
      answer: title + " answer " + value,
      revealed: false,
      wager: null,
      dailyDouble: false,
    })),
  });
  const round = (prefix, values) => ({
    categories: [cat(prefix + " Alpha", values), cat(prefix + " Beta", values)],
  });
  return {
    rounds: [round("R1", [100, 200, 300, 400, 500]), round("R2", [200, 400, 600, 800, 1000])],
    final: null,
    options: { doubleRound: false, finalRound: false, ...options },
  };
}
```

Every existing assertion that names `"Alpha clue worth 100"` becomes `"R1 Alpha clue worth 100"`. Update them.

- [ ] **Step 2: Add a two-round game**

In a fresh room, after the existing sections:

```js
console.log("\nA two-round game");
const room3 = await newRoom();
const h3 = await client(() => ({
  type: "hello", role: "host", code: room3.code, hostToken: room3.hostToken,
}));
const p3 = await client(() => ({
  type: "hello", role: "player", code: room3.code, playerId: "r-1", name: "Eve",
}));
await wait(150);
h3.send({ type: "saveDraft", draft: makeBoard({ doubleRound: true }) });
await wait(150);
h3.send({ type: "startGame" });
await wait(200);
check("round 1 is the first board", h3.state.round === 1, String(h3.state.round));
check("the player is told there are two rounds", p3.state.rounds === 2, String(p3.state.rounds));

await playEveryClue(h3, p3, "r-1");
check("round 1 pauses at the round end", h3.state.phase === "round-end", h3.state.phase);

h3.send({ type: "startNextRound" });
await wait(200);
check("round 2 opened", h3.state.phase === "board" && h3.state.round === 2, h3.state.phase);
check(
  "round 2 is worth double",
  h3.state.board.categories[0].clues[4].value === 1000,
  String(h3.state.board.categories[0].clues[4].value),
);
check(
  "round 2's daily doubles are not visible to the player",
  !JSON.stringify(p3.state.board).includes("dailyDouble"),
);

await playEveryClue(h3, p3, "r-1");
check("the game ends after the last round", h3.state.phase === "done", h3.state.phase);
```

`playEveryClue` is the helper both the existing round-1 loop and this new
section share. Define it once, above the first use:

```js
/**
 * Clears whatever board is open, closing ordinary clues and playing out any
 * Daily Double it uncovers. Walks by the `revealed` flags because the Daily
 * Double squares are random and a fixed order would eventually trip over one.
 */
async function playEveryClue(host, player, playerId) {
  const next = (board) => {
    for (let c = 0; c < board.categories.length; c++) {
      const clues = board.categories[c].clues;
      for (let q = 0; q < clues.length; q++) if (!clues[q].revealed) return { c, q };
    }
    return null;
  };

  let cell = next(host.state.board);
  while (cell) {
    host.send({ type: "openClue", c: cell.c, q: cell.q });
    await wait(80);

    if (host.state.phase === "wager") {
      host.send({ type: "assignDailyDouble", playerId });
      await wait(80);
      player.send({ type: "setWager", amount: 100 });
      await wait(100);
      host.send({ type: "judge", correct: false });
      await wait(100);
    } else {
      host.send({ type: "closeClue" });
      await wait(70);
    }
    cell = next(host.state.board);
  }
}
```

- [ ] **Step 2b: Assert the second press is refused over the wire**

```js
h3.send({ type: "startNextRound" });
await wait(150);
check("a second round-advance is refused", h3.state.round === 2, String(h3.state.round));
```

Place this immediately after round 2 opens, before playing it.

- [ ] **Step 2c: Assert a bad round is refused by the generate endpoint**

This is the one Review Focus item with no unit test behind it, because the
validation lives in the HTTP layer. The check runs before any API key is
needed, so it passes on a server with generation switched off:

```js
console.log("\nGeneration rejects a bad round");
const badRound = await fetch(BASE + "/api/rooms/" + room3.code + "/generate", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    hostToken: room3.hostToken,
    roundIndex: 9,
    categoryIndex: 0,
    theme: "anything",
  }),
});
check("an out-of-range round is refused", badRound.status === 400, String(badRound.status));
check(
  "round 1 was not written into instead",
  h3.state.board.categories[0].title.startsWith("R"),
);
```

- [ ] **Step 3: Run it**

Run: `npm start` in one terminal, `npm run smoke` in another. Run it **five times** — the Daily Double squares are random, and a two-round board has three of them.
Expected: ALL CHECKS PASSED every time.

- [ ] **Step 4: Update the docs**

In `README.md`, under *Playing*, describe the two setup toggles and the round-end pause, and note round 2 runs 200–1000 with two Daily Doubles. In *Known limits*, replace the "One Daily Double per board" bullet with the fact that round 2 has two. Leave the "Not yet built" bullet listing Final Jeopardy, timers and sound.

In `CLAUDE.md`, extend the Daily Double section to say the count comes from `DAILY_DOUBLES_PER_ROUND` and that placement prefers one per category, and add a short section on the board wrapper: `{rounds, final, options}`, no conversion of old shapes, `validateBoard` only checks rounds that will be played.

- [ ] **Step 5: Full verification**

Run: `npm test` — expect every test passing, none skipped.
Run: `npm run smoke` — expect ALL CHECKS PASSED.
Then play a two-round game in a browser against the running server, host screen plus one phone-sized window, and confirm the round-end screen and the 200–1000 board.

- [ ] **Step 6: Commit and open the PR**

```bash
git add scripts/smoke.mjs README.md CLAUDE.md
git commit -m "Cover a two-round game end to end"
git push -u origin <branch>
gh pr create --title "Two rounds: an optional 200-1000 second board" --body "..."
```

The PR body must carry the test plan: unit counts before and after, how many smoke runs, and what was checked in the browser. Do not merge.
