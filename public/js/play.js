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

let socket = null;
let myId = null;
let state = null;
/** Set while a buzz is in flight, so one press cannot send twice. */
let buzzSent = false;

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
    hello: () => ({ role: "player", code, playerId: playerId(), name }),
    onMessage(msg) {
      if (msg.type === "hello-ok") {
        myId = msg.playerId;
        return;
      }
      if (msg.type === "state") {
        state = msg.state;
        render();
        return;
      }
      if (msg.type === "buzz-rejected") {
        buzzSent = false;
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

  const clue = state.activeClue;
  const lockedOut = state.lockedOut.includes(myId);
  const iBuzzed = state.buzzedPlayer === myId;
  const someoneElse = state.buzzedPlayer && !iBuzzed;
  const live = state.buzzersArmed && !state.buzzedPlayer && !lockedOut;

  // One buzz claim per clue: clear the latch when the window reopens.
  if (!state.buzzedPlayer) buzzSent = false;

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

    clueText.textContent = clue.clue;
    if (state.answerRevealed && clue.answer) {
      const ans = document.createElement("em");
      ans.textContent = clue.answer;
      clueText.append(ans);
    }
  } else {
    clueText.textContent = "";
    meta.textContent =
      state.phase === "lobby"
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
  if (iBuzzed) {
    meta.textContent = "You buzzed first. Answer out loud.";
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
