/**
 * The game rules, as pure functions over a plain state object.
 *
 * Nothing in here knows about HTTP, WebSockets, or the DOM — which is what makes
 * the buzz/lockout rules testable without a browser, a phone, or a network. The
 * server owns a `Game` per room and is the only writer; every mutation goes
 * through a function here so there is exactly one place the rules live.
 *
 * Every mutating function returns `{ ok: true }` or `{ ok: false, reason }`
 * rather than throwing, because most failures are ordinary race outcomes (two
 * people buzzing at once) rather than bugs.
 */

import { playedRounds } from "./board.js";

export const PHASE = {
  LOBBY: "lobby",
  BOARD: "board",
  CLUE: "clue",
  /** A Daily Double is open and its finder is choosing a wager. */
  WAGER: "wager",
  BUZZED: "buzzed",
  /** A board is finished and another round is still to come. */
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

/** Round 1 hides one Daily Double; round 2 hides two, as the show does. */
export const DAILY_DOUBLES_PER_ROUND = [1, 2];

export const MAX_PLAYERS = 12;

/**
 * Wagers are whole hundreds, like every value on the board. A free-text bet of
 * $46 is the kind of thing that derails a party for a minute while everyone
 * works out the arithmetic.
 */
export const WAGER_STEP = 100;

const ok = () => ({ ok: true });
const fail = (reason) => ({ ok: false, reason });

export function createGame(code) {
  return {
    code,
    phase: PHASE.LOBBY,
    players: [],
    board: null,
    /** `{ c, q }` — category index and clue index — or null. */
    activeClue: null,
    buzzersArmed: false,
    buzzedPlayer: null,
    /** Player ids that already answered this clue wrong. */
    lockedOut: [],
    answerRevealed: false,
    /** During PHASE.WAGER, the player the host says found the Daily Double. */
    wagerPlayer: null,
    /** Every round that will be played; `board` is whichever one is live. */
    rounds: [],
    roundIndex: 0,
    options: { doubleRound: false, finalRound: false },
    final: null,
    /** Final Jeopardy play state; null until the round starts. */
    finalRound: null,
    createdAt: Date.now(),
  };
}

// ------------------------------------------------------------------ players

function findPlayer(game, id) {
  return game.players.find((p) => p.id === id);
}

/** Appends " 2", " 3", … if another player already holds this name. */
function uniqueName(game, name, exceptId) {
  const taken = (candidate) =>
    game.players.some(
      (p) => p.id !== exceptId && p.name.toLowerCase() === candidate.toLowerCase(),
    );
  if (!taken(name)) return name;
  for (let n = 2; n < 100; n++) {
    const candidate = `${name} ${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${name} ${Date.now()}`;
}

/**
 * Joins a player, or reconnects one who already has this id.
 *
 * Reconnecting keeps the existing score and name — a phone browser that gets
 * backgrounded and reopened must not reset the player or create a duplicate.
 */
export function addPlayer(game, { id, name }) {
  const existing = findPlayer(game, id);
  if (existing) {
    existing.connected = true;
    return ok();
  }

  const trimmed = String(name ?? "").trim().slice(0, 20);
  if (!trimmed) return fail("blank-name");
  if (game.players.length >= MAX_PLAYERS) return fail("game-full");

  game.players.push({
    id,
    name: uniqueName(game, trimmed, id),
    score: 0,
    connected: true,
  });
  return ok();
}

/**
 * Marks a player disconnected. It deliberately does *not* delete them — their
 * score stays on the board and they keep it if they rejoin.
 */
export function removePlayer(game, id) {
  const player = findPlayer(game, id);
  if (!player) return fail("unknown-player");
  player.connected = false;
  return ok();
}

export function renamePlayer(game, id, name) {
  const player = findPlayer(game, id);
  if (!player) return fail("unknown-player");
  const trimmed = String(name ?? "").trim().slice(0, 20);
  if (!trimmed) return fail("blank-name");
  player.name = uniqueName(game, trimmed, id);
  return ok();
}

export function adjustScore(game, id, delta) {
  const player = findPlayer(game, id);
  if (!player) return fail("unknown-player");
  const amount = Number(delta);
  if (!Number.isFinite(amount)) return fail("bad-amount");
  player.score += Math.trunc(amount);
  return ok();
}

// ------------------------------------------------------------------ setup

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

/**
 * `random` is injected so tests can pin the Daily Double to a known square;
 * nothing else in here is non-deterministic.
 */
export function startGame(game, { random = Math.random } = {}) {
  if (game.phase !== PHASE.LOBBY) return fail("already-started");
  if (!game.board) return fail("no-board");
  if (game.players.length === 0) return fail("no-players");
  placeDailyDoubles(game, random, DAILY_DOUBLES_PER_ROUND[0]);
  game.phase = PHASE.BOARD;
  return ok();
}

/**
 * Hides `count` Daily Doubles, preferring one per category — the show never
 * puts two in the same column, but a short round may leave no choice. Squares
 * are always distinct.
 *
 * They are picked here rather than while the host authors the board so that the
 * host is surprised too — they are in the room, and a host who knows where one
 * is gives it away.
 */
function placeDailyDoubles(game, random, count) {
  const squares = game.board.categories.flatMap((cat, c) =>
    cat.clues.map((_, q) => ({ c, q })),
  );
  for (const { c, q } of squares) game.board.categories[c].clues[q].dailyDouble = false;
  if (squares.length === 0) return;

  const pick = (from) => from[Math.min(Math.floor(random() * from.length), from.length - 1)];

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

/** The biggest value anywhere on the board — the floor for a wager ceiling. */
function highestValue(game) {
  const values = game.board.categories.flatMap((cat) => cat.clues.map((cl) => cl.value));
  return values.length ? Math.max(...values) : 0;
}

// ------------------------------------------------------------------ clues

function clueAt(game, c, q) {
  const category = game.board?.categories?.[c];
  if (!category) return null;
  return category.clues?.[q] ?? null;
}

export function openClue(game, c, q) {
  if (game.phase !== PHASE.BOARD) return fail("wrong-phase");
  if (!Number.isInteger(c) || !Number.isInteger(q) || c < 0 || q < 0) {
    return fail("out-of-range");
  }
  const clue = clueAt(game, c, q);
  if (!clue) return fail("out-of-range");
  if (clue.revealed) return fail("already-revealed");

  game.activeClue = { c, q };
  // A Daily Double belongs to one player, so it detours through wagering
  // instead of opening to the room.
  game.phase = clue.dailyDouble ? PHASE.WAGER : PHASE.CLUE;
  // Buzzers stay disarmed until the host has finished reading the clue aloud.
  game.buzzersArmed = false;
  game.buzzedPlayer = null;
  game.lockedOut = [];
  game.answerRevealed = false;
  game.wagerPlayer = null;
  return ok();
}

// ------------------------------------------------------------ daily double

/** The host names whoever found the Daily Double; only they may wager. */
export function assignDailyDouble(game, playerId) {
  if (game.phase !== PHASE.WAGER) return fail("wrong-phase");
  if (!findPlayer(game, playerId)) return fail("unknown-player");
  game.wagerPlayer = playerId;
  return ok();
}

/**
 * The most a player may bet: their own score, or the biggest value on the
 * board if they are behind that — so someone on zero or in the red still has
 * a real bet available, exactly as the show plays it.
 */
export function maxWager(game, playerId) {
  const player = findPlayer(game, playerId);
  if (!player) return 0;
  return Math.max(player.score, highestValue(game));
}

/**
 * Locks in the bet and hands the clue to that player alone.
 *
 * Setting `buzzedPlayer` here is what lets the ordinary `judge()` path score a
 * Daily Double without a special case: it already pays `clue.wager ?? value`.
 */
export function setWager(game, playerId, amount) {
  if (game.phase !== PHASE.WAGER) return fail("wrong-phase");
  if (!game.wagerPlayer) return fail("no-wager-player");
  if (playerId !== game.wagerPlayer) return fail("not-your-wager");

  const bet = Number(amount);
  if (!Number.isInteger(bet)) return fail("bad-amount");
  if (bet % WAGER_STEP !== 0) return fail("bad-increment");
  if (bet < WAGER_STEP || bet > maxWager(game, playerId)) return fail("out-of-range");

  const { c, q } = game.activeClue;
  clueAt(game, c, q).wager = bet;

  game.buzzedPlayer = playerId;
  game.buzzersArmed = false;
  game.phase = PHASE.BUZZED;
  return ok();
}

export function armBuzzers(game) {
  if (game.phase !== PHASE.CLUE) return fail("wrong-phase");
  if (game.answerRevealed) return fail("answer-already-revealed");
  if (eligiblePlayers(game).length === 0) return fail("everyone-locked-out");
  game.buzzersArmed = true;
  game.buzzedPlayer = null;
  return ok();
}

export function disarmBuzzers(game) {
  game.buzzersArmed = false;
  return ok();
}

function eligiblePlayers(game) {
  return game.players.filter((p) => !game.lockedOut.includes(p.id));
}

/**
 * Claims the buzz for a player. The server calls this from a single-threaded
 * event loop, so "first call wins" is the whole of the ordering guarantee —
 * whichever message the server read off the socket first gets here first.
 *
 * `at` is recorded for display only; it is never used to decide the winner,
 * because a client-supplied timestamp is trivially spoofable.
 */
export function buzz(game, playerId, at = Date.now()) {
  if (!findPlayer(game, playerId)) return fail("unknown-player");
  if (game.lockedOut.includes(playerId)) return fail("locked-out");
  // Checked before the phase, because the losing side of a genuine race arrives
  // once the phase has already moved to BUZZED. Reporting "wrong-phase" there
  // would show the player a confusing message for the most ordinary outcome.
  if (game.buzzedPlayer) return fail("too-late");
  if (game.phase !== PHASE.CLUE) return fail("wrong-phase");
  if (!game.buzzersArmed) return fail("not-armed");

  game.buzzedPlayer = playerId;
  game.buzzedAt = at;
  game.phase = PHASE.BUZZED;
  game.buzzersArmed = false;
  return ok();
}

/**
 * The host's verdict on whoever is buzzed in.
 *
 * Correct: award the clue value and close the clue.
 * Wrong: deduct the value, lock that player out, and re-open the clue so the
 * others can still buzz — which is how the real show handles it.
 */
export function judge(game, correct) {
  if (game.phase !== PHASE.BUZZED) return fail("wrong-phase");
  const player = findPlayer(game, game.buzzedPlayer);
  if (!player) return fail("no-buzzer");

  const { c, q } = game.activeClue;
  const clue = clueAt(game, c, q);
  const value = clue.wager ?? clue.value;

  if (correct) {
    player.score += value;
    return closeClue(game);
  }

  player.score -= value;
  // A Daily Double was never open to the room, so a miss ends it rather than
  // throwing it to players who had no chance to wager on it.
  if (clue.dailyDouble) return closeClue(game);

  game.lockedOut.push(player.id);
  game.buzzedPlayer = null;
  game.phase = PHASE.CLUE;
  // Re-arm only if somebody is still allowed to buzz.
  game.buzzersArmed = eligiblePlayers(game).length > 0;
  return ok();
}

export function revealAnswer(game) {
  if (!game.activeClue) return fail("no-clue");
  game.answerRevealed = true;
  game.buzzersArmed = false;
  return ok();
}

/** Marks the active clue used and returns to the board. Scores nobody. */
export function closeClue(game) {
  if (!game.activeClue) return fail("no-clue");
  const { c, q } = game.activeClue;
  const clue = clueAt(game, c, q);
  if (clue) clue.revealed = true;

  game.activeClue = null;
  game.buzzedPlayer = null;
  game.buzzersArmed = false;
  game.lockedOut = [];
  game.answerRevealed = false;
  game.wagerPlayer = null;
  game.phase = isBoardComplete(game) ? endOfBoardPhase(game) : PHASE.BOARD;
  return ok();
}

/** A finished board pauses for whatever is still to come, or ends the game. */
function endOfBoardPhase(game) {
  if (game.roundIndex + 1 < game.rounds.length) return PHASE.ROUND_END;
  return finalIsToCome(game) ? PHASE.ROUND_END : PHASE.DONE;
}

/** True when Final Jeopardy is switched on, authored, and not yet played. */
export function finalIsToCome(game) {
  return Boolean(game.options?.finalRound && game.final && !game.finalRound);
}

export function isBoardComplete(game) {
  if (!game.board) return false;
  return game.board.categories.every((cat) => cat.clues.every((clue) => clue.revealed));
}

// ------------------------------------------------------------ final jeopardy

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
 * the second is refused by the phase check rather than being an error worth
 * surfacing.
 */
export function closeFinalAnswers(game) {
  if (game.phase !== PHASE.FINAL_CLUE) return fail("wrong-phase");
  beginFinalReveal(game);
  return ok();
}

// TEMPORARY: replaced by the real sort in Task 4.
function beginFinalReveal(game) {
  game.phase = PHASE.FINAL_REVEAL;
}

// ------------------------------------------------------------------ serialization

/**
 * The state as sent over the wire.
 *
 * `forHost: false` strips unrevealed answers — the phones are untrusted, so the
 * answer must not be in the payload at all rather than merely hidden in the UI.
 */
export function publicState(game, { forHost, playerId } = {}) {
  const clue = game.activeClue ? clueAt(game, game.activeClue.c, game.activeClue.q) : null;

  let activeClue = null;
  if (clue) {
    // While the bet is open the clue itself is host-only: a player who can read
    // it knows whether to bet big, which is the whole game of a Daily Double.
    const wagering = game.phase === PHASE.WAGER;
    activeClue = {
      c: game.activeClue.c,
      q: game.activeClue.q,
      category: game.board.categories[game.activeClue.c].title,
      value: clue.wager ?? clue.value,
      dailyDouble: Boolean(clue.dailyDouble),
      clue: forHost || !wagering ? clue.clue : null,
      answer: forHost || game.answerRevealed ? clue.answer : null,
    };
  }

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
      // `!= null` rather than truthiness: an id is an opaque string and the
      // safe default when there is no id is to disclose nothing, so the test
      // has to be about presence, not emptiness.
      myWager: playerId != null ? (game.finalRound.wagers[playerId] ?? null) : null,
      myMax: playerId != null ? finalMaxWager(game, playerId) : null,
      myAnswer: playerId != null ? (game.finalRound.answers[playerId] ?? null) : null,
      deadline: game.finalRound.deadline,
      order: [...game.finalRound.order],
      revealIndex: game.finalRound.revealIndex,
      revealed: [],
    };
  }

  return {
    code: game.code,
    /** Which player this payload was built for; null for the host. */
    you: playerId ?? null,
    final,
    phase: game.phase,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
    })),
    board: game.board
      ? {
          categories: game.board.categories.map((cat) => ({
            title: cat.title,
            clues: cat.clues.map((cl) => ({ value: cl.value, revealed: cl.revealed })),
          })),
        }
      : null,
    activeClue,
    buzzersArmed: game.buzzersArmed,
    buzzedPlayer: game.buzzedPlayer,
    lockedOut: [...game.lockedOut],
    answerRevealed: game.answerRevealed,
    // Note the board above carries only value and revealed — never
    // `dailyDouble`, or a player could read its location straight off the wire.
    wagerPlayer: game.wagerPlayer ?? null,
    wagerMax: game.wagerPlayer ? maxWager(game, game.wagerPlayer) : null,
    wagerStep: WAGER_STEP,
    round: game.roundIndex + 1,
    rounds: game.rounds.length,
    complete: isBoardComplete(game),
  };
}
