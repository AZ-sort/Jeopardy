import { postJson, toast } from "./net.js";

const hostButton = document.getElementById("host");
const gate = document.getElementById("gate");
const passwordBox = document.getElementById("host-password");

/**
 * The password field only exists when the server is running with HOST_PASSWORD
 * set, which is how a publicly hosted copy stops strangers opening rooms and
 * spending the AI credit. On a laptop at home there is nothing to type.
 */
let passwordRequired = false;

try {
  const health = await (await fetch("/api/health")).json();
  passwordRequired = Boolean(health.hostPasswordRequired);
  gate.hidden = !passwordRequired;
  if (passwordRequired) passwordBox.value = sessionStorage.getItem("hostPassword") ?? "";
} catch {
  // If the check fails the server will reject a bad attempt anyway, and the
  // error from that is clearer than anything guessed here.
}

// Typing in the password must not count as clicking the tile behind it.
passwordBox?.addEventListener("click", (e) => e.stopPropagation());
passwordBox?.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") startHosting();
});

hostButton.addEventListener("click", startHosting);

async function startHosting() {
  const password = passwordRequired ? passwordBox.value.trim() : undefined;
  if (passwordRequired && !password) {
    passwordBox.focus();
    return toast("Enter the host password to start a game.");
  }

  hostButton.disabled = true;
  try {
    const room = await postJson("/api/rooms", password ? { password } : {});
    // The token is what proves this browser is the host. Keeping it per-code
    // means a refresh — or reopening the tab later — resumes the same game.
    localStorage.setItem("hostToken:" + room.code, room.hostToken);
    if (password) sessionStorage.setItem("hostPassword", password);
    location.href = "/host?code=" + room.code;
  } catch (err) {
    toast(err.message);
    hostButton.disabled = false;
    if (passwordRequired) passwordBox.focus();
  }
}
