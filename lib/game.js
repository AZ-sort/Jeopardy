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

export const PHASE = {
  LOBBY: "lobby",
  BOARD: "board",
  CLUE: "clue",
  BUZZED: "buzzed",
  DONE: "done",
};

export const MAX_PLAYERS = 12;

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

export function setBoard(game, board) {
  if (game.phase !== PHASE.LOBBY) return fail("already-started");
  game.board = board;
  return ok();
}

export function startGame(game) {
  if (game.phase !== PHASE.LOBBY) return fail("already-started");
  if (!game.board) return fail("no-board");
  if (game.players.length === 0) return fail("no-players");
  game.phase = PHASE.BOARD;
  return ok();
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
  game.phase = PHASE.CLUE;
  // Buzzers stay disarmed until the host has finished reading the clue aloud.
  game.buzzersArmed = false;
  game.buzzedPlayer = null;
  game.lockedOut = [];
  game.answerRevealed = false;
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
  game.phase = isBoardComplete(game) ? PHASE.DONE : PHASE.BOARD;
  return ok();
}

export function isBoardComplete(game) {
  if (!game.board) return false;
  return game.board.categories.every((cat) => cat.clues.every((clue) => clue.revealed));
}

// ------------------------------------------------------------------ serialization

/**
 * The state as sent over the wire.
 *
 * `forHost: false` strips unrevealed answers — the phones are untrusted, so the
 * answer must not be in the payload at all rather than merely hidden in the UI.
 */
export function publicState(game, { forHost }) {
  const clue = game.activeClue ? clueAt(game, game.activeClue.c, game.activeClue.q) : null;

  let activeClue = null;
  if (clue) {
    activeClue = {
      c: game.activeClue.c,
      q: game.activeClue.q,
      category: game.board.categories[game.activeClue.c].title,
      value: clue.wager ?? clue.value,
      clue: clue.clue,
      answer: forHost || game.answerRevealed ? clue.answer : null,
    };
  }

  return {
    code: game.code,
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
    complete: isBoardComplete(game),
  };
}
