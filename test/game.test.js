import test from "node:test";
import assert from "node:assert/strict";

import {
  createGame,
  addPlayer,
  removePlayer,
  setBoard,
  startGame,
  openClue,
  armBuzzers,
  buzz,
  judge,
  revealAnswer,
  closeClue,
  adjustScore,
  renamePlayer,
  publicState,
  isBoardComplete,
  assignDailyDouble,
  setWager,
  maxWager,
  startNextRound,
  startFinal,
  finalMaxWager,
  setFinalWager,
  allFinalWagersIn,
  judgeFinal,
  revealFinalClue,
  submitFinalAnswer,
  closeFinalAnswers,
  FINAL_ANSWER_SECONDS,
  FINAL_ANSWER_MAX,
  PHASE,
} from "../lib/game.js";

/** A 2-category board with 5 clues each, enough to exercise every rule. */
function testBoard() {
  const cat = (title) => ({
    title,
    clues: [100, 200, 300, 400, 500].map((value) => ({
      value,
      clue: `${title} clue for $${value}`,
      answer: `${title} answer for $${value}`,
      revealed: false,
      wager: null,
      dailyDouble: false,
    })),
  });
  return { categories: [cat("Alpha"), cat("Beta")] };
}

/** Puts the Daily Double on the very last clue, out of the way of other tests. */
const LAST_CLUE = () => 0.999;
/** Puts the Daily Double on the very first clue, Alpha $100. */
const FIRST_CLUE = () => 0;

/** Wraps a single-board fixture in the round wrapper `setBoard` now takes. */
function wrapped(options = {}) {
  return {
    rounds: [testBoard(), testBoard()],
    final: null,
    options: { doubleRound: false, finalRound: false, ...options },
  };
}

function twoPlayerGame(random = LAST_CLUE) {
  const g = createGame("ABCD");
  addPlayer(g, { id: "p1", name: "Ann" });
  addPlayer(g, { id: "p2", name: "Bo" });
  setBoard(g, wrapped());
  startGame(g, { random });
  return g;
}

/** A game whose Daily Double is Alpha $100, already open and assigned to Ann. */
function dailyDoubleGame() {
  const g = twoPlayerGame(FIRST_CLUE);
  openClue(g, 0, 0);
  assignDailyDouble(g, "p1");
  return g;
}

// ---------------------------------------------------------------- lobby

test("a new game starts in the lobby with no players and no board", () => {
  const g = createGame("ABCD");
  assert.equal(g.phase, PHASE.LOBBY);
  assert.equal(g.players.length, 0);
  assert.equal(g.board, null);
  assert.equal(g.code, "ABCD");
});

test("players join with a zero score and are marked connected", () => {
  const g = createGame("ABCD");
  addPlayer(g, { id: "p1", name: "Ann" });
  assert.equal(g.players.length, 1);
  assert.equal(g.players[0].score, 0);
  assert.equal(g.players[0].connected, true);
});

test("rejoining with the same id keeps the existing score instead of resetting it", () => {
  const g = twoPlayerGame();
  adjustScore(g, "p1", 400);

  // Phone browser closed, then reopened with the same stored id.
  setConnectedFalse(g, "p1");
  const res = addPlayer(g, { id: "p1", name: "Ann" });

  assert.equal(res.ok, true);
  assert.equal(g.players.length, 2, "rejoin must not create a duplicate player");
  assert.equal(g.players.find((p) => p.id === "p1").score, 400);
  assert.equal(g.players.find((p) => p.id === "p1").connected, true);
});

function setConnectedFalse(g, id) {
  removePlayer(g, id);
}

test("a disconnected player stays on the scoreboard", () => {
  const g = twoPlayerGame();
  adjustScore(g, "p1", 300);
  removePlayer(g, "p1");
  const p1 = g.players.find((p) => p.id === "p1");
  assert.ok(p1, "player must not be deleted on disconnect");
  assert.equal(p1.connected, false);
  assert.equal(p1.score, 300);
});

test("a player cannot join with a blank name", () => {
  const g = createGame("ABCD");
  assert.equal(addPlayer(g, { id: "p1", name: "   " }).ok, false);
  assert.equal(g.players.length, 0);
});

test("names are unique-ified rather than rejected", () => {
  const g = createGame("ABCD");
  addPlayer(g, { id: "p1", name: "Ann" });
  addPlayer(g, { id: "p2", name: "Ann" });
  assert.notEqual(g.players[0].name, g.players[1].name);
});

test("the game will not start without a board", () => {
  const g = createGame("ABCD");
  addPlayer(g, { id: "p1", name: "Ann" });
  assert.equal(startGame(g).ok, false);
  assert.equal(g.phase, PHASE.LOBBY);
});

test("the game will not start with no players", () => {
  const g = createGame("ABCD");
  setBoard(g, wrapped());
  assert.equal(startGame(g).ok, false);
});

// ---------------------------------------------------------------- opening a clue

test("opening a clue moves to the clue phase with the buzzers live", () => {
  const g = twoPlayerGame();
  assert.equal(g.phase, PHASE.BOARD);

  const res = openClue(g, 0, 2);
  assert.equal(res.ok, true);
  assert.equal(g.phase, PHASE.CLUE);
  assert.deepEqual(g.activeClue, { c: 0, q: 2 });
  assert.equal(g.buzzersArmed, true, "the buzzers open with the clue");
});

test("buzzing once the answer is up is rejected", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  revealAnswer(g);
  const res = buzz(g, "p1", 1000);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not-armed");
  assert.equal(g.buzzedPlayer, null);
});

test("an already-revealed clue cannot be reopened", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  armBuzzers(g);
  buzz(g, "p1", 1000);
  judge(g, true);
  closeClue(g);

  const res = openClue(g, 0, 0);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "already-revealed");
});

test("a clue cannot be opened while another clue is open", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  const res = openClue(g, 1, 1);
  assert.equal(res.ok, false);
  assert.deepEqual(g.activeClue, { c: 0, q: 0 }, "the open clue must not change");
});

test("out-of-range clue coordinates are rejected", () => {
  const g = twoPlayerGame();
  assert.equal(openClue(g, 9, 0).ok, false);
  assert.equal(openClue(g, 0, 9).ok, false);
  assert.equal(openClue(g, -1, 0).ok, false);
});

// ---------------------------------------------------------------- buzzing

test("the first buzz wins and the phase becomes buzzed", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  armBuzzers(g);

  assert.equal(buzz(g, "p2", 1000).ok, true);
  assert.equal(g.buzzedPlayer, "p2");
  assert.equal(g.phase, PHASE.BUZZED);
});

test("a second buzz after the first is rejected and does not steal the buzz", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  armBuzzers(g);

  buzz(g, "p2", 1000);
  const res = buzz(g, "p1", 1001);

  assert.equal(res.ok, false);
  assert.equal(res.reason, "too-late");
  assert.equal(g.buzzedPlayer, "p2", "the first buzzer must keep the buzz");
});

test("arming the buzzers also clears a stale buzz from a previous clue", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  armBuzzers(g);
  buzz(g, "p1", 1000);
  judge(g, true);

  openClue(g, 0, 1);
  assert.equal(g.buzzedPlayer, null, "opening a clue must clear the previous buzzer");
  assert.deepEqual(g.lockedOut, [], "opening a clue must clear previous lockouts");
});

test("an unknown player cannot buzz", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  armBuzzers(g);
  const res = buzz(g, "ghost", 1000);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unknown-player");
});

test("buzzing is rejected on the board phase", () => {
  const g = twoPlayerGame();
  const res = buzz(g, "p1", 1000);
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------- judging

test("a correct answer awards the clue value and shows the answer", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 2); // $300
  armBuzzers(g);
  buzz(g, "p1", 1000);

  const res = judge(g, true);
  assert.equal(res.ok, true);
  assert.equal(g.players.find((p) => p.id === "p1").score, 300);
  assert.equal(g.answerRevealed, true);
  closeClue(g);
  assert.equal(g.phase, PHASE.BOARD);
  assert.equal(g.board.categories[0].clues[2].revealed, true);
});

test("a wrong answer deducts the value, locks that player out, and re-arms for the rest", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 2); // $300
  armBuzzers(g);
  buzz(g, "p1", 1000);

  const res = judge(g, false);
  assert.equal(res.ok, true);
  assert.equal(g.players.find((p) => p.id === "p1").score, -300);
  assert.deepEqual(g.lockedOut, ["p1"]);
  assert.equal(g.phase, PHASE.CLUE, "play continues so others can buzz");
  assert.equal(g.buzzersArmed, true);
  assert.equal(g.buzzedPlayer, null);
  assert.equal(
    g.board.categories[0].clues[2].revealed,
    false,
    "a wrong answer must not reveal the clue",
  );
});

test("a locked-out player cannot buzz again on the same clue", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  armBuzzers(g);
  buzz(g, "p1", 1000);
  judge(g, false);

  const res = buzz(g, "p1", 1002);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "locked-out");
  assert.equal(g.buzzedPlayer, null);
});

test("another player can still buzz after the first gets it wrong", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0); // $100
  armBuzzers(g);
  buzz(g, "p1", 1000);
  judge(g, false);

  assert.equal(buzz(g, "p2", 1002).ok, true);
  judge(g, true);

  assert.equal(g.players.find((p) => p.id === "p1").score, -100);
  assert.equal(g.players.find((p) => p.id === "p2").score, 100);
});

test("when every player is locked out the buzzers are disarmed", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  armBuzzers(g);

  buzz(g, "p1", 1000);
  judge(g, false);
  buzz(g, "p2", 1001);
  judge(g, false);

  assert.equal(g.buzzersArmed, false, "nobody is left who can buzz");
  assert.equal(g.phase, PHASE.CLUE);
});

test("judging with nobody buzzed in is rejected", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  armBuzzers(g);
  const res = judge(g, true);
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------- reveal & close

test("revealing the answer exposes it without changing any score", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  armBuzzers(g);

  revealAnswer(g);
  assert.equal(g.answerRevealed, true);
  assert.equal(g.players.find((p) => p.id === "p1").score, 0);
  assert.equal(g.buzzersArmed, false, "revealing the answer ends the buzzing window");
});

test("closing an unanswered clue marks it revealed and scores nobody", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 3);

  closeClue(g);
  assert.equal(g.phase, PHASE.BOARD);
  assert.equal(g.board.categories[0].clues[3].revealed, true);
  assert.equal(g.players.find((p) => p.id === "p1").score, 0);
  assert.equal(g.activeClue, null);
  assert.equal(g.answerRevealed, false);
});

// ---------------------------------------------------------------- manual scoring

test("the host can adjust a score by any amount, including negative", () => {
  const g = twoPlayerGame();
  adjustScore(g, "p1", 250);
  adjustScore(g, "p1", -100);
  assert.equal(g.players.find((p) => p.id === "p1").score, 150);
});

test("adjusting an unknown player's score fails rather than throwing", () => {
  const g = twoPlayerGame();
  assert.equal(adjustScore(g, "ghost", 100).ok, false);
});

test("the host can rename a player", () => {
  const g = twoPlayerGame();
  assert.equal(renamePlayer(g, "p1", "Annie").ok, true);
  assert.equal(g.players.find((p) => p.id === "p1").name, "Annie");
});

// ---------------------------------------------------------------- completion

test("the board is complete only once every clue is revealed", () => {
  const g = twoPlayerGame();
  assert.equal(isBoardComplete(g), false);

  for (let c = 0; c < 2; c++) {
    for (let q = 0; q < 5; q++) {
      openClue(g, c, q);
      closeClue(g);
    }
  }
  assert.equal(isBoardComplete(g), true);
});

// ---------------------------------------------------------------- what players see

test("the player view never includes clue answers", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  armBuzzers(g);

  const view = publicState(g, { forHost: false });
  const serialized = JSON.stringify(view);
  assert.ok(
    !serialized.includes("Alpha answer for $100"),
    "an answer leaked into the player view",
  );
});

test("the player view includes the open clue text so remote players can read it", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  armBuzzers(g);

  const view = publicState(g, { forHost: false });
  assert.equal(view.activeClue.clue, "Alpha clue for $100");
  assert.equal(view.activeClue.value, 100);
});

test("the player view exposes the answer once the host reveals it", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  revealAnswer(g);

  const view = publicState(g, { forHost: false });
  assert.equal(view.activeClue.answer, "Alpha answer for $100");
});

test("the host view includes answers for unrevealed clues", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);

  const view = publicState(g, { forHost: true });
  assert.equal(view.activeClue.answer, "Alpha answer for $100");
});

// ---------------------------------------------------------------- daily double

function allClues(game) {
  return game.board.categories.flatMap((cat) => cat.clues);
}

test("starting a game puts exactly one daily double on the board", () => {
  const g = twoPlayerGame();
  const marked = allClues(g).filter((c) => c.dailyDouble);
  assert.equal(marked.length, 1);
});

test("the daily double lands on the clue the injected random picks", () => {
  const g = twoPlayerGame(FIRST_CLUE);
  assert.equal(g.board.categories[0].clues[0].dailyDouble, true);

  const other = twoPlayerGame(LAST_CLUE);
  assert.equal(other.board.categories[1].clues[4].dailyDouble, true);
});

test("opening the daily double goes to the wager phase, not the clue phase", () => {
  const g = twoPlayerGame(FIRST_CLUE);
  openClue(g, 0, 0);
  assert.equal(g.phase, PHASE.WAGER);
  assert.equal(g.buzzersArmed, false);
});

test("opening an ordinary clue still goes straight to the clue phase", () => {
  const g = twoPlayerGame(FIRST_CLUE);
  openClue(g, 0, 1);
  assert.equal(g.phase, PHASE.CLUE);
});

test("the board sent to players never reveals where the daily double is", () => {
  const g = twoPlayerGame(FIRST_CLUE);
  const view = publicState(g, { forHost: false });
  assert.ok(
    !JSON.stringify(view.board).includes("dailyDouble"),
    "the daily double location leaked into the player board",
  );
});

test("the clue text is withheld from players while the wager is open", () => {
  const g = dailyDoubleGame();

  const view = publicState(g, { forHost: false });
  assert.equal(view.activeClue.dailyDouble, true);
  assert.equal(
    view.activeClue.clue,
    null,
    "players could bet with the clue in front of them",
  );
});

test("the host can read the daily double clue while the wager is open", () => {
  const g = dailyDoubleGame();
  const view = publicState(g, { forHost: true });
  assert.equal(view.activeClue.clue, "Alpha clue for $100");
});

test("nobody can buzz while a wager is being set", () => {
  const g = dailyDoubleGame();
  const res = buzz(g, "p2");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "wrong-phase");
});

test("arming the buzzers during a wager is refused", () => {
  const g = dailyDoubleGame();
  assert.equal(armBuzzers(g).ok, false);
});

test("the host cannot hand the daily double to someone who is not playing", () => {
  const g = twoPlayerGame(FIRST_CLUE);
  openClue(g, 0, 0);
  const res = assignDailyDouble(g, "nobody");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unknown-player");
});

test("a wager from anyone but the assigned player is refused", () => {
  const g = dailyDoubleGame();
  const res = setWager(g, "p2", 300);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not-your-wager");
});

test("a wager before the host has assigned the clue is refused", () => {
  const g = twoPlayerGame(FIRST_CLUE);
  openClue(g, 0, 0);
  const res = setWager(g, "p1", 300);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no-wager-player");
});

test("a wager that is not a multiple of 100 is refused", () => {
  const g = dailyDoubleGame();
  const res = setWager(g, "p1", 46);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad-increment");
});

test("a wager of zero or less is refused", () => {
  const g = dailyDoubleGame();
  assert.equal(setWager(g, "p1", 0).reason, "out-of-range");
  assert.equal(setWager(g, "p1", -200).reason, "out-of-range");
});

test("a wager above the player's ceiling is refused", () => {
  const g = dailyDoubleGame();
  const res = setWager(g, "p1", 600);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "out-of-range");
});

test("a broke player can still bet up to the biggest value on the board", () => {
  const g = dailyDoubleGame();
  adjustScore(g, "p1", -5000);
  assert.equal(maxWager(g, "p1"), 500);
  assert.equal(setWager(g, "p1", 500).ok, true);
});

test("a player ahead of the board bets up to their own score", () => {
  const g = dailyDoubleGame();
  adjustScore(g, "p1", 1800);
  assert.equal(maxWager(g, "p1"), 1800);
  assert.equal(setWager(g, "p1", 1800).ok, true);
});

test("locking the wager hands the clue to that player with no buzzing", () => {
  const g = dailyDoubleGame();
  const res = setWager(g, "p1", 300);

  assert.equal(res.ok, true);
  assert.equal(g.phase, PHASE.BUZZED);
  assert.equal(g.buzzedPlayer, "p1");
  assert.equal(g.buzzersArmed, false);
});

test("players can read the clue once the wager is locked in", () => {
  const g = dailyDoubleGame();
  setWager(g, "p1", 300);

  const view = publicState(g, { forHost: false });
  assert.equal(view.activeClue.clue, "Alpha clue for $100");
  assert.equal(view.activeClue.value, 300, "the wager replaces the clue value");
});

test("a correct daily double pays the wager, not the clue value", () => {
  const g = dailyDoubleGame();
  setWager(g, "p1", 300);
  judge(g, true);

  assert.equal(g.players.find((p) => p.id === "p1").score, 300);
  closeClue(g);
  assert.equal(g.phase, PHASE.BOARD);
});

test("a wrong daily double deducts the wager and gives nobody else a shot", () => {
  const g = dailyDoubleGame();
  setWager(g, "p1", 300);
  judge(g, false);

  assert.equal(g.players.find((p) => p.id === "p1").score, -300);
  assert.equal(g.buzzersArmed, false, "it must not reopen to the room");
  assert.equal(g.answerRevealed, true);
  closeClue(g);
  assert.equal(g.phase, PHASE.BOARD);
  assert.equal(g.activeClue, null);
  assert.equal(g.board.categories[0].clues[0].revealed, true);
});

test("closing a daily double clears the wagering player", () => {
  const g = dailyDoubleGame();
  setWager(g, "p1", 300);
  judge(g, true);
  closeClue(g);
  assert.equal(g.wagerPlayer, null);
});

// ---------------------------------------------------------------- rounds

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

// ------------------------------------------------- answers always get shown

test("opening a clue opens the buzzers straight away", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  assert.equal(g.phase, PHASE.CLUE);
  assert.equal(g.buzzersArmed, true, "players should not wait on a second press");
  assert.equal(buzz(g, "p1").ok, true);
});

test("a correct answer shows the answer and leaves the clue up", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  buzz(g, "p1");
  judge(g, true);

  assert.equal(g.players.find((p) => p.id === "p1").score, 100);
  assert.equal(g.answerRevealed, true, "the room should see what it was");
  assert.equal(g.phase, PHASE.CLUE, "the host closes it, not the verdict");
  assert.equal(g.buzzersArmed, false);
  assert.equal(publicState(g, { forHost: false }).activeClue.answer, "Alpha answer for $100");
});

test("the host closing the clue is what returns to the board", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  buzz(g, "p1");
  judge(g, true);
  closeClue(g);
  assert.equal(g.phase, PHASE.BOARD);
  assert.equal(g.board.categories[0].clues[0].revealed, true);
});

test("a wrong answer still re-opens the buzzers for everyone else", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  buzz(g, "p1");
  judge(g, false);

  assert.equal(g.buzzersArmed, true);
  assert.equal(g.answerRevealed, false, "it is still live, so no answer yet");
  assert.equal(buzz(g, "p2").ok, true);
});

test("once everyone has missed it the answer appears by itself", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
  buzz(g, "p1");
  judge(g, false);
  buzz(g, "p2");
  judge(g, false);

  assert.equal(g.answerRevealed, true, "nobody is left, so stop sitting in silence");
  assert.equal(g.buzzersArmed, false);
  assert.equal(g.phase, PHASE.CLUE);
  assert.equal(publicState(g, { forHost: false }).activeClue.answer, "Alpha answer for $100");
});

test("a daily double shows its answer too, either way", () => {
  const right = dailyDoubleGame();
  setWager(right, "p1", 300);
  judge(right, true);
  assert.equal(right.answerRevealed, true);
  assert.equal(right.phase, PHASE.CLUE);

  const wrong = dailyDoubleGame();
  setWager(wrong, "p1", 300);
  judge(wrong, false);
  assert.equal(wrong.answerRevealed, true);
  assert.equal(wrong.phase, PHASE.CLUE, "nobody else can buzz, but the room still sees it");
});

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
  const bo = view.final.revealed.find((r) => r.playerId === "p2");
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

test("someone who left before the final does not hold the round up forever", () => {
  // They keep their score on the scoreboard, as they always have, but the
  // room cannot sit waiting for a bet from a phone that has gone home.
  const g = atFinal();
  setConnectedFalse(g, "p2");
  startFinal(g);

  assert.equal(g.finalRound.wagers["p2"], 0, "a departed player is entered at $0");
  setFinalWager(g, "p1", 300);
  assert.equal(allFinalWagersIn(g), true, "the round must not block on someone who left");
  assert.equal(revealFinalClue(g, 1_000_000).ok, true);
});

test("someone who left and comes back during the betting can still bet", () => {
  const g = atFinal();
  setConnectedFalse(g, "p2");
  startFinal(g);
  addPlayer(g, { id: "p2", name: "Bo" }); // their phone reconnects

  assert.equal(setFinalWager(g, "p2", 400).ok, true);
  assert.equal(g.finalRound.wagers["p2"], 400);
});

test("final jeopardy cannot take a player below nothing even after a score correction", () => {
  const g = atFinal();
  startFinal(g);
  setFinalWager(g, "p1", 1000); // Ann stakes her whole $1000.
  setFinalWager(g, "p2", 0);
  revealFinalClue(g, 1_000_000);
  closeFinalAnswers(g);

  // The host corrects an earlier mis-ruling after the bet was locked in.
  adjustScore(g, "p1", -500);
  judgeFinal(g, true); // Bo, $0
  judgeFinal(g, false); // Ann, wrong, staked 1000 but only holds 500

  assert.ok(
    g.players.find((p) => p.id === "p1").score >= 0,
    "the last bet of the night must never leave anyone in the red",
  );
});

test("a player id that collides with Object's own keys is handled as data", () => {
  // Player ids arrive from the client, so one can be "toString" or
  // "constructor". A plain {} would report those as already present and the
  // round would advance without their bet.
  const g = createGame("ABCD");
  addPlayer(g, { id: "toString", name: "Ann" });
  addPlayer(g, { id: "constructor", name: "Bo" });
  setBoard(g, finalBoard());
  startGame(g, { random: LAST_CLUE });
  adjustScore(g, "toString", 500);
  adjustScore(g, "constructor", 500);
  playWholeBoard(g);
  startFinal(g);

  assert.equal(allFinalWagersIn(g), false, "nobody has bet yet");
  setFinalWager(g, "toString", 100);
  assert.equal(allFinalWagersIn(g), false, "one of the two has bet");
  setFinalWager(g, "constructor", 200);
  assert.equal(allFinalWagersIn(g), true);

  revealFinalClue(g, 1_000_000);
  submitFinalAnswer(g, "toString", "mine", 1_000_100);
  const view = publicState(g, { forHost: false, playerId: "toString" });
  assert.equal(view.final.myWager, 100);
  assert.equal(view.final.myAnswer, "mine");
});

test("nothing of another player's leaks into any final phase payload", () => {
  // A sweep across every phase of the round.
  //
  // Bets are checked structurally rather than by string match: every bet is a
  // round hundred, so it collides with scores and board values, which are
  // public. What must never appear is the raw wagers/answers maps or another
  // player's entry in `revealed`. Text secrets are distinctive, so those are
  // matched directly.
  const g = atFinal();
  startFinal(g);

  const forAnn = () => publicState(g, { forHost: false, playerId: "p1" }).final;
  const noMaps = (f, when) => {
    assert.equal(f.wagers, undefined, `the wagers map was serialized ${when}`);
    assert.equal(f.answers, undefined, `the answers map was serialized ${when}`);
    assert.equal(f.current, null, `the face-up card reached a phone ${when}`);
  };

  setFinalWager(g, "p2", 400);
  let f = forAnn();
  noMaps(f, "during betting");
  assert.equal(f.myWager, null, "Ann has not bet yet");
  assert.equal(f.clue, null, "the clue leaked during betting");

  setFinalWager(g, "p1", 300);
  revealFinalClue(g, 1_000_000);
  submitFinalAnswer(g, "p2", "Bo's secret", 1_000_100);
  f = forAnn();
  noMaps(f, "while answering");
  assert.equal(f.myWager, 300, "Ann should see her own bet");
  assert.ok(!JSON.stringify(f).includes("Bo's secret"), "an answer leaked while answering");
  assert.equal(f.answer, null, "the authored answer reached a phone");

  closeFinalAnswers(g);
  f = forAnn();
  noMaps(f, "before the reveal");
  assert.equal(f.revealed.length, 0, "someone was revealed before being turned over");
  assert.ok(!JSON.stringify(f).includes("Bo's secret"), "an answer leaked before the reveal");
  assert.equal(f.answer, null, "the authored answer reached a phone");
});
