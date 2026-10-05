/**
 * The game server.
 *
 * Deliberately a single always-on Node process rather than serverless functions:
 * a room is shared mutable state with one correct buzz order, and one process is
 * its own authority. Because Node runs our handlers on one thread, "first buzz
 * message off the socket wins" needs no locking.
 *
 * Rooms live in memory only - a restart ends any game in progress. Saved boards
 * are the one thing that persists, as JSON under boards/.
 */

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import cookieParser from "cookie-parser";

import * as db from "./lib/db.js";
import * as auth from "./lib/auth.js";

import * as G from "./lib/game.js";
import {
  blankBoard,
  validateBoard,
  compactBoard,
  collectAnswers,
  MAX_CATEGORIES,
  NUM_ROUNDS,
  ROUND_VALUES,
} from "./lib/board.js";
import {
  generateCategory,
  GenerationError,
  hasCredentials,
  providerLabel,
} from "./lib/generate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

/** Unambiguous on a phone keypad: no O/0, I/1, S/5, B/8. */
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY";
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Optional. When set, creating a game needs this password - without it anyone
 * who finds a public URL could open rooms and spend the AI credit. Players
 * never need it; they only ever type a room code.
 */
const HOST_PASSWORD = process.env.HOST_PASSWORD?.trim() || null;

/** Stops a public URL being turned into unbounded memory growth. */
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;

/**
 * Generation limits.
 *
 * Hosting is open to anyone, so the API credit is the one thing that needs a
 * ceiling. A real board is six categories, so the hourly allowance is three
 * boards an hour - far past normal use, well short of a bill.
 */
const GEN_PER_IP_PER_HOUR = Number(process.env.GEN_PER_IP_PER_HOUR) || 20;
const GEN_PER_DAY = Number(process.env.GEN_PER_DAY) || 500;

/** ip -> timestamps of recent generations. */
const genByIp = new Map();
let genToday = { day: new Date().toDateString(), count: 0 };

/** @returns {null} when allowed, or a message explaining the refusal. */
function generationBlocked(ip) {
  const now = Date.now();

  const today = new Date().toDateString();
  if (genToday.day !== today) genToday = { day: today, count: 0 };
  if (genToday.count >= GEN_PER_DAY) {
    return "This game has used up today's AI budget. Write this category yourself, or try again tomorrow.";
  }

  const hourAgo = now - 60 * 60 * 1000;
  const recent = (genByIp.get(ip) ?? []).filter((t) => t > hourAgo);
  if (recent.length >= GEN_PER_IP_PER_HOUR) {
    return `That is ${GEN_PER_IP_PER_HOUR} categories in an hour, which is as many as this allows. Write this one yourself, or come back later.`;
  }

  recent.push(now);
  genByIp.set(ip, recent);
  genToday.count += 1;
  return null;
}

/**
 * Constant-time compare, so a secret cannot be recovered a character at a time.
 * Length still leaks, which is acceptable for these values.
 */
function secretsMatch(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * A WebSocket is not covered by CORS, so without this any page on the internet
 * could open a socket to this server. A missing Origin means a non-browser
 * client, which is not a cross-site risk, so it is allowed.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  const allowed = process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
  if (allowed?.length) return allowed.includes(origin);

  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const app = express();
// Railway terminates TLS in front of us, so the client IP is in
// X-Forwarded-For. Without this every visitor shares one rate-limit bucket.
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const server = createServer(app);
// The same 1mb ceiling the HTTP side uses. Without it `ws` allows 100MB a
// frame and `JSON.parse` runs on all of it before any handler can object — a
// draft is the only large message here and a full two-round board is ~40KB.
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1024 * 1024 });

/** code -> Room */
const rooms = new Map();

function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("could not allocate a room code");
}

function createRoom() {
  const code = makeCode();
  const room = {
    code,
    hostToken: randomBytes(16).toString("hex"),
    game: G.createGame(code),
    /** The board being authored, before the game starts. */
    draft: blankBoard(),
    /** Handle for Final Jeopardy's answer clock; see armFinalTimer. */
    finalTimer: null,
    hosts: new Set(),
    /** playerId -> ws */
    players: new Map(),
    /**
     * playerId -> secret, minted the first time an id joins this room.
     *
     * Player ids are broadcast to everyone, so without this anyone in the room
     * could reconnect as a rival and inherit their score, their secret Final
     * Jeopardy bet, and the ability to stake it.
     */
    playerTokens: new Map(),
    lastSeen: Date.now(),
    generating: new Set(),
  };
  rooms.set(code, room);
  return room;
}

/** Non-internal IPv4 addresses, so the host screen can show a reachable URL. */
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

function joinUrlsFor(code) {
  return lanAddresses().map((ip) => "http://" + ip + ":" + PORT + "/play?code=" + code);
}

// ------------------------------------------------------------------ broadcast

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room) {
  // The server's clock travels with the state so a phone can measure its own
  // offset once and count a Final Jeopardy deadline down correctly even if
  // its own clock is wrong.
  const now = Date.now();
  const hostState = G.publicState(room.game, { forHost: true });
  for (const ws of room.hosts) {
    send(ws, { type: "state", state: hostState, draft: room.draft, now });
  }
  // One payload per player, not one shared payload: in Final Jeopardy each
  // phone must see its own bet and answer and nobody else's, so the states
  // genuinely differ. Capped at MAX_PLAYERS (12), so this stays cheap.
  for (const [playerId, ws] of room.players) {
    send(ws, {
      type: "state",
      state: G.publicState(room.game, { forHost: false, playerId }),
      you: playerId,
      now,
    });
  }
}

function toast(ws, message, kind = "error") {
  send(ws, { type: "toast", message, kind });
}

// ------------------------------------------------------------------ HTTP

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    ai: hasCredentials(),
    aiProvider: providerLabel(),
    hostPasswordRequired: Boolean(HOST_PASSWORD),
    accounts: auth.isConfigured() && db.isReady(),
    rooms: rooms.size,
  });
});

app.post("/api/rooms", (req, res) => {
  if (HOST_PASSWORD && !secretsMatch(req.body?.password, HOST_PASSWORD)) {
    return res.status(403).json({ error: "Wrong host password." });
  }
  if (rooms.size >= MAX_ROOMS) {
    return res.status(503).json({ error: "Too many games running. Try again later." });
  }
  const room = createRoom();
  res.json({
    code: room.code,
    hostToken: room.hostToken,
    joinUrls: joinUrlsFor(room.code),
  });
});

app.get("/api/rooms/:code", (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ error: "No game with that code." });
  res.json({ code: room.code, phase: room.game.phase, players: room.game.players.length });
});

/** Generates one category. Host-only, and one at a time per slot. */
app.post("/api/rooms/:code/generate", async (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ error: "No game with that code." });
  if (!secretsMatch(req.body?.hostToken, room.hostToken)) {
    return res.status(403).json({ error: "Not the host of this game." });
  }

  // Defaults to round 1 for a client that does not send one, but only a real
  // number counts: `Number(true)` is 1, which would write into round 2.
  const sent = req.body?.roundIndex;
  const round = sent === undefined || sent === null ? 0 : typeof sent === "number" ? sent : NaN;
  const index = Number(req.body?.categoryIndex);
  if (!Number.isInteger(round) || round < 0 || round >= NUM_ROUNDS) {
    return res.status(400).json({ error: "Bad round." });
  }
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CATEGORIES) {
    return res.status(400).json({ error: "Bad category slot." });
  }
  // A column can be removed between the click and this request arriving.
  if (!room.draft.rounds[round]?.categories[index]) {
    return res.status(400).json({ error: "That category is no longer on the board." });
  }

  // One in-flight generation per square, not per category index, or the two
  // rounds would block each other's slot 3.
  const slot = `${round}:${index}`;
  if (room.generating.has(slot)) {
    return res.status(409).json({ error: "That category is already generating." });
  }

  const blocked = generationBlocked(req.ip);
  if (blocked) return res.status(429).json({ error: blocked });

  room.generating.add(slot);
  try {
    const avoid = collectAnswers(room.draft);
    const category = await generateCategory(req.body?.theme, avoid);
    // Generation always returns round 1's values; round 2 runs double.
    category.clues.forEach((clue, i) => {
      clue.value = ROUND_VALUES[round][i];
    });
    room.draft.rounds[round].categories[index] = category;
    broadcast(room);
    res.json({ category });
  } catch (err) {
    if (err instanceof GenerationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("generate failed:", err);
    res.status(500).json({ error: "Category generation failed unexpectedly." });
  } finally {
    room.generating.delete(slot);
  }
});

// ---- sign in

app.get("/auth/google", (req, res) => {
  if (!auth.isConfigured()) {
    return res.status(503).send("Sign-in is not set up on this server.");
  }
  auth.beginLogin(req, res);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const profile = await auth.completeLogin(req, res);
    const user = await db.upsertUser(profile);
    auth.setSession(req, res, user.id);
    res.redirect("/");
  } catch (err) {
    console.error("sign-in failed:", err.message);
    res.redirect("/?signin=failed");
  }
});

app.post("/auth/logout", (req, res) => {
  auth.clearSession(req, res);
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  const available = auth.isConfigured() && db.isReady();
  const id = auth.currentUserId(req);
  if (!available || !id) return res.json({ available, signedIn: false });

  try {
    const user = await db.getUser(id);
    if (!user) {
      // The account was deleted while this cookie was still around.
      auth.clearSession(req, res);
      return res.json({ available, signedIn: false });
    }
    res.json({ available, signedIn: true, email: user.email, name: user.name });
  } catch {
    res.json({ available, signedIn: false });
  }
});

app.delete("/api/account", async (req, res) => {
  const id = auth.currentUserId(req);
  if (!id) return res.status(401).json({ error: "You are not signed in." });
  try {
    await db.deleteUser(id);
    auth.clearSession(req, res);
    res.json({ ok: true });
  } catch (err) {
    console.error("account deletion failed:", err.message);
    res.status(500).json({ error: "Could not delete the account." });
  }
});

// ---- saved boards, owned by the signed-in user

/**
 * Boards belong to an account, so one host can never read another's answers.
 * Signed out, the board routes simply say so - everything else still works.
 */
function requireUser(req, res) {
  if (!db.isReady()) {
    res.status(503).json({ error: "Saving boards is not available on this server." });
    return null;
  }
  const id = auth.currentUserId(req);
  if (!id) {
    res.status(401).json({ error: "Sign in to save and load boards." });
    return null;
  }
  return id;
}

function cleanBoardName(name) {
  return String(name ?? "").trim().slice(0, 60) || null;
}

app.get("/api/boards", async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    res.json({ boards: await db.listBoards(userId) });
  } catch (err) {
    console.error("board list failed:", err.message);
    res.status(500).json({ error: "Could not read your boards." });
  }
});

app.get("/api/boards/:name", async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const name = cleanBoardName(req.params.name);
  if (!name) return res.status(400).json({ error: "Bad board name." });

  try {
    const board = await db.getBoard(userId, name);
    if (!board) return res.status(404).json({ error: "No saved board by that name." });
    res.json({ board });
  } catch (err) {
    console.error("board read failed:", err.message);
    res.status(500).json({ error: "Could not read that board." });
  }
});

app.post("/api/boards", async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const name = cleanBoardName(req.body?.name);
  if (!name) return res.status(400).json({ error: "Give the board a name." });

  // Save the compacted board so empty slots are not written out, but keep
  // partially-filled categories: a work-in-progress board is worth saving.
  const board = compactBoard(req.body?.board ?? blankBoard());
  if (!board.rounds[0]?.categories.length) {
    return res.status(400).json({ error: "Nothing to save yet." });
  }

  try {
    await db.saveBoard(userId, name, board);
    res.json({ ok: true, name });
  } catch (err) {
    console.error("board save failed:", err.message);
    res.status(500).json({ error: "Could not save the board." });
  }
});

app.delete("/api/boards/:name", async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const name = cleanBoardName(req.params.name);
  if (!name) return res.status(400).json({ error: "Bad board name." });

  try {
    const removed = await db.deleteBoard(userId, name);
    if (!removed) return res.status(404).json({ error: "No saved board by that name." });
    res.json({ ok: true });
  } catch (err) {
    console.error("board delete failed:", err.message);
    res.status(500).json({ error: "Could not delete that board." });
  }
});

// ---- pages

app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/play", (req, res) => res.sendFile(path.join(__dirname, "public", "play.html")));

// ------------------------------------------------------------------ WebSocket

wss.on("connection", (ws, req) => {
  if (!originAllowed(req)) {
    send(ws, { type: "fatal", message: "Blocked: unrecognised origin." });
    return ws.close();
  }
  ws.meta = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return toast(ws, "Malformed message.");
    }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "hello") return handleHello(ws, msg);
    if (!ws.meta) return toast(ws, "Say hello first.");

    const room = rooms.get(ws.meta.code);
    if (!room) return toast(ws, "This game no longer exists.");
    room.lastSeen = Date.now();

    if (ws.meta.role === "host") return handleHostMessage(ws, room, msg);
    return handlePlayerMessage(ws, room, msg);
  });

  ws.on("close", () => {
    if (!ws.meta) return;
    const room = rooms.get(ws.meta.code);
    if (!room) return;

    if (ws.meta.role === "host") {
      room.hosts.delete(ws);
      return;
    }
    // Only drop the player if this socket is still the current one - a quick
    // reconnect can land before the old socket's close event fires.
    if (room.players.get(ws.meta.playerId) === ws) {
      room.players.delete(ws.meta.playerId);
      G.removePlayer(room.game, ws.meta.playerId);
      broadcast(room);
    }
  });
});

function handleHello(ws, msg) {
  const code = String(msg.code ?? "").toUpperCase();
  const room = rooms.get(code);
  if (!room) return send(ws, { type: "fatal", message: "No game with that code." });
  room.lastSeen = Date.now();

  if (msg.role === "host") {
    if (!secretsMatch(msg.hostToken, room.hostToken)) {
      return send(ws, { type: "fatal", message: "Not the host of this game." });
    }
    ws.meta = { role: "host", code };
    room.hosts.add(ws);
    send(ws, {
      type: "hello-ok",
      role: "host",
      code,
      joinUrls: joinUrlsFor(code),
      ai: hasCredentials(),
      aiProvider: providerLabel(),
    });
    broadcast(room);
    return;
  }

  // Players bring their own id from localStorage so a refresh keeps their
  // score — but an id alone proves nothing, since every id is broadcast to
  // the whole room. Claiming one that is already taken needs its token.
  const playerId = claimPlayerId(room, msg);

  const result = G.addPlayer(room.game, { id: playerId, name: msg.name });
  if (!result.ok) {
    const reasons = {
      "blank-name": "Enter a name first.",
      "game-full": "This game is full.",
    };
    return send(ws, { type: "fatal", message: reasons[result.reason] ?? "Could not join." });
  }

  // Replace any previous socket for this player.
  const previous = room.players.get(playerId);
  if (previous && previous !== ws) {
    previous.meta = null;
    send(previous, { type: "fatal", message: "You joined from another device." });
    previous.close();
  }

  ws.meta = { role: "player", code, playerId };
  room.players.set(playerId, ws);
  send(ws, {
    type: "hello-ok",
    role: "player",
    code,
    playerId,
    playerToken: room.playerTokens.get(playerId),
  });
  broadcast(room);
}

/**
 * Works out which player this socket is allowed to be.
 *
 * An id nobody has claimed in this room is granted and given a fresh token.
 * An id that is already taken needs that token; without it the socket becomes
 * a brand-new player instead.
 *
 * Handing out a new identity rather than refusing is deliberate. An impostor
 * gets a blank player instead of their rival's score, with no error to probe,
 * and someone whose phone storage genuinely got mangled quietly starts again
 * rather than being locked out of the game — which is already what happens
 * today if you clear your browser data.
 */
function claimPlayerId(room, msg) {
  const asked =
    typeof msg.playerId === "string" && msg.playerId.length > 0 && msg.playerId.length <= 64
      ? msg.playerId
      : null;

  if (!asked) return mintPlayer(room, randomUUID());
  const held = room.playerTokens.get(asked);
  if (!held) return mintPlayer(room, asked);
  if (secretsMatch(msg.playerToken, held)) return asked;
  return mintPlayer(room, randomUUID());
}

function mintPlayer(room, playerId) {
  room.playerTokens.set(playerId, randomBytes(16).toString("hex"));
  return playerId;
}

function handlePlayerMessage(ws, room, msg) {
  if (msg.type === "setWager") return handleWager(ws, room, msg);
  if (msg.type === "setFinalWager") return handleFinalWager(ws, room, msg);
  if (msg.type === "submitFinalAnswer") return handleFinalAnswer(ws, room, msg);
  if (msg.type !== "buzz") return;

  const result = G.buzz(room.game, ws.meta.playerId, Date.now());
  if (!result.ok) {
    const reasons = {
      "too-late": "Too late!",
      "locked-out": "You already had your shot at this one.",
      "not-armed": "Wait for the host.",
      "wrong-phase": "Nothing to buzz on right now.",
    };
    return send(ws, {
      type: "buzz-rejected",
      reason: result.reason,
      message: reasons[result.reason] ?? "Buzz not accepted.",
    });
  }
  broadcast(room);
}

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
  }, G.FINAL_ANSWER_SECONDS * 1000);
}

function clearFinalTimer(room) {
  if (room.finalTimer) {
    clearTimeout(room.finalTimer);
    room.finalTimer = null;
  }
}

/** A Final Jeopardy bet, sent in secret by each player. */
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

/** A Daily Double bet, sent by the one player the host put on the clue. */
function handleWager(ws, room, msg) {
  const result = G.setWager(room.game, ws.meta.playerId, Number(msg.amount));
  if (!result.ok) {
    const reasons = {
      "not-your-wager": "This one is not yours to bet on.",
      "no-wager-player": "Wait for the host.",
      "bad-increment": "Bets go in steps of $100.",
      "bad-amount": "That is not a number.",
      "out-of-range": "That is more than you are allowed to bet.",
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

/**
 * A cheap shape and size check on a half-written board from a socket.
 *
 * It is not `validateBoard` — a draft is incomplete on purpose and must stay
 * saveable. It only bounds what the rest of the server will later walk, so a
 * host token cannot pin the event loop with a draft of a million categories.
 */
function draftLooksSane(draft) {
  if (!draft || !Array.isArray(draft.rounds)) return false;
  if (draft.rounds.length > NUM_ROUNDS) return false;
  return draft.rounds.every(
    (round) =>
      round &&
      Array.isArray(round.categories) &&
      round.categories.length <= MAX_CATEGORIES &&
      round.categories.every((cat) => cat && Array.isArray(cat.clues) && cat.clues.length <= 10),
  );
}

function handleHostMessage(ws, room, msg) {
  const game = room.game;
  let result = { ok: true };

  switch (msg.type) {
    case "saveDraft": {
      // The host page owns draft editing; the server just holds it so a refresh
      // or a second host screen does not lose the work.
      //
      // The draft is never schema-validated — it is half-written by definition —
      // so it is size-checked here instead. Everything downstream walks these
      // arrays, and a draft is whatever a socket sent us.
      if (draftLooksSane(msg.draft)) {
        room.draft = msg.draft;
        broadcast(room);
      } else {
        // Silently dropping it would leave the host's screen and the server
        // holding different boards, and Start would play the older one.
        toast(ws, "That board was not saved — it is the wrong shape or too big.");
      }
      return;
    }
    case "startGame": {
      const board = compactBoard(room.draft);
      const check = validateBoard(board);
      if (!check.ok) return toast(ws, check.error);
      G.setBoard(game, check.board);
      result = G.startGame(game);
      break;
    }
    case "openClue":
      result = G.openClue(game, Number(msg.c), Number(msg.q));
      break;
    case "startNextRound":
      result = G.startNextRound(game);
      break;
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
    case "assignDailyDouble":
      result = G.assignDailyDouble(game, String(msg.playerId));
      break;
    case "setWager":
      // The host can enter the bet too, for a player whose phone has died.
      result = G.setWager(game, game.wagerPlayer, Number(msg.amount));
      break;
    case "armBuzzers":
      result = G.armBuzzers(game);
      break;
    case "disarmBuzzers":
      result = G.disarmBuzzers(game);
      break;
    case "judge":
      result = G.judge(game, Boolean(msg.correct));
      break;
    case "revealAnswer":
      result = G.revealAnswer(game);
      break;
    case "closeClue":
      result = G.closeClue(game);
      break;
    case "adjustScore":
      result = G.adjustScore(game, String(msg.playerId), Number(msg.delta));
      break;
    case "renamePlayer":
      result = G.renamePlayer(game, String(msg.playerId), msg.name);
      break;
    default:
      return;
  }

  if (!result.ok) {
    const reasons = {
      "no-board": "Fill in at least one category first.",
      "no-players": "Nobody has joined yet.",
      "already-revealed": "That clue has already been played.",
      "everyone-locked-out": "Everyone has already missed this one.",
      "wrong-phase": "Cannot do that right now.",
      "unknown-player": "That player is not in this game.",
      "no-wager-player": "Pick who found the Daily Double first.",
      "no-more-rounds": "That was the last round.",
      "no-final": "This board has no Final Jeopardy.",
      "board-unplayed": "There is still a round to play first.",
      "bets-outstanding": "Someone has not bet yet.",
      "nobody-left": "Everyone has been ruled on.",
      "bad-increment": "Bets go in steps of $100.",
      "out-of-range": "That is outside what they are allowed to bet.",
    };
    return toast(ws, reasons[result.reason] ?? "Rejected: " + result.reason);
  }
  broadcast(room);
}

// ------------------------------------------------------------------ housekeeping

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = room.hosts.size === 0 && room.players.size === 0;
    if (idle && now - room.lastSeen > ROOM_TTL_MS) {
      // Drop the answer clock with the room, or it holds a reference to it.
      clearFinalTimer(room);
      rooms.delete(code);
    }
  }

  const hourAgo = now - 60 * 60 * 1000;
  for (const [ip, times] of genByIp) {
    const recent = times.filter((t) => t > hourAgo);
    if (recent.length) genByIp.set(ip, recent);
    else genByIp.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// Saved boards need a database, but nothing else does. A failure here is
// reported and the server still starts, without the ability to save.
await db.init();

server.listen(PORT, () => {
  console.log("\n  Jeopardy server running.\n");

  // Hosted: the platform's own domain is the only address that matters, and a
  // container's network interfaces are useless to anyone outside it.
  const publicDomain =
    process.env.PUBLIC_DOMAIN?.trim() || process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (publicDomain) {
    console.log("  Public URL:   https://" + publicDomain);
  } else {
    const urls = lanAddresses().map((ip) => "http://" + ip + ":" + PORT);
    console.log("  Host screen:  http://localhost:" + PORT);
    if (urls.length) {
      console.log("  Phones join:  " + urls[0]);
      for (const extra of urls.slice(1)) console.log("                " + extra);
    } else {
      console.log("  (no LAN address found - phones can only join via a tunnel)");
    }
  }
  if (HOST_PASSWORD) console.log("  Host password: required");
  console.log(
    "  AI categories: " +
      (hasCredentials()
        ? "via " + providerLabel()
        : "off (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY)"),
  );

  // Saving boards needs both halves; say which one is missing rather than
  // leaving a dead sign-in button on the page.
  if (auth.isConfigured() && db.isReady()) {
    console.log("  Saved boards:  on, via Google sign-in");
  } else if (!auth.isConfigured() && !db.isConfigured()) {
    console.log("  Saved boards:  off (set GOOGLE_CLIENT_ID/SECRET and DATABASE_URL)");
  } else if (!auth.isConfigured()) {
    console.log("  Saved boards:  off (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)");
  } else {
    console.log("  Saved boards:  off (database unavailable)");
  }
  console.log("");
});
