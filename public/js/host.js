import { connect, postJson, toast, fatal } from "./net.js";

// Mirrors lib/board.js. The browser cannot import that module — it pulls in
// zod and there is no build step — so the two copies are kept in step by hand,
// and the smoke test asserts round 2's values over the wire.
const ROUND_VALUES = [
  [100, 200, 300, 400, 500],
  [200, 400, 600, 800, 1000],
];
const CLUE_VALUES = ROUND_VALUES[0];
const MAX_CATEGORIES = 6;
const NUM_ROUNDS = ROUND_VALUES.length;

const blankCategory = (title = "", round = 0) => ({
  title,
  clues: ROUND_VALUES[round].map((value) => ({
    value,
    clue: "",
    answer: "",
    revealed: false,
    wager: null,
    dailyDouble: false,
  })),
});

const blankRound = (round) => ({
  categories: Array.from({ length: MAX_CATEGORIES }, () => blankCategory("", round)),
});

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

/** Sends the draft now. Adding or removing a column within the debounce
 *  window would otherwise start the game on the board as it was before. */
function flushDraftSave() {
  clearTimeout(saveTimer);
  socket.send({ type: "saveDraft", draft });
}

function buildSetup() {
  const slots = el("slots");
  slots.textContent = "";
  el("s-double").checked = Boolean(draft.options?.doubleRound);

  const rounds = draft.options?.doubleRound ? NUM_ROUNDS : 1;
  for (let r = 0; r < rounds; r++) {
    if (!draft.rounds[r]) draft.rounds[r] = blankRound(r);

    if (rounds > 1) {
      const head = document.createElement("h2");
      head.className = "slots__round";
      head.textContent = r === 0 ? "Round 1" : "Round 2 — double values";
      slots.append(head);
    }

    // Exactly the columns the host chose — a round may hold one to six.
    for (let c = 0; c < draft.rounds[r].categories.length; c++) {
      slots.append(buildSlot(r, c));
    }

    if (draft.rounds[r].categories.length < MAX_CATEGORIES) {
      const add = document.createElement("button");
      add.className = "btn btn--quiet slots__add";
      add.type = "button";
      add.textContent = "Add category";
      add.addEventListener("click", () => {
        draft.rounds[r].categories.push(blankCategory("", r));
        queueDraftSave();
        buildSetup();
      });
      slots.append(add);
    }
  }
  el("s-final").checked = Boolean(draft.options?.finalRound);
  el("finalbox").hidden = !draft.options?.finalRound;
  if (draft.options?.finalRound) {
    if (!draft.final) draft.final = { category: "", clue: "", answer: "" };
    el("f-cat").value = draft.final.category;
    el("f-clue").value = draft.final.clue;
    el("f-ans").value = draft.final.answer;
  }

  setupBuilt = true;
  // Account state decides whether the board list can be populated at all, so
  // it is fetched first rather than loading a list we may not be allowed.
  refreshAccount();
}

el("s-double").addEventListener("change", (e) => {
  draft.options.doubleRound = e.target.checked;
  queueDraftSave();
  // Round 2's slots appear or disappear; anything typed into them stays in the
  // draft either way, so toggling off and on again loses nothing.
  buildSetup();
});

el("s-final").addEventListener("change", (e) => {
  draft.options.finalRound = e.target.checked;
  queueDraftSave();
  buildSetup();
});

for (const [id, key] of [
  ["f-cat", "category"],
  ["f-clue", "clue"],
  ["f-ans", "answer"],
]) {
  el(id).addEventListener("input", (e) => {
    if (!draft.final) draft.final = { category: "", clue: "", answer: "" };
    draft.final[key] = e.target.value;
    queueDraftSave();
  });
}

/** Resizes a textarea to fit its content. */
function autoGrow(box) {
  box.style.height = "auto";
  box.style.height = box.scrollHeight + 2 + "px";
}

/** Two rounds mean two identical-looking grids; a screen reader needs them apart. */
function roundLabel(r, c) {
  return "Round " + (r + 1) + " category " + (c + 1);
}

/** "round:category" for every slot with a generation in flight. */
const generating = new Set();

/** True while any column in this round is being written into. */
function roundIsGenerating(r) {
  for (const key of generating) if (key.startsWith(`${r}:`)) return true;
  return false;
}

/** Re-evaluates every × after a generation starts or finishes. */
function refreshRemoveButtons() {
  for (const slot of document.querySelectorAll(".slot")) {
    const r = Number(slot.dataset.round);
    const btn = slot.querySelector(".slot__remove");
    if (btn) btn.disabled = draft.rounds[r].categories.length <= 1 || roundIsGenerating(r);
  }
}

function buildSlot(r, c) {
  const cat = draft.rounds[r].categories[c];

  const slot = document.createElement("div");
  slot.className = "slot";
  slot.dataset.cat = String(c);
  slot.dataset.round = String(r);

  const n = document.createElement("span");
  n.className = "slot__n";
  n.textContent = "Category " + (c + 1);

  const remove = document.createElement("button");
  remove.className = "slot__remove";
  remove.type = "button";
  remove.textContent = "×";
  remove.title = "Remove this category";
  remove.setAttribute("aria-label", "Remove " + roundLabel(r, c).toLowerCase());
  // Locked while ANY column in this round is being written into, not just this
  // one: removing an earlier column renumbers the generating one, and the
  // arriving category would land on whichever category shuffled into its slot.
  remove.disabled = draft.rounds[r].categories.length <= 1 || roundIsGenerating(r);
  remove.addEventListener("click", () => {
    draft.rounds[r].categories.splice(c, 1);
    queueDraftSave();
    // Every later column just renumbered, so redraw rather than patch.
    buildSetup();
  });
  n.append(remove);

  const title = document.createElement("input");
  title.type = "text";
  title.placeholder = "Category name";
  title.value = cat.title;
  title.setAttribute("aria-label", roundLabel(r, c) + " name");
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
  theme.setAttribute("aria-label", "Theme for " + roundLabel(r, c).toLowerCase());
  const genBtn = document.createElement("button");
  genBtn.className = "btn";
  genBtn.textContent = "Fill with AI";
  gen.append(theme, genBtn);

  const run = async () => {
    const wanted = theme.value.trim();
    if (!wanted) return toast("Type a theme first, like “Pokemon” or “90s rap”.");
    genBtn.disabled = true;
    genBtn.textContent = "Writing…";
    // Locks every × in this round until the write lands or fails.
    generating.add(`${r}:${c}`);
    refreshRemoveButtons();
    try {
      const { category } = await postJson("/api/rooms/" + code + "/generate", {
        hostToken,
        roundIndex: r,
        categoryIndex: c,
        theme: wanted,
      });
      draft.rounds[r].categories[c] = category;
      generating.delete(`${r}:${c}`);
      // Replace the slot wholesale: every field in it changed.
      slot.replaceWith(buildSlot(r, c));
      // The other columns in this round were locked while it ran.
      refreshRemoveButtons();
      toast("Wrote “" + category.title + "”. Check it before you play.", "good");
    } catch (err) {
      generating.delete(`${r}:${c}`);
      toast(err.message);
      genBtn.disabled = false;
      genBtn.textContent = "Fill with AI";
      refreshRemoveButtons();
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

el("start").addEventListener("click", () => {
  flushDraftSave();
  socket.send({ type: "startGame" });
});

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

    // A saved board is the full wrapper. Clamp each round to the ceiling in
    // case it was written by a wider build than this one.
    draft = {
      // Both dimensions are clamped. An over-wide board the server would
      // silently reject leaves the screen and the server disagreeing about
      // what is loaded, and Start then plays the older board with no error.
      rounds: (body.board.rounds ?? []).slice(0, NUM_ROUNDS).map((round) => ({
        categories: (round.categories ?? []).slice(0, MAX_CATEGORIES),
      })),
      final: body.board.final ?? null,
      options: {
        doubleRound: Boolean(body.board.options?.doubleRound),
        finalRound: Boolean(body.board.options?.finalRound),
      },
    };
    if (!draft.rounds.length) draft.rounds = [blankRound(0)];
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
  renderRoundEnd(state);
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
  const wagering = state.phase === "wager";
  const open = state.phase === "clue" || state.phase === "buzzed" || wagering;
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

  // While the bet is open the whole control bar is replaced by the picker, so
  // there is nothing else to draw.
  if (renderDailyDouble(state, clue, wagering)) return;

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
    // On a Daily Double they were handed the clue rather than buzzing for it.
    who.append(
      strong,
      document.createTextNode(clue.dailyDouble ? " is answering" : " buzzed in"),
    );
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

/**
 * Draws the Daily Double takeover. Returns true while the bet is still open,
 * which tells `renderClue` the ordinary controls do not apply yet.
 *
 * The host picks the finder here because Buzz Night has no concept of board
 * control — the host drives the board, so only they know who chose the square.
 */
function renderDailyDouble(state, clue, wagering) {
  el("c-dd").hidden = !clue.dailyDouble;
  el("c-ddpick").hidden = !wagering || Boolean(state.wagerPlayer);
  el("c-ddwait").hidden = !wagering || !state.wagerPlayer;

  if (!wagering) return false;

  // The clue stays off the host's main panel too, so a host reading aloud
  // cannot accidentally give it away before the bet is locked.
  el("c-text").textContent = "";

  if (state.wagerPlayer) {
    const who = state.players.find((p) => p.id === state.wagerPlayer);
    el("c-ddwait").textContent =
      `${who?.name ?? "They"} is betting — up to $${state.wagerMax}. Their phone has the pad.`;
  } else {
    const row = el("c-ddplayers");
    row.textContent = "";
    for (const p of state.players) {
      const btn = document.createElement("button");
      btn.className = "btn btn--quiet";
      btn.textContent = p.name;
      btn.addEventListener("click", () =>
        socket.send({ type: "assignDailyDouble", playerId: p.id }),
      );
      row.append(btn);
    }
  }

  for (const id of ["c-yes", "c-no", "c-arm", "c-reveal", "c-peek"]) el(id).hidden = true;
  el("c-who").textContent = state.wagerPlayer
    ? "Waiting for the bet."
    : "Daily Double — tap whoever picked this square.";
  return true;
}

// ------------------------------------------------------------------ round end

/** A scoreboard between boards, so the room gets a beat before round 2. */
function renderRoundEnd(state) {
  const atRoundEnd = state.phase === "round-end";
  el("roundend").hidden = !atRoundEnd;
  if (!atRoundEnd) return;

  el("re-done").textContent = `End of round ${state.round}.`;
  el("re-next").textContent = `Start round ${state.round + 1}`;

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
