import { connect, postJson, toast, fatal } from "./net.js";

const CLUE_VALUES = [100, 200, 300, 400, 500];
const NUM_CATEGORIES = 6;

const code = new URLSearchParams(location.search).get("code")?.toUpperCase();
const hostToken = code ? localStorage.getItem("hostToken:" + code) : null;

if (!code || !hostToken) {
  fatal(
    "This browser is not the host",
    "Only the device that created the game can run it. Start a new game from the home page.",
  );
  throw new Error("missing host credentials");
}

const el = (id) => document.getElementById(id);

/**
 * The board being authored. Owned by this page, not the server.
 *
 * The server keeps a copy purely as crash insurance, which is why incoming
 * broadcasts are not allowed to re-render the editor — doing so would wipe out
 * whatever the host is mid-sentence on. Generated categories are applied from
 * the generate response instead.
 */
let draft = null;
let setupBuilt = false;
let lastState = null;

/**
 * The address to read out to the room.
 *
 * Whatever address this page was loaded from is the one that works — true when
 * hosted on a public domain, and true on a LAN if the host opened it by IP. The
 * exception is localhost, which no phone can follow, so there we fall back to
 * the LAN address the server found for us.
 */
function joinUrl(msg) {
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (local && msg.joinUrls?.length) return msg.joinUrls[0];
  return location.origin + "/play?code=" + msg.code;
}

const socket = connect({
  hello: () => ({ role: "host", code, hostToken }),
  onMessage(msg) {
    if (msg.type === "hello-ok") {
      el("s-code").textContent = msg.code;
      el("g-code").textContent = msg.code;
      const url = joinUrl(msg);
      el("s-url").textContent = url.replace(/^https?:\/\//, "");
      el("g-url").textContent = url.replace(/^https?:\/\//, "");
      el("ai-off").hidden = Boolean(msg.ai);
      // Which model writes the clues is configuration, not a game choice - but
      // the host should still be able to see which one is answering.
      el("s-ai").hidden = !msg.aiProvider;
      el("s-ai").textContent = msg.aiProvider
        ? "AI categories by " + msg.aiProvider
        : "";
      return;
    }
    if (msg.type === "state") {
      if (!draft && msg.draft) {
        draft = msg.draft;
        buildSetup();
      }
      render(msg.state);
    }
  },
});

// ------------------------------------------------------------------ setup view

let saveTimer = null;
function queueDraftSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => socket.send({ type: "saveDraft", draft }), 600);
}

function buildSetup() {
  const slots = el("slots");
  slots.textContent = "";

  for (let c = 0; c < NUM_CATEGORIES; c++) {
    if (!draft.categories[c]) {
      draft.categories[c] = {
        title: "",
        clues: CLUE_VALUES.map((value) => ({
          value,
          clue: "",
          answer: "",
          revealed: false,
          wager: null,
        })),
      };
    }
    slots.append(buildSlot(c));
  }
  setupBuilt = true;
  // Account state decides whether the board list can be populated at all, so
  // it is fetched first rather than loading a list we may not be allowed.
  refreshAccount();
}

/** Resizes a textarea to fit its content. */
function autoGrow(box) {
  box.style.height = "auto";
  box.style.height = box.scrollHeight + 2 + "px";
}

function buildSlot(c) {
  const cat = draft.categories[c];

  const slot = document.createElement("div");
  slot.className = "slot";
  slot.dataset.cat = String(c);

  const n = document.createElement("span");
  n.className = "slot__n";
  n.textContent = "Category " + (c + 1);

  const title = document.createElement("input");
  title.type = "text";
  title.placeholder = "Category name";
  title.value = cat.title;
  title.setAttribute("aria-label", "Category " + (c + 1) + " name");
  title.addEventListener("input", () => {
    cat.title = title.value;
    queueDraftSave();
  });

  // Ask-the-AI row
  const gen = document.createElement("div");
  gen.className = "slot__gen";
  const theme = document.createElement("input");
  theme.type = "text";
  theme.placeholder = "Theme, e.g. Pokemon";
  theme.setAttribute("aria-label", "Theme for category " + (c + 1));
  const genBtn = document.createElement("button");
  genBtn.className = "btn";
  genBtn.textContent = "Fill with AI";
  gen.append(theme, genBtn);

  const run = async () => {
    const wanted = theme.value.trim();
    if (!wanted) return toast("Type a theme first, like “Pokemon” or “90s rap”.");
    genBtn.disabled = true;
    genBtn.textContent = "Writing…";
    try {
      const { category } = await postJson("/api/rooms/" + code + "/generate", {
        hostToken,
        categoryIndex: c,
        theme: wanted,
      });
      draft.categories[c] = category;
      // Replace the slot wholesale: every field in it changed.
      slot.replaceWith(buildSlot(c));
      toast("Wrote “" + category.title + "”. Check it before you play.", "good");
    } catch (err) {
      toast(err.message);
      genBtn.disabled = false;
      genBtn.textContent = "Fill with AI";
    }
  };

  genBtn.addEventListener("click", run);
  theme.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });

  const clues = document.createElement("div");
  clues.className = "slot__clues";

  cat.clues.forEach((clue, q) => {
    const row = document.createElement("div");
    row.className = "cluerow";

    const val = document.createElement("span");
    val.className = "cluerow__val";
    val.textContent = "$" + clue.value;

    const fields = document.createElement("div");
    fields.className = "cluerow__fields";

    const clueBox = document.createElement("textarea");
    clueBox.placeholder = "Clue (a statement, not a question)";
    clueBox.value = clue.clue;
    clueBox.setAttribute("aria-label", "$" + clue.value + " clue");
    clueBox.addEventListener("input", () => {
      clue.clue = clueBox.value;
      autoGrow(clueBox);
      queueDraftSave();
    });
    // Generated clues are often long enough to need a fourth line, and a clue
    // whose end is hidden cannot be proof-read.
    queueMicrotask(() => autoGrow(clueBox));

    const ansBox = document.createElement("input");
    ansBox.type = "text";
    ansBox.placeholder = "Answer";
    ansBox.value = clue.answer;
    ansBox.setAttribute("aria-label", "$" + clue.value + " answer");
    ansBox.addEventListener("input", () => {
      clue.answer = ansBox.value;
      queueDraftSave();
    });

    fields.append(clueBox, ansBox);
    row.append(val, fields);
    clues.append(row);
  });

  slot.append(n, title, gen, clues);
  return slot;
}

el("start").addEventListener("click", () => socket.send({ type: "startGame" }));

/**
 * Saved boards belong to an account, so they follow you to any device.
 *
 * Signing in unlocks saving and nothing else — hosting, playing and generating
 * categories all work signed out, so nobody has to hand over an identity to
 * play a party game.
 */
let account = { available: false, signedIn: false };

async function refreshAccount() {
  try {
    account = await (await fetch("/api/me")).json();
  } catch {
    account = { available: false, signedIn: false };
  }
  renderAccount();
  if (account.signedIn) loadSavedBoardList();
  else clearSavedBoardList();
}

function renderAccount() {
  const line = el("account");
  line.textContent = "";
  line.hidden = false;

  if (!account.available) {
    line.textContent = "Saving boards is switched off on this server.";
    return;
  }

  if (!account.signedIn) {
    line.append(document.createTextNode("Boards you save follow you to any device. "));
    const link = document.createElement("a");
    link.href = "/auth/google";
    link.textContent = "Sign in with Google";
    line.append(link, document.createTextNode(" to save this one."));
    return;
  }

  line.append(document.createTextNode("Signed in as " + (account.email ?? account.name ?? "you") + ". "));

  const out = document.createElement("button");
  out.textContent = "Sign out";
  out.addEventListener("click", async () => {
    await postJson("/auth/logout");
    refreshAccount();
    toast("Signed out.", "good");
  });

  const remove = document.createElement("button");
  remove.className = "danger";
  remove.textContent = "Delete account";
  remove.addEventListener("click", async () => {
    if (!confirm("Delete your account and every board you have saved? This cannot be undone.")) {
      return;
    }
    const res = await fetch("/api/account", { method: "DELETE" });
    if (!res.ok) return toast("Could not delete the account.");
    refreshAccount();
    toast("Account and boards deleted.", "good");
  });

  line.append(out, document.createTextNode(" · "), remove);
}

/** Board actions are visible but explain themselves rather than silently failing. */
function needsSignIn() {
  if (!account.available) {
    toast("Saving boards is switched off on this server.");
    return true;
  }
  if (!account.signedIn) {
    toast("Sign in with Google first — the link is just below.");
    return true;
  }
  return false;
}

el("save").addEventListener("click", async () => {
  if (needsSignIn()) return;
  const name = el("board-name").value.trim();
  if (!name) return toast("Give the board a name first.");
  try {
    await postJson("/api/boards", { name, board: draft });
    toast("Saved as “" + name + "”.", "good");
    loadSavedBoardList();
  } catch (err) {
    toast(err.message);
  }
});

el("delete").addEventListener("click", async () => {
  if (needsSignIn()) return;
  const name = el("board-name").value.trim();
  if (!name) return toast("Load or name a saved board first, then delete it.");
  if (!confirm("Delete the saved board “" + name + "”?")) return;

  const res = await fetch("/api/boards/" + encodeURIComponent(name), { method: "DELETE" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return toast(body.error ?? "Could not delete that board.");
  toast("Deleted “" + name + "”.", "good");
  loadSavedBoardList();
});

function clearSavedBoardList() {
  const select = el("saved");
  select.textContent = "";
  const only = document.createElement("option");
  only.value = "";
  only.textContent = account.available ? "Sign in to load a board" : "Saving is off";
  select.append(only);
}

async function loadSavedBoardList() {
  if (!account.signedIn) return clearSavedBoardList();

  const select = el("saved");
  try {
    const res = await fetch("/api/boards");
    if (!res.ok) return clearSavedBoardList();
    const { boards } = await res.json();

    select.textContent = "";
    const first = document.createElement("option");
    first.value = "";
    first.textContent = boards.length ? "Load a saved board…" : "No saved boards yet";
    select.append(first);
    for (const name of boards) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.append(opt);
    }
  } catch {
    /* the list is a convenience; failing to load it is not worth a toast */
  }
}

el("saved").addEventListener("change", async (e) => {
  const name = e.target.value;
  e.target.value = "";
  if (!name) return;

  try {
    const res = await fetch("/api/boards/" + encodeURIComponent(name));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Could not load that board.");

    draft = { categories: body.board.categories.slice(0, NUM_CATEGORIES) };
    buildSetup();
    el("board-name").value = name;
    socket.send({ type: "saveDraft", draft });
    toast("Loaded “" + name + "”.", "good");
  } catch (err) {
    toast(err.message);
  }
});

// ------------------------------------------------------------------ game view

function render(state) {
  lastState = state;
  const inSetup = state.phase === "lobby";

  el("setup").hidden = !inSetup;
  el("game").hidden = inSetup;

  if (inSetup) {
    renderLobby(state);
    return;
  }

  renderBoard(state);
  renderScores(state);
  renderClue(state);
}

function renderLobby(state) {
  const names = state.players.filter((p) => p.connected).map((p) => p.name);
  el("lobby").textContent = names.length
    ? "In the game: " + names.join(", ")
    : "Nobody has joined yet.";
}

function renderBoard(state) {
  const board = el("board");
  const cats = state.board?.categories ?? [];
  board.style.gridTemplateColumns = "repeat(" + cats.length + ", minmax(0, 1fr))";
  board.style.gridTemplateRows = "auto repeat(" + CLUE_VALUES.length + ", minmax(0, 1fr))";
  board.textContent = "";

  for (const cat of cats) {
    const head = document.createElement("div");
    head.className = "board__cat";
    head.textContent = cat.title;
    board.append(head);
  }

  // Grid fills row by row, so iterate clue index in the outer loop.
  for (let q = 0; q < CLUE_VALUES.length; q++) {
    for (let c = 0; c < cats.length; c++) {
      const clue = cats[c].clues[q];
      const cell = document.createElement("button");
      cell.className = "tile board__cell";
      if (clue.revealed) {
        cell.classList.add("tile--spent", "board__cell--spent");
        cell.disabled = true;
        cell.setAttribute("aria-label", cats[c].title + " $" + clue.value + ", already played");
      } else {
        cell.setAttribute("aria-label", cats[c].title + " for $" + clue.value);
        cell.addEventListener("click", () => socket.send({ type: "openClue", c, q }));
      }

      const value = document.createElement("span");
      value.className = "value";
      value.textContent = "$" + clue.value;
      cell.append(value);
      board.append(cell);
    }
  }

  el("g-count").textContent =
    state.players.filter((p) => p.connected).length + " on their phones";
}

function renderScores(state) {
  const tray = el("scores");
  tray.textContent = "";

  for (const player of state.players) {
    const card = document.createElement("div");
    card.className = "score";
    if (state.buzzedPlayer === player.id) card.classList.add("score--buzzed");
    if (state.lockedOut.includes(player.id)) card.classList.add("score--out");
    if (!player.connected) card.classList.add("score--gone");

    const name = document.createElement("div");
    name.className = "score__name";
    name.textContent = player.name;

    const points = document.createElement("div");
    points.className = "score__points";
    if (player.score < 0) points.classList.add("score__points--negative");
    points.textContent = (player.score < 0 ? "−$" : "$") + Math.abs(player.score);

    const nudge = document.createElement("div");
    nudge.className = "score__nudge";
    for (const delta of [-100, 100]) {
      const b = document.createElement("button");
      b.textContent = delta < 0 ? "−100" : "+100";
      b.setAttribute(
        "aria-label",
        (delta < 0 ? "Take 100 from " : "Give 100 to ") + player.name,
      );
      b.addEventListener("click", () =>
        socket.send({ type: "adjustScore", playerId: player.id, delta }),
      );
      nudge.append(b);
    }

    card.append(name, points, nudge);
    tray.append(card);
  }
}

// ------------------------------------------------------------------ clue takeover

let peeking = false;

function renderClue(state) {
  const open = state.phase === "clue" || state.phase === "buzzed";
  el("clue").hidden = !open;
  if (!open) {
    peeking = false;
    return;
  }

  const clue = state.activeClue;
  el("c-cat").textContent = clue.category;
  el("c-val").textContent = "$" + clue.value;
  el("c-text").textContent = clue.clue;
  el("c-armed").hidden = !state.buzzersArmed;

  // Public answer: only once the host has shown it to the room.
  el("c-ans").hidden = !state.answerRevealed;
  el("c-ans").textContent = state.answerRevealed ? clue.answer : "";

  // Private peek, in small type down in the control bar.
  const peekText = el("c-peektext");
  peekText.hidden = !peeking;
  peekText.textContent = peeking ? clue.answer : "";
  el("c-peek").setAttribute("aria-expanded", String(peeking));
  el("c-peek").textContent = peeking ? "Hide answer" : "Peek at answer";
  el("c-peek").hidden = state.answerRevealed;

  const buzzed = state.players.find((p) => p.id === state.buzzedPlayer);
  const who = el("c-who");
  if (buzzed) {
    who.textContent = "";
    const strong = document.createElement("strong");
    strong.textContent = buzzed.name;
    who.append(strong, document.createTextNode(" buzzed in"));
  } else if (state.buzzersArmed) {
    who.textContent = "Waiting for a buzz…";
  } else if (state.lockedOut.length) {
    who.textContent = "Everyone who buzzed got it wrong.";
  } else {
    who.textContent = "Read the clue, then open the buzzers.";
  }

  el("c-yes").hidden = !buzzed;
  el("c-no").hidden = !buzzed;
  el("c-arm").hidden = Boolean(buzzed) || state.buzzersArmed || state.answerRevealed;
  el("c-reveal").hidden = state.answerRevealed;
}

el("c-arm").addEventListener("click", () => socket.send({ type: "armBuzzers" }));
el("c-yes").addEventListener("click", () => socket.send({ type: "judge", correct: true }));
el("c-no").addEventListener("click", () => socket.send({ type: "judge", correct: false }));
el("c-reveal").addEventListener("click", () => socket.send({ type: "revealAnswer" }));
el("c-close").addEventListener("click", () => socket.send({ type: "closeClue" }));

el("c-peek").addEventListener("click", () => {
  peeking = !peeking;
  if (lastState) renderClue(lastState);
});

// Keyboard shortcuts: the host is watching the room, not the screen.
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if (!lastState || el("clue").hidden) return;

  const buzzed = Boolean(lastState.buzzedPlayer);
  if (e.code === "Space" && !buzzed && !lastState.buzzersArmed) {
    e.preventDefault();
    socket.send({ type: "armBuzzers" });
  } else if (e.key === "y" && buzzed) {
    socket.send({ type: "judge", correct: true });
  } else if (e.key === "n" && buzzed) {
    socket.send({ type: "judge", correct: false });
  } else if (e.key === "Escape") {
    socket.send({ type: "closeClue" });
  }
});
