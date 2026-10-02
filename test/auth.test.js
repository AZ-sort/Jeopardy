import test from "node:test";
import assert from "node:assert/strict";

/**
 * The session cookie is the whole of the authorization story for saved boards:
 * if it can be forged or tampered with, one person reads another's answers. So
 * it gets tested directly, without needing Google.
 */
process.env.SESSION_SECRET = "test-secret-for-signing";
const auth = await import("../lib/auth.js");

/** Captures what setSession writes, so it can be fed back to currentUserId. */
function fakeRes() {
  const cookies = {};
  return {
    cookies,
    cookie: (name, value) => {
      cookies[name] = value;
    },
    clearCookie: (name) => {
      delete cookies[name];
    },
  };
}

const fakeReq = (cookies = {}) => ({ cookies, protocol: "https", get: () => "example.test" });

function issueCookieFor(userId) {
  const res = fakeRes();
  auth.setSession(fakeReq(), res, userId);
  return res.cookies.session;
}

test("a session cookie round-trips to the same user", () => {
  const cookie = issueCookieFor(42);
  assert.equal(auth.currentUserId(fakeReq({ session: cookie })), 42);
});

test("no cookie means nobody is signed in", () => {
  assert.equal(auth.currentUserId(fakeReq()), null);
  assert.equal(auth.currentUserId({ cookies: undefined }), null);
});

test("changing the user id invalidates the signature", () => {
  const cookie = issueCookieFor(42);
  const signature = cookie.slice(cookie.lastIndexOf(".") + 1);

  // The obvious attack: claim to be user 1 while reusing a valid signature.
  assert.equal(auth.currentUserId(fakeReq({ session: "1." + signature })), null);
  assert.equal(auth.currentUserId(fakeReq({ session: "43." + signature })), null);
});

test("a made-up signature is refused", () => {
  assert.equal(auth.currentUserId(fakeReq({ session: "42.not-a-real-signature" })), null);
  assert.equal(auth.currentUserId(fakeReq({ session: "42." })), null);
  assert.equal(auth.currentUserId(fakeReq({ session: "42" })), null);
});

test("a cookie signed with a different secret is refused", async () => {
  const cookie = issueCookieFor(42);

  // Re-import under a different secret, as a second deployment would have.
  process.env.SESSION_SECRET = "a-completely-different-secret";
  const other = await import("../lib/auth.js?v=2");
  assert.equal(other.currentUserId(fakeReq({ session: cookie })), null);

  process.env.SESSION_SECRET = "test-secret-for-signing";
});

test("junk never throws, it just means signed out", () => {
  for (const junk of ["", ".", "..", "abc", "abc.def", "-1.x", "0.x", "999999999999999999999.x"]) {
    assert.equal(auth.currentUserId(fakeReq({ session: junk })), null, junk);
  }
});

test("a non-numeric or non-positive id is refused even when correctly signed", () => {
  // Signing is only half the check; the payload must still be a real user id.
  assert.equal(auth.currentUserId(fakeReq({ session: issueCookieFor(0) })), null);
  assert.equal(auth.currentUserId(fakeReq({ session: issueCookieFor(-5) })), null);
});

test("the session cookie is not readable by scripts and is same-site", () => {
  const captured = [];
  const res = {
    cookie: (name, value, opts) => captured.push({ name, opts }),
    clearCookie: () => {},
  };
  auth.setSession(fakeReq(), res, 7);

  const { opts } = captured[0];
  assert.equal(opts.httpOnly, true, "a script must not be able to read the session");
  assert.equal(opts.sameSite, "lax", "this is what blocks cross-site requests riding the cookie");
  assert.equal(opts.secure, true, "over https the cookie must not be sent in the clear");
});

test("sign-in is reported as unconfigured without Google credentials", () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.equal(auth.isConfigured(), false);

  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  assert.equal(auth.isConfigured(), true);
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

test("the callback url follows the public domain when deployed", () => {
  process.env.RAILWAY_PUBLIC_DOMAIN = "buzz.up.railway.app";
  assert.equal(
    auth.callbackUrl(fakeReq()),
    "https://buzz.up.railway.app/auth/google/callback",
  );
  delete process.env.RAILWAY_PUBLIC_DOMAIN;

  // Locally it falls back to whatever host the request arrived on.
  assert.equal(auth.callbackUrl(fakeReq()), "https://example.test/auth/google/callback");
});
