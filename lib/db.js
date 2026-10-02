/**
 * Postgres: users and their saved boards.
 *
 * The whole module is optional. With no DATABASE_URL the app runs exactly as it
 * did before — you can host, play and generate categories — you just cannot
 * save a board. That keeps local development free of a database and means a
 * misconfigured deployment degrades instead of failing to boot.
 */

import pg from "pg";

let pool = null;
let ready = false;

export function isConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

/** True once the schema exists and queries can be served. */
export function isReady() {
  return ready;
}

/**
 * How to treat TLS for a given connection string.
 *
 * Verification is never turned off silently. A private network address needs no
 * TLS at all; anything else must verify. Railway's public database proxy
 * presents a certificate this client has no root for, which is the one case
 * that needs DATABASE_SSL_INSECURE — and the fix is to use the internal
 * connection string instead, which this prefers.
 */
function sslSetting(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* fall through to the verifying default */
  }

  const isPrivate =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".railway.internal") ||
    host.endsWith(".internal");
  if (isPrivate) return false;

  if (process.env.DATABASE_SSL_INSECURE === "1") {
    console.warn(
      "DATABASE_SSL_INSECURE is set: the database certificate is not being verified.\n" +
        "  Prefer Railway's internal DATABASE_URL (postgres.railway.internal), which needs no TLS.",
    );
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: true };
}

/**
 * Creates the pool and the schema. Safe to call once at startup; failures are
 * reported and swallowed, leaving the app running without saved boards.
 */
export async function init({ pool: injected } = {}) {
  // An injected pool is how the tests run the real schema and queries against
  // an in-memory Postgres; everything below this line is identical either way.
  if (!injected && !isConfigured()) return false;

  pool =
    injected ??
    new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslSetting(process.env.DATABASE_URL),
      max: 5,
    });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        google_sub  TEXT UNIQUE NOT NULL,
        email       TEXT,
        name        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS boards (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, name)
      );
    `);
    ready = true;
    return true;
  } catch (err) {
    console.error("database setup failed, saved boards are disabled:", err.message);
    ready = false;
    return false;
  }
}

/** Finds or creates the user behind a Google profile. */
export async function upsertUser({ sub, email, name }) {
  const { rows } = await pool.query(
    `INSERT INTO users (google_sub, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
     RETURNING id, email, name`,
    [sub, email ?? null, name ?? null],
  );
  return rows[0];
}

export async function getUser(id) {
  const { rows } = await pool.query("SELECT id, email, name FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listBoards(userId) {
  const { rows } = await pool.query(
    "SELECT name FROM boards WHERE user_id = $1 ORDER BY name",
    [userId],
  );
  return rows.map((r) => r.name);
}

export async function getBoard(userId, name) {
  const { rows } = await pool.query(
    "SELECT data FROM boards WHERE user_id = $1 AND name = $2",
    [userId, name],
  );
  return rows[0]?.data ?? null;
}

/** Saves under a name, replacing whatever that name held before. */
export async function saveBoard(userId, name, data) {
  await pool.query(
    `INSERT INTO boards (user_id, name, data)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [userId, name, JSON.stringify(data)],
  );
}

export async function deleteBoard(userId, name) {
  const { rowCount } = await pool.query(
    "DELETE FROM boards WHERE user_id = $1 AND name = $2",
    [userId, name],
  );
  return rowCount > 0;
}

/** Removes the account and, by cascade, every board it owns. */
export async function deleteUser(userId) {
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
}

export async function close() {
  await pool?.end();
  pool = null;
  ready = false;
}
