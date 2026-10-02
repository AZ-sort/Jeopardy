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
    })),
  });
  return { categories: [cat("Alpha"), cat("Beta")] };
}

function twoPlayerGame() {
  const g = createGame("ABCD");
  addPlayer(g, { id: "p1", name: "Ann" });
  addPlayer(g, { id: "p2", name: "Bo" });
  setBoard(g, testBoard());
  startGame(g);
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
  setBoard(g, testBoard());
  assert.equal(startGame(g).ok, false);
});

// ---------------------------------------------------------------- opening a clue

test("opening a clue moves to the clue phase with buzzers disarmed", () => {
  const g = twoPlayerGame();
  assert.equal(g.phase, PHASE.BOARD);

  const res = openClue(g, 0, 2);
  assert.equal(res.ok, true);
  assert.equal(g.phase, PHASE.CLUE);
  assert.deepEqual(g.activeClue, { c: 0, q: 2 });
  assert.equal(
    g.buzzersArmed,
    false,
    "buzzers must stay disarmed until the host finishes reading the clue",
  );
});

test("buzzing before the host arms the buzzers is rejected", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 0);
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

test("a correct answer awards the clue value and closes the clue", () => {
  const g = twoPlayerGame();
  openClue(g, 0, 2); // $300
  armBuzzers(g);
  buzz(g, "p1", 1000);

  const res = judge(g, true);
  assert.equal(res.ok, true);
  assert.equal(g.players.find((p) => p.id === "p1").score, 300);
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
