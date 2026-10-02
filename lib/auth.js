/**
 * Google sign-in, and the session cookie that follows from it.
 *
 * Signing in is optional everywhere: it unlocks saving boards and nothing else.
 * Hosting, playing and generating categories all work signed out, so nobody has
 * to hand over an identity to play a party game.
 *
 * No password is ever stored — that is the main reason to use Google here
 * rather than roll our own login.
 *
 * The session is a stateless signed cookie rather than a server-side table, so
 * a redeploy does not sign everybody out.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const SESSION_COOKIE = "session";
const STATE_COOKIE = "oauth_state";
const SESSION_DAYS = 30;

export function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * Secret for signing session cookies.
 *
 * A generated fallback keeps local development working, at the cost of signing
 * everyone out on restart — which is why a deployment must set its own.
 */
let fallbackSecret = null;
function sessionSecret() {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured) return configured;
  if (!fallbackSecret) {
    fallbackSecret = randomBytes(32).toString("hex");
    if (isConfigured()) {
      console.warn(
        "SESSION_SECRET is not set: using a random one, so everyone is signed out on restart.",
      );
    }
  }
  return fallbackSecret;
}

/** The address Google will send the browser back to. */
export function callbackUrl(req) {
  const configured = process.env.OAUTH_REDIRECT_URL?.trim();
  if (configured) return configured;

  const domain =
    process.env.PUBLIC_DOMAIN?.trim() || process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (domain) return `https://${domain}/auth/google/callback`;

  const proto = req.protocol === "https" ? "https" : "http";
  return `${proto}://${req.get("host")}/auth/google/callback`;
}

// ------------------------------------------------------------------ cookies

function sign(value) {
  return createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function serialize(userId) {
  const payload = String(userId);
  return `${payload}.${sign(payload)}`;
}

/** @returns {number|null} the user id, or null if absent or tampered with. */
function verify(cookie) {
  if (!cookie) return null;
  const cut = cookie.lastIndexOf(".");
  if (cut < 1) return null;

  const payload = cookie.slice(0, cut);
  const given = Buffer.from(cookie.slice(cut + 1), "utf8");
  const wanted = Buffer.from(sign(payload), "utf8");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

  const id = Number(payload);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    // Lax is what stops a cross-site POST riding this cookie, which is the
    // reason these routes need no separate CSRF token.
    sameSite: "lax",
    secure: req.protocol === "https" || Boolean(process.env.RAILWAY_PUBLIC_DOMAIN),
    path: "/",
  };
}

export function setSession(req, res, userId) {
  res.cookie(SESSION_COOKIE, serialize(userId), {
    ...cookieOptions(req),
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearSession(req, res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
}

/** The signed-in user's id, or null. */
export function currentUserId(req) {
  return verify(req.cookies?.[SESSION_COOKIE]);
}

// ------------------------------------------------------------------ the flow

/** Step one: send the browser to Google, remembering a state to check later. */
export function beginLogin(req, res) {
  const state = randomBytes(16).toString("base64url");
  res.cookie(STATE_COOKIE, state, { ...cookieOptions(req), maxAge: 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(req),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  res.redirect(`${AUTH_URL}?${params}`);
}

/**
 * Step two: verify the state, trade the code for a token, and read the profile.
 *
 * The profile is fetched straight from Google over TLS rather than decoded from
 * the returned ID token, which avoids hand-rolling JWT signature verification
 * for no benefit — we already trust this connection.
 *
 * @returns {Promise<{sub: string, email?: string, name?: string}>}
 */
export async function completeLogin(req, res) {
  const returned = String(req.query.state ?? "");
  const expected = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, cookieOptions(req));

  if (!returned || !expected || returned !== expected) {
    throw new Error("Sign-in could not be verified. Please try again.");
  }
  if (req.query.error) {
    throw new Error("Sign-in was cancelled.");
  }

  const code = String(req.query.code ?? "");
  if (!code) throw new Error("Google did not return a sign-in code.");

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(req),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => "");
    console.error("google token exchange failed:", tokenRes.status, detail.slice(0, 300));
    throw new Error("Google would not complete the sign-in.");
  }

  const { access_token: accessToken } = await tokenRes.json();
  if (!accessToken) throw new Error("Google did not return an access token.");

  const profileRes = await fetch(USERINFO_URL, {
    headers: { Authorization: "Bearer " + accessToken },
    signal: AbortSignal.timeout(15_000),
  });
  if (!profileRes.ok) throw new Error("Could not read your Google profile.");

  const profile = await profileRes.json();
  if (!profile.sub) throw new Error("Google profile was missing an account id.");

  return { sub: profile.sub, email: profile.email, name: profile.name };
}
