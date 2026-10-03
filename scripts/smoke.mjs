/**
 * End-to-end smoke test. Run the server first, then: npm run smoke
 *
 * Creates fresh rooms over HTTP and drives them over WebSockets exactly as the
 * browser does. The unit tests in test/ cover the rules in isolation; this
 * covers the parts only a running server can show - socket wiring, what each
 * role is actually sent, and simultaneous buzzes resolving to one winner.
 *
 * Override the port with PORT=xxxx npm run smoke.
 */
import WebSocket from "ws";

const PORT = Number(process.env.PORT) || 3000;
const BASE = "http://localhost:" + PORT;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
function check(label, condition, detail) {
  if (condition) console.log("  PASS  " + label);
  else {
    console.log("  FAIL  " + label + (detail ? "  -> " + detail : ""));
    failures.push(label);
  }
}

function client(onReady) {
  return new Promise((resolve) => {
    const ws = new WebSocket("ws://localhost:" + PORT + "/ws");
    const api = {
      ws,
      state: null,
      rejected: [],
      wagerRejected: [],
      toasts: [],
      fatal: null,
    };
    ws.on("open", () => ws.send(JSON.stringify(onReady())));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "hello-ok") {
        api.hello = m;
        resolve(api);
      }
      if (m.type === "state") api.state = m.state;
      if (m.type === "buzz-rejected") api.rejected.push(m.reason);
      if (m.type === "wager-rejected") api.wagerRejected.push(m.reason);
      if (m.type === "toast") api.toasts.push(m.message);
      if (m.type === "fatal") api.fatal = m.message;
    });
    api.send = (msg) => ws.send(JSON.stringify(msg));
  });
}

function makeBoard() {
  const cat = (title) => ({
    title,
    clues: [100, 200, 300, 400, 500].map((value) => ({
      value,
      clue: title + " clue worth " + value,
      answer: title + " answer " + value,
      revealed: false,
      wager: null,
      dailyDouble: false,
    })),
  });
  return { categories: [cat("Alpha"), cat("Beta")] };
}

// ---------------------------------------------------------------- setup

/** Creating a room, carrying HOST_PASSWORD when the server wants one. */
async function newRoom() {
  const res = await fetch(BASE + "/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      process.env.HOST_PASSWORD ? { password: process.env.HOST_PASSWORD } : {},
    ),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      "could not create a room (" + res.status + "): " + (body.error ?? "") +
        " - if the server runs with HOST_PASSWORD set, run the smoke test with the same value.",
    );
  }
  return res.json();
}

const room = await newRoom();
console.log("\nRoom " + room.code + "\n");

const host = await client(() => ({
  type: "hello",
  role: "host",
  code: room.code,
  hostToken: room.hostToken,
}));

const ann = await client(() => ({
  type: "hello",
  role: "player",
  code: room.code,
  playerId: "e2e-ann",
  name: "Ann",
}));
const bo = await client(() => ({
  type: "hello",
  role: "player",
  code: room.code,
  playerId: "e2e-bo",
  name: "Bo",
}));
await wait(150);

console.log("Host password");
{
  const health = await (await fetch(BASE + "/api/health")).json();
  const required = Boolean(health.hostPasswordRequired);
  console.log("  (HOST_PASSWORD is " + (required ? "set" : "not set") + " on this server)");

  if (required) {
    const bad = await fetch(BASE + "/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "definitely-wrong" }),
    });
    check("a wrong host password is refused", bad.status === 403, String(bad.status));

    const none = await fetch(BASE + "/api/rooms", { method: "POST" });
    check("no password at all is refused", none.status === 403, String(none.status));
  } else {
    const open = await fetch(BASE + "/api/rooms", { method: "POST" });
    check("without a password set, anyone may host", open.status === 200, String(open.status));
  }
}

console.log("Access control");
// A rejected host never gets hello-ok, so watch for the fatal directly.
const sneak = new WebSocket("ws://localhost:" + PORT + "/ws");
let sneakFatal = null;
sneak.on("open", () =>
  sneak.send(
    JSON.stringify({ type: "hello", role: "host", code: room.code, hostToken: "nope" }),
  ),
);
sneak.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "fatal") sneakFatal = m.message;
});
await wait(250);
check("a wrong host token is rejected", sneakFatal !== null, String(sneakFatal));
sneak.close();

console.log("\nStarting the game");
host.send({ type: "saveDraft", draft: makeBoard() });
await wait(150);
host.send({ type: "startGame" });
await wait(200);
check("game started", host.state.phase === "board", host.state.phase);
check("board has 2 categories", host.state.board?.categories.length === 2);

/**
 * The Daily Double is hidden at random, so no square is guaranteed ordinary.
 * Opens cells until one is a normal clue, playing out any Daily Double it
 * uncovers on the way, and reports which cell it settled on.
 */
async function openOrdinaryClue(cells) {
  for (const [c, q] of cells) {
    host.send({ type: "openClue", c, q });
    await wait(120);
    if (host.state.phase !== "wager") return { c, q };

    // Found the Daily Double early — play it through so the board moves on.
    host.send({ type: "assignDailyDouble", playerId: "e2e-ann" });
    await wait(80);
    ann.send({ type: "setWager", amount: 100 });
    await wait(100);
    host.send({ type: "judge", correct: false });
    await wait(100);
  }
  return null;
}

console.log("\nAnswers are not sent to phones");
const ordinary = await openOrdinaryClue([
  [0, 0],
  [0, 1],
]);
check("found an ordinary clue to inspect", ordinary !== null);
const expectedClue = "Alpha clue worth " + (ordinary.q + 1) * 100;
const expectedAnswer = "Alpha answer " + (ordinary.q + 1) * 100;
check(
  "player payload omits the answer while unrevealed",
  ann.state.activeClue?.answer === null,
  JSON.stringify(ann.state.activeClue?.answer),
);
check("player payload includes the clue text", ann.state.activeClue?.clue === expectedClue);
check("host payload includes the answer", host.state.activeClue?.answer === expectedAnswer);

console.log("\nBuzzers are disarmed until the host opens them");
ann.send({ type: "buzz" });
await wait(120);
check("an early buzz is refused", ann.rejected.at(-1) === "not-armed", ann.rejected.at(-1));
check("nobody is buzzed in", host.state.buzzedPlayer === null);

console.log("\nSimultaneous buzz across the rest of the board");

function nextUnrevealed(board) {
  for (let c = 0; c < board.categories.length; c++) {
    const clues = board.categories[c].clues;
    for (let q = 0; q < clues.length; q++) if (!clues[q].revealed) return { c, q };
  }
  return null;
}

let races = 0,
  firstSenderWon = 0,
  noWinner = 0,
  badNotify = 0,
  dailyDoubles = 0;

// The clue opened for the payload checks above is still sitting open.
let cell = { c: ordinary.c, q: ordinary.q };

while (cell) {
  // A Daily Double is nobody's to race for — play it out and move on.
  if (host.state.phase === "wager") {
    dailyDoubles++;
    bo.send({ type: "setWager", amount: 200 });
    await wait(100);
    check(
      "a bet before the host assigns it is refused",
      bo.wagerRejected.at(-1) === "no-wager-player",
      String(bo.wagerRejected.at(-1)),
    );

    host.send({ type: "assignDailyDouble", playerId: "e2e-bo" });
    await wait(80);
    check(
      "the clue is withheld from phones while the bet is open",
      ann.state.activeClue?.clue === null,
      JSON.stringify(ann.state.activeClue?.clue),
    );

    ann.send({ type: "setWager", amount: 200 });
    await wait(100);
    check(
      "only the assigned player may bet",
      ann.wagerRejected.at(-1) === "not-your-wager",
      String(ann.wagerRejected.at(-1)),
    );

    bo.send({ type: "setWager", amount: 250 });
    await wait(100);
    check(
      "a bet that is not a whole hundred is refused",
      bo.wagerRejected.at(-1) === "bad-increment",
      String(bo.wagerRejected.at(-1)),
    );

    const before = host.state.players.find((p) => p.id === "e2e-bo").score;
    bo.send({ type: "setWager", amount: 200 });
    await wait(120);
    check(
      "a locked bet hands the clue to that player with no buzzing",
      host.state.buzzedPlayer === "e2e-bo" && host.state.buzzersArmed === false,
      String(host.state.buzzedPlayer),
    );
    check(
      "phones can read the clue once the bet is locked",
      typeof ann.state.activeClue?.clue === "string",
    );

    host.send({ type: "judge", correct: true });
    await wait(100);
    check(
      "the bet is paid, not the clue value",
      host.state.players.find((p) => p.id === "e2e-bo").score === before + 200,
    );
  } else {
    const beforeA = ann.rejected.length,
      beforeB = bo.rejected.length;

    host.send({ type: "armBuzzers" });
    await wait(60);

    // Same event-loop turn. Alternate the order so a fixed winner would show up.
    const annFirst = races % 2 === 0;
    if (annFirst) {
      ann.send({ type: "buzz" });
      bo.send({ type: "buzz" });
    } else {
      bo.send({ type: "buzz" });
      ann.send({ type: "buzz" });
    }
    await wait(130);

    const who = host.state.buzzedPlayer;
    races++;
    if (!who) noWinner++;
    else if (who === (annFirst ? "e2e-ann" : "e2e-bo")) firstSenderWon++;

    const newRejects =
      ann.rejected.length - beforeA + (bo.rejected.length - beforeB);
    if (newRejects !== 1) badNotify++;

    host.send({ type: "closeClue" });
    await wait(60);
  }

  cell = nextUnrevealed(host.state.board);
  if (cell) {
    host.send({ type: "openClue", c: cell.c, q: cell.q });
    await wait(60);
  }
}

check("exactly one daily double turned up", dailyDoubles === 1, String(dailyDoubles));
check("every other clue was raced for", races === 9, String(races));
check("every race produced exactly one winner", noWinner === 0, noWinner + " had none");
check(
  "the loser was told exactly once each time",
  badNotify === 0,
  badNotify + " rounds were wrong",
);
check(
  "send order decides the winner, not the player",
  firstSenderWon === races,
  firstSenderWon + " of " + races,
);
check("the board is complete", host.state.complete === true);
check("phase is done", host.state.phase === "done", host.state.phase);

// ---------------------------------------------------------------- scoring

console.log("\nScoring, on a second room");
const room2 = await newRoom();
const h2 = await client(() => ({
  type: "hello",
  role: "host",
  code: room2.code,
  hostToken: room2.hostToken,
}));
const p1 = await client(() => ({
  type: "hello",
  role: "player",
  code: room2.code,
  playerId: "s-1",
  name: "Cal",
}));
const p2 = await client(() => ({
  type: "hello",
  role: "player",
  code: room2.code,
  playerId: "s-2",
  name: "Dee",
}));
await wait(150);
h2.send({ type: "saveDraft", draft: makeBoard() });
await wait(120);
h2.send({ type: "startGame" });
await wait(150);

// $300 clue, Cal buzzes and gets it wrong, Dee buzzes and gets it right.
h2.send({ type: "openClue", c: 0, q: 2 });
await wait(80);

// The Daily Double may have landed on that square. Play it out of the way and
// use the other category's $300 instead — same value, so the sums below hold.
if (h2.state.phase === "wager") {
  h2.send({ type: "assignDailyDouble", playerId: "s-1" });
  await wait(80);
  p1.send({ type: "setWager", amount: 100 });
  await wait(100);
  h2.send({ type: "judge", correct: true });
  await wait(100);
  h2.send({ type: "adjustScore", playerId: "s-1", delta: -100 });
  await wait(80);
  h2.send({ type: "openClue", c: 1, q: 2 });
  await wait(80);
}

h2.send({ type: "armBuzzers" });
await wait(80);
p1.send({ type: "buzz" });
await wait(100);
h2.send({ type: "judge", correct: false });
await wait(100);

const cal = () => h2.state.players.find((p) => p.id === "s-1");
const dee = () => h2.state.players.find((p) => p.id === "s-2");

check("a wrong answer deducts the clue value", cal().score === -300, String(cal().score));
check("the wrong answerer is locked out", h2.state.lockedOut.includes("s-1"));
check("the clue stays in play", h2.state.phase === "clue", h2.state.phase);
check("buzzers re-open for the others", h2.state.buzzersArmed === true);

p1.send({ type: "buzz" });
await wait(100);
check(
  "the locked-out player cannot buzz again",
  p1.rejected.at(-1) === "locked-out",
  p1.rejected.at(-1),
);

p2.send({ type: "buzz" });
await wait(100);
check("another player can still buzz", h2.state.buzzedPlayer === "s-2");
h2.send({ type: "judge", correct: true });
await wait(100);
check("a correct answer awards the value", dee().score === 300, String(dee().score));
check("the clue closes", h2.state.phase === "board", h2.state.phase);
check(
  "the clue is marked played",
  h2.state.board.categories[0].clues[2].revealed === true,
);

console.log("\nReconnecting keeps the score");
p2.ws.close();
await wait(200);
check("a disconnected player stays on the board", h2.state.players.length === 2);
check("they are shown as offline", dee().connected === false);

const p2again = await client(() => ({
  type: "hello",
  role: "player",
  code: room2.code,
  playerId: "s-2",
  name: "Dee",
}));
await wait(200);
check("rejoining does not duplicate the player", h2.state.players.length === 2);
check("the score survived the reconnect", dee().score === 300, String(dee().score));
check("they are back online", dee().connected === true);

console.log("");
console.log("Saved boards require an account");
{
  const health = await (await fetch(BASE + "/api/health")).json();
  console.log("  (accounts are " + (health.accounts ? "on" : "off") + " on this server)");

  const list = await fetch(BASE + "/api/boards");
  const save = await fetch(BASE + "/api/boards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Nope", board: { categories: [] } }),
  });
  const read = await fetch(BASE + "/api/boards/Anything");
  const del = await fetch(BASE + "/api/boards/Anything", { method: "DELETE" });

  // 401 when accounts are available but nobody is signed in; 503 when the
  // server has no database at all. Either way a stranger gets nothing.
  const refused = (r) => r.status === 401 || r.status === 503;
  check("a signed-out visitor cannot list boards", refused(list), String(list.status));
  check("a signed-out visitor cannot save a board", refused(save), String(save.status));
  check("a signed-out visitor cannot read a board", refused(read), String(read.status));
  check("a signed-out visitor cannot delete a board", refused(del), String(del.status));

  const body = await read.text();
  check("no board content leaks in the refusal", !body.includes("categories"), body.slice(0, 80));

  const me = await (await fetch(BASE + "/api/me")).json();
  check("the signed-out identity is reported honestly", me.signedIn === false);

  const account = await fetch(BASE + "/api/account", { method: "DELETE" });
  check("a signed-out visitor cannot delete an account", account.status === 401, String(account.status));
}


console.log("");
console.log("WebSocket origin");
{
  const hijack = await new Promise((resolve) => {
    const ws = new WebSocket("ws://localhost:" + PORT + "/ws", {
      headers: { Origin: "http://evil.example" },
    });
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "fatal") resolve("refused");
    });
    ws.on("close", () => resolve("refused"));
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role: "player", code: room.code, name: "Evil" })));
    setTimeout(() => resolve("allowed"), 1500);
  });
  check("a socket from another site is refused", hijack === "refused", hijack);
}

console.log("\nManual score correction");
h2.send({ type: "adjustScore", playerId: "s-1", delta: 100 });
await wait(100);
check("the host can nudge a score", cal().score === -200, String(cal().score));

console.log(
  "\n" +
    (failures.length === 0
      ? "ALL CHECKS PASSED"
      : failures.length + " CHECK(S) FAILED: " + failures.join("; ")) +
    "\n",
);
process.exit(failures.length === 0 ? 0 : 1);
