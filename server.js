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
import { randomUUID, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

import * as G from "./lib/game.js";
import {
  blankBoard,
  validateBoard,
  compactBoard,
  collectAnswers,
  NUM_CATEGORIES,
} from "./lib/board.js";
import {
  generateCategory,
  GenerationError,
  hasCredentials,
  providerLabel,
} from "./lib/generate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * Saved boards. Point BOARDS_DIR at a mounted volume when hosting - a
 * container filesystem is wiped on every restart and redeploy.
 */
const BOARDS_DIR = process.env.BOARDS_DIR?.trim() || path.join(__dirname, "boards");
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

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

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
    hosts: new Set(),
    /** playerId -> ws */
    players: new Map(),
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
  const hostState = G.publicState(room.game, { forHost: true });
  for (const ws of room.hosts) {
    send(ws, { type: "state", state: hostState, draft: room.draft });
  }
  const playerState = G.publicState(room.game, { forHost: false });
  for (const [playerId, ws] of room.players) {
    send(ws, { type: "state", state: playerState, you: playerId });
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
    rooms: rooms.size,
  });
});

app.post("/api/rooms", (req, res) => {
  if (HOST_PASSWORD && req.body?.password !== HOST_PASSWORD) {
    return res.status(403).json({ error: "Wrong host password." });
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
  if (req.body?.hostToken !== room.hostToken) {
    return res.status(403).json({ error: "Not the host of this game." });
  }

  const index = Number(req.body?.categoryIndex);
  if (!Number.isInteger(index) || index < 0 || index >= NUM_CATEGORIES) {
    return res.status(400).json({ error: "Bad category slot." });
  }
  if (room.generating.has(index)) {
    return res.status(409).json({ error: "That category is already generating." });
  }

  room.generating.add(index);
  try {
    const avoid = collectAnswers(room.draft);
    const category = await generateCategory(req.body?.theme, avoid);
    room.draft.categories[index] = category;
    broadcast(room);
    res.json({ category });
  } catch (err) {
    if (err instanceof GenerationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("generate failed:", err);
    res.status(500).json({ error: "Category generation failed unexpectedly." });
  } finally {
    room.generating.delete(index);
  }
});

// ---- saved boards

function safeBoardName(name) {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .slice(0, 60);
  return cleaned || null;
}

app.get("/api/boards", async (req, res) => {
  try {
    const files = await fs.readdir(BOARDS_DIR);
    const names = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    res.json({ boards: names.sort() });
  } catch {
    res.json({ boards: [] });
  }
});

app.get("/api/boards/:name", async (req, res) => {
  const name = safeBoardName(req.params.name);
  if (!name) return res.status(400).json({ error: "Bad board name." });
  try {
    const raw = await fs.readFile(path.join(BOARDS_DIR, name + ".json"), "utf8");
    res.json({ board: JSON.parse(raw) });
  } catch {
    res.status(404).json({ error: "No saved board by that name." });
  }
});

app.post("/api/boards", async (req, res) => {
  const name = safeBoardName(req.body?.name);
  if (!name) return res.status(400).json({ error: "Give the board a name." });

  // Save the compacted board so empty slots are not written out, but keep
  // partially-filled categories: a work-in-progress board is worth saving.
  const board = compactBoard(req.body?.board ?? { categories: [] });
  if (!board.categories.length) return res.status(400).json({ error: "Nothing to save yet." });

  try {
    await fs.mkdir(BOARDS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(BOARDS_DIR, name + ".json"),
      JSON.stringify(board, null, 2),
      "utf8",
    );
    res.json({ ok: true, name });
  } catch (err) {
    console.error("board save failed:", err);
    res.status(500).json({ error: "Could not save the board." });
  }
});

// ---- pages

app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/play", (req, res) => res.sendFile(path.join(__dirname, "public", "play.html")));

// ------------------------------------------------------------------ WebSocket

wss.on("connection", (ws) => {
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
    if (msg.hostToken !== room.hostToken) {
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

  // Players bring their own id from localStorage so a refresh keeps their score.
  const playerId =
    typeof msg.playerId === "string" && msg.playerId.length > 0 && msg.playerId.length <= 64
      ? msg.playerId
      : randomUUID();

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
  send(ws, { type: "hello-ok", role: "player", code, playerId });
  broadcast(room);
}

function handlePlayerMessage(ws, room, msg) {
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

function handleHostMessage(ws, room, msg) {
  const game = room.game;
  let result = { ok: true };

  switch (msg.type) {
    case "saveDraft": {
      // The host page owns draft editing; the server just holds it so a refresh
      // or a second host screen does not lose the work.
      if (msg.draft && Array.isArray(msg.draft.categories)) {
        room.draft = msg.draft;
        broadcast(room);
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
    if (idle && now - room.lastSeen > ROOM_TTL_MS) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

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
        : "off (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY)") +
      "\n",
  );
});
