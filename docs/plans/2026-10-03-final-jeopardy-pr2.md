# Final Jeopardy (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the game. Everyone bets in secret, types an answer against a 30-second clock, and the answers are revealed one at a time — poorest first — for the host to rule on.

**Architecture:** Four new phases after the last board. `lib/game.js` stays pure: it holds an absolute `deadline` and takes `now` as an argument, while the server owns the single `setTimeout`. The biggest structural change is that `publicState` becomes per-player — today every phone receives the same payload, which cannot work when each player must see their own wager and answer and nobody else's.

**Tech Stack:** Node ≥20, ESM, zod 4, express, ws, `node:test`. No build step, no framework.

**Spec:** `docs/specs/2026-10-03-rounds-and-final-jeopardy-design.md`

## Global Constraints

- `lib/game.js` stays pure — no I/O, no timers, no `Date.now()` inside a rule. Time enters as a `now` argument; randomness as a `random` argument.
- Every mutating rule returns `{ok: true}` or `{ok: false, reason}` rather than throwing.
- Final Jeopardy wagers run **$0 to the player's own score**, in steps of `WAGER_STEP` (100). This deliberately differs from a Daily Double's $100 floor and `max(score, board high)` ceiling.
- **Final Jeopardy can never take a player below $0.** A player at or below zero is in the round with a forced $0 bet.
- `FINAL_ANSWER_SECONDS = 30`.
- The player payload must never carry: the final clue before every bet is in, another player's wager before that player is revealed, another player's answer before that player is revealed, or `dailyDouble` for any round.
- Branch, commit, push, open a PR with a test plan — never merge, force-push, or push to `main`.

## Naming note, read before Task 2

The spec calls the play state `game.final`. That name is **already taken** on `main`: `setBoard` assigns `game.final = board.final`, the authored `{category, clue, answer}`. This plan therefore uses:

- `game.final` — the authored clue, unchanged from `main`.
- `game.finalRound` — the play state `{wagers, answers, deadline, order, revealIndex, judged}`.

## Review Focus

1. **The timer fires after the host already closed the window early** — must not double-close, reopen answering, or skip the reveal. (Task 3)
2. **A player submits an answer after the deadline** — refused by the rules, not merely disabled in the UI. (Task 3)
3. **Every player is on $0 or below** — all forced to $0, nobody's score moves, and the game still reaches `DONE`. (Task 4)
4. **A player joins mid-Final-Jeopardy** — must not break wagering (the room must not wait forever on someone who arrived after the bets) or the reveal. (Task 2)
5. **Two players tied on score at reveal time** — the order must be deterministic, not whatever `sort` happens to do. (Task 4)

---

### Task 1: Per-player state payloads

**Files:**
- Modify: `lib/game.js`, `server.js`
- Test: `test/game.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `publicState(game, {forHost, playerId})` — `playerId` identifies *which* player the payload is for, and is `undefined` for the host.

- [ ] **Step 1: Write the failing test**

Append to `test/game.test.js`:

```js
// ---------------------------------------------------------------- per-player views

test("a player payload is built for one named player", () => {
  const g = twoPlayerGame();
  const forAnn = publicState(g, { forHost: false, playerId: "p1" });
  assert.equal(forAnn.you, "p1");

  const forBo = publicState(g, { forHost: false, playerId: "p2" });
  assert.equal(forBo.you, "p2");
});

test("the host payload has no player identity", () => {
  const g = twoPlayerGame();
  assert.equal(publicState(g, { forHost: true }).you, null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/game.test.js`
Expected: FAIL — `forAnn.you` is `undefined`, expected `"p1"`.

- [ ] **Step 3: Thread the identity through**

In `lib/game.js`, change the signature and add the field to the returned object:

```js
export function publicState(game, { forHost, playerId } = {}) {
```

and in the returned object, next to `code`:

```js
    /** Which player this payload was built for; null for the host. */
    you: playerId ?? null,
```

- [ ] **Step 4: Build one payload per player**

In `server.js`, replace `broadcast`:

```js
function broadcast(room) {
  const hostState = G.publicState(room.game, { forHost: true });
  for (const ws of room.hosts) {
    send(ws, { type: "state", state: hostState, draft: room.draft });
  }
  // One payload per player, not one shared payload: in Final Jeopardy each
  // phone must see its own bet and answer and nobody else's, so the states
  // genuinely differ. Capped at MAX_PLAYERS (12), so this stays cheap.
  for (const [playerId, ws] of room.players) {
    send(ws, {
      type: "state",
      state: G.publicState(room.game, { forHost: false, playerId }),
      you: playerId,
    });
  }
}
```

The `you:` field on the envelope stays for compatibility with `public/js/play.js`, which already reads it.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, every test. No existing test passes `playerId`, and `you` defaulting to `null` changes nothing for them.

- [ ] **Step 6: Commit**

```bash
git add lib/game.js server.js test/game.test.js
git commit -m "Build a state payload per player, not one for all of them"
```

---

### Task 2: Entering Final Jeopardy, and the betting

**Files:**
- Modify: `lib/game.js`
- Test: `test/game.test.js`

**Interfaces:**
- Consumes: `publicState(game, {forHost, playerId})` from Task 1.
- Produces: `PHASE.FINAL_WAGER` (`"final-wager"`), `startFinal(game)`, `finalMaxWager(game, playerId)`, `setFinalWager(game, playerId, amount)`, `allFinalWagersIn(game)`, and `game.finalRound`.

- [ ] **Step 1: Write the failing tests**

```js
// ---------------------------------------------------------------- final jeopardy

/** A board with a Final Jeopardy clue and the toggle on. */
function finalBoard(options = {}) {
  return {
    rounds: [testBoard()],
    final: { category: "Last Things", clue: "The final clue", answer: "The final answer" },
    options: { doubleRound: false, finalRound: true, ...options },
  };
}

/** A finished one-round game sitting at the round end, final still to come. */
function atFinal() {
  const g = createGame("ABCD");
  addPlayer(g, { id: "p1", name: "Ann" });
  addPlayer(g, { id: "p2", name: "Bo" });
  setBoard(g, finalBoard());
  startGame(g, { random: LAST_CLUE });
  adjustScore(g, "p1", 1000);
  adjustScore(g, "p2", 400);
  playWholeBoard(g);
  return g;
}

test("a board with final jeopardy on pauses at the round end instead of ending", () => {
  const g = atFinal();
  assert.equal(g.phase, PHASE.ROUND_END);
});

test("a board with final jeopardy off still ends the game outright", () => {
  const g = createGame("ABCD");
  addPlayer(g, { id: "p1", name: "Ann" });
  setBoard(g, { ...finalBoard(), options: { doubleRound: false, finalRound: false } });
  startGame(g, { random: LAST_CLUE });
  playWholeBoard(g);
  assert.equal(g.phase, PHASE.DONE);
});

test("starting final jeopardy opens the betting", () => {
  const g = atFinal();
  const res = startFinal(g);
  assert.equal(res.ok, true);
  assert.equal(g.phase, PHASE.FINAL_WAGER);
});

test("a player bets anywhere from nothing to their whole score", () => {
  const g = atFinal();
  startFinal(g);
  assert.equal(finalMaxWager(g, "p1"), 1000);
  assert.equal(setFinalWager(g, "p1", 0).ok, true);
  assert.equal(setFinalWager(g, "p1", 1000).ok, true);
});

test("a bet above the player's own score is refused", () => {
  const g = atFinal();
  startFinal(g);
  const res = setFinalWager(g, "p2", 500);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "out-of-range");
});

test("a bet that is not a whole hundred is refused", () => {
  const g = atFinal();
  startFinal(g);
  assert.equal(setFinalWager(g, "p1", 250).reason, "bad-increment");
});

test("a player on nothing is in the round at a forced zero", () => {
  const g = atFinal();
  adjustScore(g, "p2", -400); // Bo is on zero.
  startFinal(g);

  assert.equal(finalMaxWager(g, "p2"), 0);
  // Set for them, so the room is not waiting on a bet they cannot place.
  assert.equal(g.finalRound.wagers["p2"], 0);
  assert.equal(setFinalWager(g, "p2", 100).reason, "out-of-range");
});

test("a player in the red is also forced to zero rather than excluded", () => {
  const g = atFinal();
  adjustScore(g, "p2", -900); // Bo is on -500.
  startFinal(g);
  assert.equal(finalMaxWager(g, "p2"), 0);
  assert.equal(g.finalRound.wagers["p2"], 0);
});

test("the betting is done once everyone who can bet has", () => {
  const g = atFinal();
  startFinal(g);
  assert.equal(allFinalWagersIn(g), false);
  setFinalWager(g, "p1", 300);
  assert.equal(allFinalWagersIn(g), false);
  setFinalWager(g, "p2", 200);
  assert.equal(allFinalWagersIn(g), true);
});

test("someone who joins after the betting started does not hold up the room", () => {
  const g = atFinal();
  startFinal(g);
  setFinalWager(g, "p1", 300);
  setFinalWager(g, "p2", 200);

  addPlayer(g, { id: "p3", name: "Cal" });
  assert.equal(allFinalWagersIn(g), true, "a latecomer must not block the round");
  assert.equal(setFinalWager(g, "p3", 100).reason, "not-playing-final");
});

test("the final clue is withheld from players until every bet is in", () => {
  const g = atFinal();
  startFinal(g);
  setFinalWager(g, "p1", 300);

  const view = publicState(g, { forHost: false, playerId: "p1" });
  assert.equal(view.final.clue, null, "a player could bet knowing the clue");
  assert.equal(publicState(g, { forHost: true }).final.clue, "The final clue");
});

test("a player sees their own bet and nobody else's", () => {
  const g = atFinal();
  startFinal(g);
  setFinalWager(g, "p1", 300);
  setFinalWager(g, "p2", 200);

  const view = publicState(g, { forHost: false, playerId: "p1" });
  assert.equal(view.final.myWager, 300);
  assert.ok(
    !JSON.stringify(view.final).includes("200"),
    "another player's bet leaked into the player view",
  );
});
```

Add `startFinal`, `finalMaxWager`, `setFinalWager` and `allFinalWagersIn` to the import list.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/game.test.js`
Expected: FAIL — `startFinal` is not exported, so the module does not load.

- [ ] **Step 3: Add the phase and the state**

In `lib/game.js`:

```js
export const PHASE = {
  LOBBY: "lobby",
  BOARD: "board",
  CLUE: "clue",
  WAGER: "wager",
  BUZZED: "buzzed",
  ROUND_END: "round-end",
  /** Everyone is betting on Final Jeopardy, in secret. */
  FINAL_WAGER: "final-wager",
  /** The clue is up and everyone is typing, against the clock. */
  FINAL_CLUE: "final-clue",
  /** Answers are being turned over one at a time. */
  FINAL_REVEAL: "final-reveal",
  DONE: "done",
};

/** How long players have to type a Final Jeopardy answer. */
export const FINAL_ANSWER_SECONDS = 30;
```

In `createGame`, alongside the existing fields:

```js
    /** Final Jeopardy play state; null until the round starts. */
    finalRound: null,
```

- [ ] **Step 4: Make the end of the last board wait for the final**

Replace `endOfBoardPhase`:

```js
/** A finished board pauses for whatever is still to come, or ends the game. */
function endOfBoardPhase(game) {
  if (game.roundIndex + 1 < game.rounds.length) return PHASE.ROUND_END;
  return finalIsToCome(game) ? PHASE.ROUND_END : PHASE.DONE;
}

/** True when Final Jeopardy is switched on, authored, and not yet played. */
export function finalIsToCome(game) {
  return Boolean(game.options?.finalRound && game.final && !game.finalRound);
}
```

- [ ] **Step 5: Add the betting rules**

```js
/**
 * Opens Final Jeopardy's betting.
 *
 * Anyone who cannot bet anything — at or below zero — is entered at $0 rather
 * than excluded. They are still in the round; they simply cannot move their
 * score, and the room must not sit waiting for a bet they cannot place.
 */
export function startFinal(game) {
  if (game.phase !== PHASE.ROUND_END) return fail("wrong-phase");
  if (!finalIsToCome(game)) return fail("no-final");

  game.finalRound = {
    // Who is in the round, fixed now: a latecomer cannot hold up the betting.
    playing: game.players.map((p) => p.id),
    wagers: {},
    answers: {},
    deadline: null,
    order: [],
    revealIndex: 0,
    judged: {},
  };
  for (const p of game.players) {
    if (finalMaxWager(game, p.id) === 0) game.finalRound.wagers[p.id] = 0;
  }

  game.phase = PHASE.FINAL_WAGER;
  return ok();
}

/**
 * The most a player may stake: their own score, and never less than nothing.
 *
 * Unlike a Daily Double there is no playing your way back from this one, so
 * you can never stake more than you hold.
 */
export function finalMaxWager(game, playerId) {
  const player = findPlayer(game, playerId);
  if (!player) return 0;
  return Math.max(player.score, 0);
}

export function setFinalWager(game, playerId, amount) {
  if (game.phase !== PHASE.FINAL_WAGER) return fail("wrong-phase");
  if (!game.finalRound.playing.includes(playerId)) return fail("not-playing-final");

  const bet = Number(amount);
  if (!Number.isInteger(bet)) return fail("bad-amount");
  if (bet % WAGER_STEP !== 0) return fail("bad-increment");
  if (bet < 0 || bet > finalMaxWager(game, playerId)) return fail("out-of-range");

  game.finalRound.wagers[playerId] = bet;
  return ok();
}

/** True once every player in the round has a bet recorded. */
export function allFinalWagersIn(game) {
  if (!game.finalRound) return false;
  return game.finalRound.playing.every((id) => game.finalRound.wagers[id] !== undefined);
}
```

- [ ] **Step 6: Put the final in `publicState`, with the secrecy**

Inside `publicState`, before the returned object:

```js
  // Final Jeopardy is mostly secret, and what is secret depends on who is
  // asking. The clue is host-only until every bet is in — betting with the
  // question in front of you is not Final Jeopardy — and a player sees their
  // own bet and answer and nobody else's until the reveal reaches them.
  let final = null;
  if (game.finalRound) {
    const betsIn = allFinalWagersIn(game);
    final = {
      category: game.final.category,
      clue: forHost || betsIn ? game.final.clue : null,
      answer: forHost ? game.final.answer : null,
      playing: [...game.finalRound.playing],
      waitingOn: game.finalRound.playing.filter(
        (id) => game.finalRound.wagers[id] === undefined,
      ),
      myWager: playerId ? (game.finalRound.wagers[playerId] ?? null) : null,
      myMax: playerId ? finalMaxWager(game, playerId) : null,
      myAnswer: playerId ? (game.finalRound.answers[playerId] ?? null) : null,
      deadline: game.finalRound.deadline,
      order: [...game.finalRound.order],
      revealIndex: game.finalRound.revealIndex,
      revealed: [],
    };
  }
```

and add `final,` to the returned object. `revealed` is filled in Task 4.

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS, including every pre-existing test. A board with `finalRound: false` must still end at `DONE`.

- [ ] **Step 8: Commit**

```bash
git add lib/game.js test/game.test.js
git commit -m "Open Final Jeopardy with a secret bet from everyone"
```

---

### Task 3: Typed answers, and the one timer in the game

**Files:**
- Modify: `lib/game.js`
- Test: `test/game.test.js`

**Interfaces:**
- Consumes: `startFinal`, `setFinalWager`, `PHASE.FINAL_WAGER` from Task 2.
- Produces: `revealFinalClue(game, now)`, `submitFinalAnswer(game, playerId, text, now)`, `closeFinalAnswers(game)`, `FINAL_ANSWER_MAX` (200).

- [ ] **Step 1: Write the failing tests**

```js
/** Everyone has bet; the clue is about to go up. */
function atFinalClue(now = 1_000_000) {
  const g = atFinal();
  startFinal(g);
  setFinalWager(g, "p1", 300);
  setFinalWager(g, "p2", 200);
  revealFinalClue(g, now);
  return g;
}

test("the clue cannot go up until every bet is in", () => {
  const g = atFinal();
  startFinal(g);
  setFinalWager(g, "p1", 300);
  const res = revealFinalClue(g, 1_000_000);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bets-outstanding");
});

test("showing the clue starts a thirty second clock", () => {
  const g = atFinalClue(1_000_000);
  assert.equal(g.phase, PHASE.FINAL_CLUE);
  assert.equal(g.finalRound.deadline, 1_000_000 + FINAL_ANSWER_SECONDS * 1000);
});

test("players can read the clue once the clock is running", () => {
  const g = atFinalClue();
  const view = publicState(g, { forHost: false, playerId: "p1" });
  assert.equal(view.final.clue, "The final clue");
  assert.equal(view.final.answer, null, "the answer must never reach a phone early");
});

test("an answer submitted before the deadline is kept", () => {
  const g = atFinalClue(1_000_000);
  const res = submitFinalAnswer(g, "p1", "  what is a goose  ", 1_000_100);
  assert.equal(res.ok, true);
  assert.equal(g.finalRound.answers["p1"], "what is a goose");
});

test("an answer submitted after the deadline is refused", () => {
  const g = atFinalClue(1_000_000);
  const late = 1_000_000 + FINAL_ANSWER_SECONDS * 1000 + 1;
  const res = submitFinalAnswer(g, "p1", "too slow", late);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "too-late");
  assert.equal(g.finalRound.answers["p1"], undefined);
});

test("an answer landing on the deadline itself still counts", () => {
  const g = atFinalClue(1_000_000);
  const exact = 1_000_000 + FINAL_ANSWER_SECONDS * 1000;
  assert.equal(submitFinalAnswer(g, "p1", "just in time", exact).ok, true);
});

test("a long answer is cut rather than refused", () => {
  const g = atFinalClue();
  submitFinalAnswer(g, "p1", "x".repeat(500), 1_000_100);
  assert.equal(g.finalRound.answers["p1"].length, FINAL_ANSWER_MAX);
});

test("closing the window stops further answers", () => {
  const g = atFinalClue(1_000_000);
  closeFinalAnswers(g);
  const res = submitFinalAnswer(g, "p2", "after the bell", 1_000_200);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "wrong-phase");
});

test("closing twice is harmless", () => {
  const g = atFinalClue(1_000_000);
  // The host ends it early and the timer fires afterwards anyway.
  assert.equal(closeFinalAnswers(g).ok, true);
  const second = closeFinalAnswers(g);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "wrong-phase");
  assert.equal(g.phase, PHASE.FINAL_REVEAL, "a late timer must not undo the close");
});

test("a player sees their own answer and nobody else's", () => {
  const g = atFinalClue();
  submitFinalAnswer(g, "p1", "mine", 1_000_100);
  submitFinalAnswer(g, "p2", "theirs", 1_000_100);

  const view = publicState(g, { forHost: false, playerId: "p1" });
  assert.equal(view.final.myAnswer, "mine");
  assert.ok(
    !JSON.stringify(view.final).includes("theirs"),
    "another player's answer leaked into the player view",
  );
});
```

Add `revealFinalClue`, `submitFinalAnswer`, `closeFinalAnswers`, `FINAL_ANSWER_MAX` and `FINAL_ANSWER_SECONDS` to the import list.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/game.test.js`
Expected: FAIL — `revealFinalClue` is not exported.

- [ ] **Step 3: Implement the three rules**

```js
/** Answers are one line; anything longer is a paste accident. */
export const FINAL_ANSWER_MAX = 200;

/**
 * Puts the clue up and starts the clock.
 *
 * `now` is passed in rather than read, so this stays a plain function and the
 * tests never wait on a real clock.
 */
export function revealFinalClue(game, now) {
  if (game.phase !== PHASE.FINAL_WAGER) return fail("wrong-phase");
  if (!allFinalWagersIn(game)) return fail("bets-outstanding");

  game.finalRound.deadline = now + FINAL_ANSWER_SECONDS * 1000;
  game.phase = PHASE.FINAL_CLUE;
  return ok();
}

export function submitFinalAnswer(game, playerId, text, now) {
  if (game.phase !== PHASE.FINAL_CLUE) return fail("wrong-phase");
  if (!game.finalRound.playing.includes(playerId)) return fail("not-playing-final");
  if (now > game.finalRound.deadline) return fail("too-late");

  game.finalRound.answers[playerId] = String(text ?? "")
    .trim()
    .slice(0, FINAL_ANSWER_MAX);
  return ok();
}

/**
 * Shuts the answer window. Called by the host ending it early, and by the
 * server's timeout when the clock runs out — whichever lands first wins, and
 * the second is a no-op rather than an error worth surfacing.
 */
export function closeFinalAnswers(game) {
  if (game.phase !== PHASE.FINAL_CLUE) return fail("wrong-phase");
  beginFinalReveal(game);
  return ok();
}
```

Note `closeFinalAnswers` takes no `now`: the deadline governs *answers*, and this is only ever called once the clock has run out or the host has said stop. Whichever of those lands first wins; the second is refused by the phase check rather than being an error worth surfacing.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS. `beginFinalReveal` lands in Task 4 — until then, stub it as `function beginFinalReveal(game) { game.phase = PHASE.FINAL_REVEAL; }` and replace it there.

- [ ] **Step 5: Commit**

```bash
git add lib/game.js test/game.test.js
git commit -m "Take typed Final Jeopardy answers against a thirty second clock"
```

---

### Task 4: The reveal, the ruling, and the end

**Files:**
- Modify: `lib/game.js`
- Test: `test/game.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2 and 3.
- Produces: `beginFinalReveal(game)` (real implementation), `judgeFinal(game, correct)`, and `final.revealed` in `publicState`.

- [ ] **Step 1: Write the failing tests**

```js
/** Everyone has answered and the window has shut. */
function atFinalReveal() {
  const g = atFinalClue(1_000_000);
  submitFinalAnswer(g, "p1", "Ann's answer", 1_000_100);
  submitFinalAnswer(g, "p2", "Bo's answer", 1_000_100);
  closeFinalAnswers(g);
  return g;
}

test("the reveal runs poorest first", () => {
  const g = atFinalReveal(); // Ann 1000, Bo 400
  assert.deepEqual(g.finalRound.order, ["p2", "p1"]);
  assert.equal(g.phase, PHASE.FINAL_REVEAL);
});

test("players level on score are revealed in the order they joined", () => {
  const g = atFinal();
  adjustScore(g, "p2", 600); // Both on 1000.
  startFinal(g);
  setFinalWager(g, "p1", 100);
  setFinalWager(g, "p2", 100);
  revealFinalClue(g, 1_000_000);
  closeFinalAnswers(g);
  assert.deepEqual(g.finalRound.order, ["p1", "p2"], "a tie must not be left to chance");
});

test("a correct final answer pays the player's own bet", () => {
  const g = atFinalReveal();
  judgeFinal(g, true); // Bo first, bet 200
  assert.equal(g.players.find((p) => p.id === "p2").score, 600);
});

test("a wrong final answer takes the player's own bet", () => {
  const g = atFinalReveal();
  judgeFinal(g, false);
  assert.equal(g.players.find((p) => p.id === "p2").score, 200);
});

test("final jeopardy never takes anyone below nothing", () => {
  const g = atFinal();
  startFinal(g);
  setFinalWager(g, "p1", 1000); // Ann stakes the lot.
  setFinalWager(g, "p2", 400); // Bo stakes the lot.
  revealFinalClue(g, 1_000_000);
  closeFinalAnswers(g);
  judgeFinal(g, false);
  judgeFinal(g, false);

  for (const p of g.players) assert.ok(p.score >= 0, `${p.name} went to ${p.score}`);
});

test("ruling on the last player ends the game", () => {
  const g = atFinalReveal();
  judgeFinal(g, true);
  assert.equal(g.phase, PHASE.FINAL_REVEAL);
  judgeFinal(g, true);
  assert.equal(g.phase, PHASE.DONE);
});

test("ruling past the last player is refused", () => {
  const g = atFinalReveal();
  judgeFinal(g, true);
  judgeFinal(g, true);
  const res = judgeFinal(g, true);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "wrong-phase");
});

test("a whole room on nothing still finishes the game", () => {
  const g = atFinal();
  adjustScore(g, "p1", -1000);
  adjustScore(g, "p2", -400); // Both on zero.
  startFinal(g);
  assert.equal(allFinalWagersIn(g), true, "nobody can bet, so nobody is waited on");

  revealFinalClue(g, 1_000_000);
  closeFinalAnswers(g);
  judgeFinal(g, true);
  judgeFinal(g, false);

  assert.equal(g.phase, PHASE.DONE);
  for (const p of g.players) assert.equal(p.score, 0, "a zero bet cannot move a score");
});

test("an unsubmitted answer is revealed as blank and scores either way", () => {
  const g = atFinalClue(1_000_000);
  submitFinalAnswer(g, "p1", "only Ann answered", 1_000_100);
  closeFinalAnswers(g);

  const view = publicState(g, { forHost: true });
  const bo = view.final.revealed.find?.((r) => r.playerId === "p2");
  assert.equal(bo, undefined, "nobody is revealed until the host turns them over");
  judgeFinal(g, false); // Bo first, blank answer, bet 200
  assert.equal(g.players.find((p) => p.id === "p2").score, 200);
});

test("only players already turned over appear in the player view", () => {
  const g = atFinalReveal();
  const before = publicState(g, { forHost: false, playerId: "p1" });
  assert.equal(before.final.revealed.length, 0);
  assert.ok(
    !JSON.stringify(before.final).includes("Bo's answer"),
    "an unrevealed answer leaked into the player view",
  );

  judgeFinal(g, true);
  const after = publicState(g, { forHost: false, playerId: "p1" });
  assert.equal(after.final.revealed.length, 1);
  assert.equal(after.final.revealed[0].answer, "Bo's answer");
  assert.equal(after.final.revealed[0].wager, 200);
});
```

Add `judgeFinal` to the import list.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/game.test.js`
Expected: FAIL — `judgeFinal` is not exported.

- [ ] **Step 3: Replace the stub and add the ruling**

```js
/**
 * Fixes the reveal order and turns the first card.
 *
 * Poorest first, as the show does. Ties break by the order players joined,
 * because `sort` is only stable by accident of input and a reveal order that
 * shuffles between renders would look like a bug to the room.
 */
function beginFinalReveal(game) {
  const joinOrder = new Map(game.players.map((p, i) => [p.id, i]));
  game.finalRound.order = [...game.finalRound.playing].sort((a, b) => {
    const byScore = scoreOf(game, a) - scoreOf(game, b);
    return byScore !== 0 ? byScore : joinOrder.get(a) - joinOrder.get(b);
  });
  game.finalRound.revealIndex = 0;
  game.phase = PHASE.FINAL_REVEAL;
}

function scoreOf(game, playerId) {
  return findPlayer(game, playerId)?.score ?? 0;
}

/**
 * The host's verdict on whoever is currently turned over, scored by that
 * player's own bet. The last ruling ends the game.
 */
export function judgeFinal(game, correct) {
  if (game.phase !== PHASE.FINAL_REVEAL) return fail("wrong-phase");

  const playerId = game.finalRound.order[game.finalRound.revealIndex];
  if (!playerId) return fail("nobody-left");

  const player = findPlayer(game, playerId);
  const wager = game.finalRound.wagers[playerId] ?? 0;
  if (player) player.score += correct ? wager : -wager;

  game.finalRound.judged[playerId] = Boolean(correct);
  game.finalRound.revealIndex += 1;
  if (game.finalRound.revealIndex >= game.finalRound.order.length) {
    game.phase = PHASE.DONE;
  }
  return ok();
}
```

- [ ] **Step 4: Expose only what has been turned over**

In `publicState`, replace `revealed: []` with:

```js
      // Everyone before the pointer has been turned over, so their answer and
      // bet are public. Everyone after is still face down.
      revealed: game.finalRound.order
        .slice(0, game.finalRound.revealIndex)
        .map((id) => ({
          playerId: id,
          answer: game.finalRound.answers[id] ?? "",
          wager: game.finalRound.wagers[id] ?? 0,
          correct: game.finalRound.judged[id] ?? null,
        })),
      // The one face-up right now, host-side, so they can read it out.
      current:
        forHost && game.phase === PHASE.FINAL_REVEAL
          ? (() => {
              const id = game.finalRound.order[game.finalRound.revealIndex];
              if (!id) return null;
              return {
                playerId: id,
                answer: game.finalRound.answers[id] ?? "",
                wager: game.finalRound.wagers[id] ?? 0,
              };
            })()
          : null,
```

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/game.js test/game.test.js
git commit -m "Turn the final answers over one at a time and rule on each"
```

---

### Task 5: Server wiring and the one timer

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `startFinal`, `revealFinalClue`, `closeFinalAnswers`, `judgeFinal`, `setFinalWager`, `submitFinalAnswer`, `FINAL_ANSWER_SECONDS`.
- Produces: host messages `startFinal`, `revealFinalClue`, `endFinalAnswers`, `judgeFinal`; player messages `setFinalWager`, `submitFinalAnswer`.

- [ ] **Step 1: Add the host messages**

In `handleHostMessage`, beside `startNextRound`:

```js
    case "startFinal":
      result = G.startFinal(game);
      break;
    case "revealFinalClue":
      result = G.revealFinalClue(game, Date.now());
      if (result.ok) armFinalTimer(room);
      break;
    case "endFinalAnswers":
      // The host calling time early. Cancel the timeout so it cannot fire
      // into a round that has already moved on.
      clearFinalTimer(room);
      result = G.closeFinalAnswers(game);
      break;
    case "judgeFinal":
      result = G.judgeFinal(game, Boolean(msg.correct));
      break;
```

and add to the reasons map:

```js
      "no-final": "This board has no Final Jeopardy.",
      "bets-outstanding": "Someone has not bet yet.",
      "nobody-left": "Everyone has been ruled on.",
```

- [ ] **Step 2: Add the player messages**

In `handlePlayerMessage`, beside the existing `setWager` branch:

```js
  if (msg.type === "setFinalWager") return handleFinalWager(ws, room, msg);
  if (msg.type === "submitFinalAnswer") return handleFinalAnswer(ws, room, msg);
```

and the two handlers, next to `handleWager`:

```js
function handleFinalWager(ws, room, msg) {
  const result = G.setFinalWager(room.game, ws.meta.playerId, Number(msg.amount));
  if (!result.ok) {
    const reasons = {
      "not-playing-final": "You joined after the betting started.",
      "bad-increment": "Bets go in steps of $100.",
      "bad-amount": "That is not a number.",
      "out-of-range": "You cannot bet more than you have.",
      "wrong-phase": "Nothing to bet on right now.",
    };
    return send(ws, {
      type: "wager-rejected",
      reason: result.reason,
      message: reasons[result.reason] ?? "Bet not accepted.",
    });
  }
  broadcast(room);
}

function handleFinalAnswer(ws, room, msg) {
  const result = G.submitFinalAnswer(room.game, ws.meta.playerId, msg.answer, Date.now());
  if (!result.ok) {
    const reasons = {
      "too-late": "Time is up.",
      "not-playing-final": "You joined after the betting started.",
      "wrong-phase": "Nothing to answer right now.",
    };
    return send(ws, {
      type: "answer-rejected",
      reason: result.reason,
      message: reasons[result.reason] ?? "Answer not accepted.",
    });
  }
  broadcast(room);
}
```

- [ ] **Step 3: Own the timer here, not in the rules**

Near the other room helpers:

```js
/**
 * The game's only timer. `lib/game.js` holds the deadline and stays pure; the
 * countdown itself is the server's business, and the handle lives on the room
 * so it can be cancelled when the host calls time early.
 */
function armFinalTimer(room) {
  clearFinalTimer(room);
  room.finalTimer = setTimeout(() => {
    room.finalTimer = null;
    // A no-op if the host already closed the window — the rule checks phase.
    if (G.closeFinalAnswers(room.game).ok) broadcast(room);
  }, FINAL_ANSWER_SECONDS * 1000);
}

function clearFinalTimer(room) {
  if (room.finalTimer) {
    clearTimeout(room.finalTimer);
    room.finalTimer = null;
  }
}
```

Import `FINAL_ANSWER_SECONDS` from `./lib/game.js`. Initialise `finalTimer: null` where a room is created (beside `draft: blankBoard()`), and call `clearFinalTimer(room)` in the housekeeping sweep that deletes an idle room, so a dropped room does not leave a timer holding a reference to it.

- [ ] **Step 4: Send the server's clock with the state**

A phone's clock may be wrong. In `broadcast`, add `now: Date.now()` to both envelopes so each client computes its own offset against `state.final.deadline` once rather than counting locally:

```js
    send(ws, { type: "state", state: hostState, draft: room.draft, now: Date.now() });
```

and the same field on the player envelope.

- [ ] **Step 5: Check it boots**

Run: `npm start`, then `curl -s localhost:3000/api/health`
Expected: `{"ok":true,...}`.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "Wire Final Jeopardy over the socket, and own its timer"
```

---

### Task 6: Authoring Final Jeopardy

**Files:**
- Modify: `lib/board.js`, `public/host.html`, `public/js/host.js`, `public/css/app.css`
- Test: `test/board.test.js`

**Interfaces:**
- Consumes: the `final` field and `options.finalRound` already in the schema.
- Produces: nothing other tasks read.

- [ ] **Step 1: Write the failing test**

Append to `test/board.test.js`:

```js
test("final jeopardy must be complete once its toggle is on", () => {
  const board = playableBoard({ finalRound: true });
  board.final = { category: "Last Things", clue: "", answer: "An answer" };
  const res = validateBoard(board);
  assert.equal(res.ok, false);
  assert.match(res.error, /final/i);
});

test("an unfinished final jeopardy behind an off toggle does not block the game", () => {
  const board = playableBoard({ finalRound: false });
  board.final = { category: "", clue: "", answer: "" };
  assert.equal(validateBoard(board).ok, true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/board.test.js`
Expected: FAIL — the first test gets `ok: true`; nothing validates `final` yet.

- [ ] **Step 3: Validate it**

In `validateBoard`, after the rounds loop and before the `empties.length` check:

```js
  // Same rule as a round: only checked when it is actually going to be played.
  if (board.options.finalRound) {
    const f = board.final;
    if (!f || !f.category.trim() || !f.clue.trim() || !f.answer.trim()) {
      empties.push("final jeopardy is incomplete");
    }
  }
```

- [ ] **Step 4: Enable the checkbox and add the fields**

In `public/host.html`, remove `disabled` from `#s-final`, change its caption from "coming soon" to "one clue, everyone bets", and add below the `#slots` container:

```html
<div class="finalbox" id="finalbox" hidden>
  <h2 class="slots__round">Final Jeopardy</h2>
  <input type="text" id="f-cat" placeholder="Category name" aria-label="Final Jeopardy category" />
  <textarea id="f-clue" placeholder="Clue (a statement, not a question)" aria-label="Final Jeopardy clue"></textarea>
  <input type="text" id="f-ans" placeholder="Answer" aria-label="Final Jeopardy answer" />
</div>
```

In `public/js/host.js`, in `buildSetup` after the rounds loop:

```js
  el("s-final").checked = Boolean(draft.options?.finalRound);
  el("finalbox").hidden = !draft.options?.finalRound;
  if (draft.options?.finalRound) {
    if (!draft.final) draft.final = { category: "", clue: "", answer: "" };
    el("f-cat").value = draft.final.category;
    el("f-clue").value = draft.final.clue;
    el("f-ans").value = draft.final.answer;
  }
```

and at module level, beside the `s-double` listener:

```js
el("s-final").addEventListener("change", (e) => {
  draft.options.finalRound = e.target.checked;
  queueDraftSave();
  buildSetup();
});

for (const [id, key] of [["f-cat", "category"], ["f-clue", "clue"], ["f-ans", "answer"]]) {
  el(id).addEventListener("input", (e) => {
    if (!draft.final) draft.final = { category: "", clue: "", answer: "" };
    draft.final[key] = e.target.value;
    queueDraftSave();
  });
}
```

- [ ] **Step 5: Style it**

```css
.finalbox {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 20px;
}
```

- [ ] **Step 6: Verify by hand**

Start the server. Tick **Final Jeopardy**, confirm the three fields appear, type into them, untick and re-tick and confirm the text survived, then leave the clue blank and confirm **Start the game** is refused with a message naming Final Jeopardy.

- [ ] **Step 7: Commit**

```bash
git add lib/board.js public/host.html public/js/host.js public/css/app.css test/board.test.js
git commit -m "Author Final Jeopardy alongside the boards"
```

---

### Task 7: The host's Final Jeopardy screens

**Files:**
- Modify: `public/host.html`, `public/js/host.js`, `public/css/app.css`

- [ ] **Step 1: Add the screen**

In `public/host.html`, as a sibling of `#roundend`:

```html
<div class="final" id="final" hidden>
  <p class="final__cat" id="fj-cat"></p>
  <p class="final__clue" id="fj-clue"></p>
  <p class="final__status" id="fj-status"></p>
  <div class="final__reveal" id="fj-reveal" hidden>
    <p class="final__who" id="fj-who"></p>
    <p class="final__answer" id="fj-answer"></p>
    <p class="final__bet" id="fj-bet"></p>
  </div>
  <div class="controls">
    <button class="btn btn--go" id="fj-show">Show the clue</button>
    <button class="btn btn--quiet" id="fj-stop">Everyone's in</button>
    <button class="btn btn--yes" id="fj-yes" hidden>Correct</button>
    <button class="btn btn--no" id="fj-no" hidden>Wrong</button>
  </div>
</div>
```

Add a **Start Final Jeopardy** button to the round-end screen, beside `#re-next`:

```html
<button class="btn btn--go" id="re-final" hidden>Start Final Jeopardy</button>
```

- [ ] **Step 2: Render the round-end button correctly**

In `renderRoundEnd`, the button shown depends on what is still to come. `state.round < state.rounds` means another board; otherwise Final Jeopardy is why we stopped:

```js
  const moreBoards = state.round < state.rounds;
  el("re-next").hidden = !moreBoards;
  el("re-final").hidden = moreBoards;
  if (moreBoards) el("re-next").textContent = `Start round ${state.round + 1}`;
```

- [ ] **Step 3: Render the final screen**

```js
/** The host's view of Final Jeopardy, across all three of its phases. */
function renderFinal(state) {
  const phases = ["final-wager", "final-clue", "final-reveal"];
  const on = phases.includes(state.phase);
  el("final").hidden = !on;
  if (!on) return;

  const f = state.final;
  el("fj-cat").textContent = f.category;
  el("fj-clue").textContent = f.clue ?? "";

  const waiting = f.waitingOn
    .map((id) => state.players.find((p) => p.id === id)?.name ?? "?")
    .join(", ");

  el("fj-show").hidden = state.phase !== "final-wager" || f.waitingOn.length > 0;
  el("fj-stop").hidden = state.phase !== "final-clue";
  el("fj-yes").hidden = state.phase !== "final-reveal";
  el("fj-no").hidden = state.phase !== "final-reveal";
  el("fj-reveal").hidden = state.phase !== "final-reveal" || !f.current;

  if (state.phase === "final-wager") {
    el("fj-status").textContent = waiting
      ? `Waiting on ${waiting}.`
      : "Everyone has bet. Show the clue when the room is ready.";
  } else if (state.phase === "final-clue") {
    el("fj-status").textContent = "Answering…";
  } else if (f.current) {
    const who = state.players.find((p) => p.id === f.current.playerId);
    el("fj-who").textContent = who?.name ?? "?";
    el("fj-answer").textContent = f.current.answer || "— nothing written —";
    el("fj-bet").textContent = "Bet $" + f.current.wager;
    el("fj-status").textContent =
      `${f.revealIndex + 1} of ${f.order.length}, poorest first.`;
  }
}
```

Call `renderFinal(state)` from `render`, beside `renderRoundEnd(state)`. Wire the four buttons at module level:

```js
el("re-final").addEventListener("click", () => socket.send({ type: "startFinal" }));
el("fj-show").addEventListener("click", () => socket.send({ type: "revealFinalClue" }));
el("fj-stop").addEventListener("click", () => socket.send({ type: "endFinalAnswers" }));
el("fj-yes").addEventListener("click", () => socket.send({ type: "judgeFinal", correct: true }));
el("fj-no").addEventListener("click", () => socket.send({ type: "judgeFinal", correct: false }));
```

- [ ] **Step 4: Style it as a takeover**

Like `.roundend` and for the same reason — it must not render below a full-height `#game`:

```css
.final {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: var(--stage);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 40px 20px;
}

.final__cat {
  font-family: var(--display);
  font-size: clamp(1.6rem, 4vw, 2.6rem);
  text-transform: uppercase;
  color: var(--brass);
  margin: 0;
}

.final__clue {
  font-size: clamp(1.4rem, 3.4vw, 2.6rem);
  color: var(--cream);
  max-width: 24ch;
  text-align: center;
  margin: 0;
}

.final__who {
  font-family: var(--display);
  font-size: clamp(1.6rem, 4vw, 2.6rem);
  color: var(--cream);
  margin: 0;
}

.final__answer {
  font-size: clamp(1.3rem, 3vw, 2.2rem);
  color: var(--brass);
  margin: 0;
}

.final__bet,
.final__status {
  color: var(--cream-dim);
  margin: 0;
}
```

- [ ] **Step 5: Verify by hand**

Play a one-round game with Final Jeopardy on, two phones. Confirm: the round-end screen offers **Start Final Jeopardy** and not "Start round 2"; the host sees who has yet to bet; **Show the clue** only appears once everyone has; the reveal names each player poorest first with their answer and bet; and the game reaches the finished screen after the last ruling. Confirm the screen is a takeover, not below the fold.

- [ ] **Step 6: Commit**

```bash
git add public/host.html public/js/host.js public/css/app.css
git commit -m "Give the host a Final Jeopardy screen"
```

---

### Task 8: The phone's Final Jeopardy screens

**Files:**
- Modify: `public/play.html`, `public/js/play.js`, `public/css/app.css`

- [ ] **Step 1: Add the markup**

In `public/play.html`, inside `.play__main` beside the existing `#p-wager` pad:

```html
<div class="finalplay" id="p-final" hidden>
  <p class="finalplay__title">Final Jeopardy</p>
  <p class="finalplay__clock" id="p-clock" hidden></p>
  <div id="p-final-answer" hidden>
    <textarea id="p-answer" maxlength="200" placeholder="Your answer" aria-label="Your Final Jeopardy answer"></textarea>
    <button class="btn btn--go" id="p-answer-go">Lock it in</button>
  </div>
  <p class="finalplay__note" id="p-final-note"></p>
</div>
```

- [ ] **Step 2: Reuse the wager pad at a $0 floor**

The existing pad hardcodes a floor of one step. Give it a floor from the state so Final Jeopardy can start at $0:

```js
function stepWager(by) {
  const step = state?.wagerStep ?? 100;
  const floor = state?.phase === "final-wager" ? 0 : step;
  const max = wagerCeiling();
  wagerAmount = Math.min(Math.max((wagerAmount ?? floor) + by * step, floor), max);
  renderWager();
}

/** The ceiling differs between a Daily Double and Final Jeopardy. */
function wagerCeiling() {
  if (state?.phase === "final-wager") return state.final?.myMax ?? 0;
  return state?.wagerMax ?? state?.wagerStep ?? 100;
}
```

`renderWager` is rewritten the same way — the hardcoded `step` floor becomes
the phase's floor, in the amount default, in both buttons' disabled checks and
in the caption:

```js
function renderWager() {
  const step = state?.wagerStep ?? 100;
  const final = state?.phase === "final-wager";
  const floor = final ? 0 : step;
  const max = wagerCeiling();
  const shown = wagerAmount ?? floor;

  el("p-wager-amount").textContent = "$" + shown;
  el("p-wager-limit").textContent = `Anything from $${floor} to $${max}, in hundreds.`;
  el("p-wager-down").disabled = shown <= floor;
  el("p-wager-up").disabled = shown >= max;
}
```

`sendWager` sends the right message for the phase:

```js
function sendWager() {
  if (wagerSent || wagerAmount == null) return;
  wagerSent = true;
  socket.send(
    state?.phase === "final-wager"
      ? { type: "setFinalWager", amount: wagerAmount }
      : { type: "setWager", amount: wagerAmount },
  );
}
```

- [ ] **Step 3: Render the three final phases**

```js
/** The phone's view of Final Jeopardy. */
function renderFinal() {
  const phase = state.phase;
  const f = state.final;
  const onFinal = ["final-wager", "final-clue", "final-reveal"].includes(phase);
  el("p-final").hidden = !onFinal;
  if (!onFinal) {
    stopClock();
    return;
  }

  const betting = phase === "final-wager";
  const mine = f.playing.includes(myId);
  const alreadyBet = f.myWager !== null;

  // The pad is the existing Daily Double pad, at a $0 floor.
  wagerPad.hidden = !(betting && mine && !alreadyBet);
  buzzer.hidden = true;
  el("p-final-answer").hidden = !(phase === "final-clue" && mine && f.myAnswer === null);
  el("p-clock").hidden = phase !== "final-clue";

  if (betting) {
    el("p-final-note").textContent = !mine
      ? "You joined after the betting started — sit this one out."
      : alreadyBet
        ? `You bet $${f.myWager}. Waiting for everyone else.`
        : f.myMax === 0
          ? "You have nothing to bet, so you are in at $0."
          : "";
    if (mine && !alreadyBet && wagerAmount == null) wagerAmount = 0;
    if (mine && !alreadyBet) renderWager();
  } else if (phase === "final-clue") {
    el("p-final-note").textContent =
      f.myAnswer !== null ? `Locked in: ${f.myAnswer}` : "";
    startClock(f.deadline);
  } else {
    el("p-final-note").textContent = "Answers are going up on the big screen.";
  }
}
```

- [ ] **Step 4: Count down against the deadline, not locally**

```js
let clockTimer = null;
/** Offset between this phone's clock and the server's, measured once. */
let clockSkew = 0;

function startClock(deadline) {
  if (clockTimer || !deadline) return;
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - (Date.now() + clockSkew)) / 1000));
    el("p-clock").textContent = left + "s";
    if (left === 0) stopClock();
  };
  tick();
  clockTimer = setInterval(tick, 250);
}

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
}
```

Set the skew wherever a `state` message arrives, from the `now` the server sends:

```js
      if (msg.type === "state") {
        if (typeof msg.now === "number") clockSkew = msg.now - Date.now();
        state = msg.state;
        render();
        return;
      }
```

Measuring once against the server's clock means a phone with a wrong clock still shows the right number, and one that reconnects mid-round resumes where the round actually is rather than restarting at 30.

- [ ] **Step 5: Send the answer**

```js
el("p-answer-go").addEventListener("click", () => {
  const text = el("p-answer").value.trim();
  socket.send({ type: "submitFinalAnswer", answer: text });
});
```

and handle the refusal beside `wager-rejected`:

```js
      if (msg.type === "answer-rejected") {
        toast(msg.message);
        render();
      }
```

Call `renderFinal()` from `render()`, and make the existing buzzer/clue block skip its work while a final phase is on, so the two do not fight over `#p-meta`.

- [ ] **Step 6: Style it**

```css
.finalplay {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: 100%;
}

.finalplay__title {
  font-family: var(--display);
  font-size: clamp(1.8rem, 9vw, 3rem);
  text-transform: uppercase;
  color: var(--brass);
  margin: 0;
}

.finalplay__clock {
  font-family: var(--display);
  font-size: clamp(2.4rem, 12vw, 4rem);
  color: var(--cream);
  margin: 0;
}

.finalplay__note {
  color: var(--cream-dim);
  text-align: center;
  margin: 0;
}

#p-answer {
  width: 100%;
  min-height: 90px;
  font-size: 1.1rem;
}
```

- [ ] **Step 7: Verify by hand**

Two phone-sized windows. Confirm: the pad starts at $0 and will not exceed that player's score; a player on $0 sees the forced-zero note and no pad; the clue appears only after the last bet; the countdown runs and the input locks at zero; a locked-in answer shows back; and neither phone can see the other's bet or answer before the reveal.

- [ ] **Step 8: Commit**

```bash
git add public/play.html public/js/play.js public/css/app.css
git commit -m "Let players bet and type an answer on their phone"
```

---

### Task 9: End-to-end coverage and the docs

**Files:**
- Modify: `scripts/smoke.mjs`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Play a Final Jeopardy over real sockets**

Add a section after the two-round game, reusing `playEveryClue`:

```js
console.log("\nFinal Jeopardy");
const room4 = await newRoom();
const h4 = await client(() => ({
  type: "hello", role: "host", code: room4.code, hostToken: room4.hostToken,
}));
const f1 = await client(() => ({
  type: "hello", role: "player", code: room4.code, playerId: "f-1", name: "Fin",
}));
const f2 = await client(() => ({
  type: "hello", role: "player", code: room4.code, playerId: "f-2", name: "Gus",
}));
await wait(150);

const finalDraft = makeBoard();
finalDraft.options.finalRound = true;
finalDraft.final = { category: "Endings", clue: "The last clue", answer: "The last answer" };
h4.send({ type: "saveDraft", draft: finalDraft });
await wait(150);
h4.send({ type: "startGame" });
await wait(200);

h4.send({ type: "adjustScore", playerId: "f-1", delta: 1000 });
h4.send({ type: "adjustScore", playerId: "f-2", delta: 400 });
await wait(150);

await playEveryClue(h4, f1, "f-1");
check("the board pauses for the final", h4.state.phase === "round-end", h4.state.phase);

h4.send({ type: "startFinal" });
await wait(200);
check("betting opened", h4.state.phase === "final-wager", h4.state.phase);
check(
  "the clue is withheld from phones while bets are open",
  f1.state.final.clue === null,
  JSON.stringify(f1.state.final.clue),
);

f1.send({ type: "setFinalWager", amount: 600 });
f2.send({ type: "setFinalWager", amount: 400 });
await wait(250);
check(
  "a player sees their own bet only",
  f1.state.final.myWager === 600 && !JSON.stringify(f1.state.final).includes("400"),
);

h4.send({ type: "revealFinalClue" });
await wait(200);
check("the clue is up", h4.state.phase === "final-clue", h4.state.phase);
check("phones can read it now", f1.state.final.clue === "The last clue");
check("a deadline came with it", typeof f1.state.final.deadline === "number");

f1.send({ type: "submitFinalAnswer", answer: "Fin's answer" });
await wait(200);
check(
  "an answer is private until the reveal",
  !JSON.stringify(f2.state.final).includes("Fin's answer"),
);

h4.send({ type: "endFinalAnswers" });
await wait(200);
check("the reveal started", h4.state.phase === "final-reveal", h4.state.phase);
check("poorest first", h4.state.final.order[0] === "f-2", JSON.stringify(h4.state.final.order));

h4.send({ type: "judgeFinal", correct: false }); // Gus, blank, bet 400
await wait(200);
h4.send({ type: "judgeFinal", correct: true }); // Fin, bet 600
await wait(250);

const fin = h4.state.players.find((p) => p.id === "f-1");
const gus = h4.state.players.find((p) => p.id === "f-2");
check("the winner was paid their own bet", fin.score === 1600, String(fin.score));
check("the loser lost their own bet", gus.score === 0, String(gus.score));
check("nobody went below nothing", fin.score >= 0 && gus.score >= 0);
check("the game is over", h4.state.phase === "done", h4.state.phase);
```

- [ ] **Step 2: Assert a late answer is refused by the server**

The 30-second wait is too long for the smoke run, so prove the *rule* rather than the clock: submit after the host has closed the window.

```js
h4.send({ type: "submitFinalAnswer", answer: "far too late" });
await wait(200);
check(
  "an answer after the window is refused",
  f1.state.final.revealed.every((r) => r.answer !== "far too late"),
);
```

Place this immediately after the reveal starts.

- [ ] **Step 3: Run it**

Run: `npm start` in one terminal, `npm run smoke` in another, **five times** — the Daily Double squares are still random.
Expected: ALL CHECKS PASSED every time.

- [ ] **Step 4: Update the docs**

In `README.md`, under *Playing*, add Final Jeopardy as the closing step: both toggles are set while building the board, everyone bets $0 to their own score in hundreds, a player on nothing is in at $0, the clue is hidden until the last bet, 30 seconds to type, then answers turned over poorest first with their bet showing. In *Known limits*, note that a player who joins after the betting opens sits Final Jeopardy out, and drop Final Jeopardy from the "Not yet built" bullet, leaving sound.

In `CLAUDE.md`, replace the *Not built yet* section with sound alone, and add a short Final Jeopardy section: the three phases, that `game.final` is the authored clue while `game.finalRound` is the play state, that the rules hold a deadline and take `now` while the server owns the `setTimeout`, and the secrecy table — the clue until every bet is in, and each player's wager and answer until the reveal reaches them.

- [ ] **Step 5: Full verification**

Run: `npm test` — every test passing.
Run: `npm run smoke` — ALL CHECKS PASSED.
Then play a whole game in a browser: a board, Final Jeopardy, two phones, including a player on $0 and a player who lets the clock run out without answering.

- [ ] **Step 6: Commit and open the PR**

```bash
git add scripts/smoke.mjs README.md CLAUDE.md
git commit -m "Cover Final Jeopardy end to end"
git push -u origin <branch>
gh pr create --title "Final Jeopardy" --body "..."
```

The PR body carries the test plan: unit counts before and after, how many smoke runs, and what was checked in the browser. Do not merge.
