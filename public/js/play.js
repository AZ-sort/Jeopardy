import { connect, toast } from "./net.js";

const el = (id) => document.getElementById(id);

/**
 * The player's id is generated here and kept in localStorage, so backgrounding
 * the browser or refreshing mid-game rejoins as the same person with the same
 * score rather than appearing as a second player.
 */
function playerId() {
  let id = localStorage.getItem("playerId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("playerId", id);
  }
  return id;
}

/**
 * The secret that proves this phone owns its player id.
 *
 * Per room, like the host's token, because every player's id is broadcast to
 * the whole room — the id says who you claim to be, the token is why the
 * server believes you. Issued on first join; lose it and you simply join as
 * somebody new, which is what clearing browser data has always done.
 */
function playerToken(code) {
  return localStorage.getItem("playerToken:" + code) ?? "";
}

function rememberPlayerToken(code, token) {
  if (token) localStorage.setItem("playerToken:" + code, token);
}

let socket = null;
let myId = null;
let state = null;
/** Set while a buzz is in flight, so one press cannot send twice. */
let buzzSent = false;
/** The bet showing on the pad, in whole hundreds. Null until the pad opens. */
let wagerAmount = null;
/** Set while a bet is in flight, so a double tap cannot send twice. */
let wagerSent = false;

// ------------------------------------------------------------------ joining

const codeFromUrl = new URLSearchParams(location.search).get("code")?.toUpperCase();
const savedName = localStorage.getItem("playerName") ?? "";

el("j-code").value = codeFromUrl ?? "";
el("j-name").value = savedName;

if (codeFromUrl && savedName) {
  join(codeFromUrl, savedName);
} else {
  el("join").hidden = false;
  (codeFromUrl ? el("j-name") : el("j-code")).focus();
}

el("j-go").addEventListener("click", submitJoin);
el("j-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitJoin();
});
el("j-code").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "");
});

function submitJoin() {
  const code = el("j-code").value.trim().toUpperCase();
  const name = el("j-name").value.trim();
  if (code.length !== 4) return toast("The game code is four letters.");
  if (!name) return toast("Enter the name you want on the scoreboard.");
  join(code, name);
}

function join(code, name) {
  localStorage.setItem("playerName", name);
  el("join").hidden = true;
  el("play").hidden = false;
  el("p-name").textContent = name;

  socket = connect({
    hello: () => ({
      role: "player",
      code,
      playerId: playerId(),
      playerToken: playerToken(code),
      name,
    }),
    onMessage(msg) {
      if (msg.type === "hello-ok") {
        // The server may have handed us a different id than we asked for —
        // if our token did not match, we are somebody new now.
        myId = msg.playerId;
        localStorage.setItem("playerId", msg.playerId);
        rememberPlayerToken(code, msg.playerToken);
        return;
      }
      if (msg.type === "state") {
        // Measured against the server once, so a phone with a wrong clock
        // still counts a Final Jeopardy deadline down correctly.
        // Measured once, as the comment below says. Re-measuring on every
        // broadcast folded that message's latency into the offset, so the
        // countdown could tick sideways by a second when the network hiccuped.
        if (typeof msg.now === "number" && !skewMeasured) {
          clockSkew = msg.now - Date.now();
          skewMeasured = true;
        }
        state = msg.state;
        render();
        return;
      }
      if (msg.type === "buzz-rejected") {
        buzzSent = false;
        toast(msg.message);
        render();
        return;
      }
      if (msg.type === "wager-rejected") {
        wagerSent = false;
        toast(msg.message);
        render();
        return;
      }
      if (msg.type === "answer-rejected") {
        toast(msg.message);
        render();
      }
    },
  });
}

// ------------------------------------------------------------------ buzzing

const buzzer = el("buzz");

function sendBuzz() {
  if (buzzer.disabled || buzzSent) return;
  buzzSent = true;
  socket.send({ type: "buzz" });
  // Immediate local feedback — the round trip is fast but not instant, and a
  // buzzer that feels laggy gets mashed.
  buzzer.classList.add("buzzer--mine");
  navigator.vibrate?.(60);
}

// pointerdown rather than click: a click waits for the release, and on a buzzer
// the press is the moment that counts.
buzzer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  sendBuzz();
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input")) return;
  if (e.code === "Space" || e.key === "Enter") {
    e.preventDefault();
    sendBuzz();
  }
});

// ------------------------------------------------------------------ wagering

const wagerPad = el("p-wager");

/** Bets move in whole hundreds, so the pad is two buttons rather than a keypad. */
/** A Daily Double starts at $100; Final Jeopardy lets you bet nothing. */
function wagerFloor() {
  return state?.phase === "final-wager" ? 0 : (state?.wagerStep ?? 100);
}

/** The ceiling differs too: own score for the final, board high for a double. */
function wagerCeiling() {
  if (state?.phase === "final-wager") return state.final?.myMax ?? 0;
  return state?.wagerMax ?? state?.wagerStep ?? 100;
}

function stepWager(by) {
  const step = state?.wagerStep ?? 100;
  const floor = wagerFloor();
  const max = wagerCeiling();
  wagerAmount = Math.min(Math.max((wagerAmount ?? floor) + by * step, floor), max);
  renderWager();
}

function sendWager() {
  if (wagerSent || wagerAmount == null) return;
  wagerSent = true;
  socket.send(
    state?.phase === "final-wager"
      ? { type: "setFinalWager", amount: wagerAmount }
      : { type: "setWager", amount: wagerAmount },
  );
}

el("p-wager-down").addEventListener("click", () => stepWager(-1));
el("p-wager-up").addEventListener("click", () => stepWager(1));
el("p-wager-go").addEventListener("click", sendWager);

function renderWager() {
  const floor = wagerFloor();
  const max = wagerCeiling();
  const shown = wagerAmount ?? floor;

  el("p-wager-amount").textContent = "$" + shown;
  el("p-wager-limit").textContent = `Anything from $${floor} to $${max}, in hundreds.`;
  el("p-wager-down").disabled = shown <= floor;
  el("p-wager-up").disabled = shown >= max;
}

// ------------------------------------------------------------ final jeopardy

const FINAL_PHASES = ["final-wager", "final-clue", "final-reveal"];

let clockTimer = null;
/** Offset between this phone's clock and the server's, measured once. */
let clockSkew = 0;
let skewMeasured = false;

function startClock(deadline) {
  if (clockTimer || !deadline) return;
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - (Date.now() + clockSkew)) / 1000));
    el("p-clock").textContent = left + "s";
    if (left === 0) {
      // Shut the box on the phone the moment the clock reads zero, rather than
      // leaving it open and inviting a submission the rules will refuse.
      el("p-final-answer").hidden = true;
      stopClock();
    }
  };
  tick();
  clockTimer = setInterval(tick, 250);
}

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
}

el("p-answer-go").addEventListener("click", () => {
  const text = el("p-answer").value.trim();
  // An empty submission used to lock the box shut with the whole bet riding on
  // it: the server stored "", which is not null, so the input hid and there was
  // no way back. Nothing is sent until there is something to send.
  if (!text) return toast("Write something first.");
  socket.send({ type: "submitFinalAnswer", answer: text });
});

/** The phone's view of Final Jeopardy. Returns true when it owns the screen. */
function renderFinal() {
  const phase = state.phase;
  const f = state.final;
  const onFinal = FINAL_PHASES.includes(phase) && f;
  el("p-final").hidden = !onFinal;
  el("p-final-rest").hidden = !onFinal;
  document.querySelector(".play__main").classList.toggle("play__main--final", Boolean(onFinal));
  // The pad is shared with the Daily Double; during the final the heading
  // above it already says which round this is.
  el("p-wager-title").hidden = onFinal;
  if (!onFinal) {
    stopClock();
    return false;
  }

  const betting = phase === "final-wager";
  const mine = f.playing.includes(myId);
  const alreadyBet = f.myWager !== null;

  // The pad is the Daily Double pad, at a $0 floor.
  wagerPad.hidden = !(betting && mine && !alreadyBet);
  buzzer.hidden = true;
  // Stays open for the whole window, not just until the first submit: the
  // rules accept a correction right up to the deadline, so the UI should too.
  el("p-final-answer").hidden = !(phase === "final-clue" && mine);
  el("p-clock").hidden = phase !== "final-clue";
  el("p-clue").textContent = f.clue ?? "";

  if (betting) {
    stopClock();
    el("p-final-note").textContent = !mine
      ? "You joined after the betting started — sit this one out."
      : alreadyBet
        ? `You bet $${f.myWager}. Waiting for everyone else.`
        : f.myMax === 0
          ? "You have nothing to bet, so you are in at $0."
          : "";
    if (mine && !alreadyBet) {
      // Clamp rather than default: a leftover amount from a Daily Double
      // earlier in the game would otherwise show a bet this player cannot make.
      wagerAmount = Math.min(Math.max(wagerAmount ?? 0, 0), f.myMax ?? 0);
      renderWager();
    }
  } else if (phase === "final-clue") {
    el("p-final-note").textContent = !mine
      ? "You joined after the betting started — sit this one out."
      : f.myAnswer !== null
        ? `Locked in: ${f.myAnswer} — you can change it until time is up.`
        : "";
    startClock(f.deadline);
  } else {
    stopClock();
    el("p-final-note").textContent = mine
      ? "Answers are going up on the big screen."
      : "Final Jeopardy is being revealed on the big screen.";
  }
  return true;
}

// ------------------------------------------------------------------ rendering

let wasArmed = false;

function render() {
  if (!state) return;

  const me = state.players.find((p) => p.id === myId);
  const page = el("play");
  const meta = el("p-meta");
  const clueText = el("p-clue");

  if (me) {
    el("p-name").textContent = me.name;
    el("p-score").textContent = (me.score < 0 ? "−$" : "$") + Math.abs(me.score);
  }

  // Final Jeopardy owns the whole screen when it is on; the buzzer and clue
  // block below would otherwise fight it over the same elements.
  if (renderFinal()) {
    meta.textContent = "";
    return;
  }

  const clue = state.activeClue;
  const lockedOut = state.lockedOut.includes(myId);
  const iBuzzed = state.buzzedPlayer === myId;
  const someoneElse = state.buzzedPlayer && !iBuzzed;
  const live = state.buzzersArmed && !state.buzzedPlayer && !lockedOut;

  const wagering = state.phase === "wager";
  const myWager = wagering && state.wagerPlayer === myId;

  // One buzz claim per clue: clear the latch when the window reopens.
  if (!state.buzzedPlayer) buzzSent = false;

  // The pad replaces the buzzer entirely — a Daily Double is nobody else's to
  // grab, so leaving a live-looking buzzer on screen would only mislead.
  wagerPad.hidden = !myWager;
  buzzer.hidden = myWager;
  if (!wagering) {
    wagerAmount = null;
    wagerSent = false;
  } else if (myWager) {
    if (wagerAmount == null) wagerAmount = state.wagerStep ?? 100;
    renderWager();
  }

  page.classList.toggle("play--armed", live);
  page.classList.toggle("play--mine", iBuzzed);

  buzzer.classList.toggle("buzzer--live", live);
  buzzer.classList.toggle("buzzer--mine", iBuzzed);
  buzzer.disabled = !live;

  // Clue context, so this works whether players are on the couch or on a call.
  if (clue) {
    meta.textContent = "";
    const cat = document.createElement("b");
    cat.textContent = clue.category;
    meta.append(cat, document.createTextNode(" · $" + clue.value));

    // Null while a Daily Double is being bet on — the clue is host-only until
    // the wager is locked, so there is deliberately nothing to show yet.
    clueText.textContent = clue.clue ?? "";
    if (state.answerRevealed && clue.answer) {
      const ans = document.createElement("em");
      ans.textContent = clue.answer;
      clueText.append(ans);
    }
  } else {
    clueText.textContent = "";
    meta.textContent =
      state.phase === "round-end"
        ? "End of the round. Scores are on the big screen."
        : state.phase === "lobby"
          ? "Waiting for the host to start the game."
          : state.phase === "done"
            ? "That is the whole board. Final scores are on the big screen."
            : "Waiting for the host to pick a clue.";
  }

  if (iBuzzed) {
    buzzer.textContent = "You're in";
  } else if (someoneElse) {
    const other = state.players.find((p) => p.id === state.buzzedPlayer);
    buzzer.textContent = other ? other.name : "Taken";
  } else if (lockedOut) {
    buzzer.textContent = "Out";
  } else if (live) {
    buzzer.textContent = "Buzz";
  } else {
    buzzer.textContent = "Wait";
  }

  // Say what the buzzer state means, since the colour alone is not enough.
  if (myWager) {
    meta.textContent = "Daily Double — it's yours. How much are you betting?";
  } else if (wagering) {
    const finder = state.players.find((p) => p.id === state.wagerPlayer);
    meta.textContent = finder
      ? `Daily Double — ${finder.name} is betting.`
      : "Daily Double — the host is picking who found it.";
  } else if (iBuzzed) {
    // Nobody buzzed for a Daily Double, so saying they did reads as a bug.
    meta.textContent = clue?.dailyDouble
      ? "Your Daily Double. Answer out loud."
      : "You buzzed first. Answer out loud.";
  } else if (someoneElse) {
    const other = state.players.find((p) => p.id === state.buzzedPlayer);
    meta.textContent = (other?.name ?? "Someone") + " got in first.";
  } else if (lockedOut) {
    meta.textContent = "You already had a go at this one.";
  }

  // A buzz window opening is the one thing a player must not miss while looking
  // at the TV instead of their phone.
  if (live && !wasArmed) navigator.vibrate?.([0, 40, 50, 40]);
  wasArmed = live;
}
