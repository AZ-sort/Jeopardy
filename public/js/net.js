/**
 * The socket, plus the two bits of UI every page needs: toasts and an offline
 * banner.
 *
 * Reconnects on its own, because the realistic failure during a game night is a
 * phone sleeping in someone's pocket, not the server dying. On reconnect it
 * replays the same hello, so the server restores the player by id and their
 * score survives.
 */

const RECONNECT_MIN = 400;
const RECONNECT_MAX = 5000;

export function toast(message, kind = "error") {
  let tray = document.querySelector(".toasts");
  if (!tray) {
    tray = document.createElement("div");
    tray.className = "toasts";
    document.body.append(tray);
  }

  const el = document.createElement("div");
  el.className = "toast toast--" + kind;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = message;
  tray.append(el);

  setTimeout(() => el.remove(), kind === "error" ? 4200 : 2600);
}

function offlineBanner(show) {
  let el = document.querySelector(".offline");
  if (show && !el) {
    el = document.createElement("div");
    el.className = "offline";
    el.setAttribute("role", "status");
    el.textContent = "Reconnecting…";
    document.body.append(el);
  } else if (!show && el) {
    el.remove();
  }
}

/** Replaces the whole page with a dead end. Used when the room is gone. */
export function fatal(title, detail) {
  document.body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "fatal";
  const h = document.createElement("h1");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = detail ?? "";
  const back = document.createElement("a");
  back.className = "btn btn--quiet";
  back.href = "/";
  back.textContent = "Back to the start";
  back.style.justifySelf = "center";
  wrap.append(h, p, back);
  document.body.append(wrap);
}

/**
 * Opens the socket and keeps it open.
 *
 * @param {object} opts
 * @param {() => object} opts.hello  Builds the hello payload. A function rather
 *   than a value so a reconnect picks up the latest player id or name.
 * @param {(msg: object) => void} opts.onMessage
 * @returns {{send: (msg: object) => void, close: () => void}}
 */
export function connect({ hello, onMessage }) {
  let ws = null;
  let delay = RECONNECT_MIN;
  let closedByUs = false;
  let queue = [];

  function open() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws");

    ws.addEventListener("open", () => {
      delay = RECONNECT_MIN;
      offlineBanner(false);
      ws.send(JSON.stringify({ type: "hello", ...hello() }));
      for (const msg of queue) ws.send(JSON.stringify(msg));
      queue = [];
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "fatal") {
        closedByUs = true;
        fatal("That did not work", msg.message);
        return;
      }
      if (msg.type === "toast") {
        toast(msg.message, msg.kind ?? "error");
        return;
      }
      onMessage(msg);
    });

    ws.addEventListener("close", () => {
      if (closedByUs) return;
      offlineBanner(true);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX);
    });

    // An error is always followed by a close, which does the reconnecting.
    ws.addEventListener("error", () => {});
  }

  open();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else queue.push(msg);
    },
    close() {
      closedByUs = true;
      ws?.close();
    },
  };
}

/** Small helper: POST JSON and throw the server's own error message. */
export async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
  return data;
}
