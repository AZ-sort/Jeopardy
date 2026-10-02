import test from "node:test";
import assert from "node:assert/strict";
import { newDb } from "pg-mem";

import * as db from "../lib/db.js";

/**
 * Runs the real schema and the real queries against an in-memory Postgres.
 *
 * The SQL is the part most likely to be subtly wrong and the most painful to
 * debug on a deployed server, so it gets exercised here rather than first
 * meeting a database in production.
 */
async function freshDb() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await db.close().catch(() => {});
  const ok = await db.init({ pool });
  assert.equal(ok, true, "schema should be created");
  return pool;
}

test("the schema is created and a user can be stored", async () => {
  await freshDb();
  const user = await db.upsertUser({ sub: "g-1", email: "a@example.com", name: "Ann" });
  assert.ok(user.id > 0);
  assert.equal(user.email, "a@example.com");
});

test("signing in again returns the same account, not a duplicate", async () => {
  await freshDb();
  const first = await db.upsertUser({ sub: "g-1", email: "a@example.com", name: "Ann" });
  const second = await db.upsertUser({ sub: "g-1", email: "a@example.com", name: "Ann" });
  assert.equal(first.id, second.id);
});

test("a changed email on the Google account is picked up", async () => {
  await freshDb();
  const first = await db.upsertUser({ sub: "g-1", email: "old@example.com", name: "Ann" });
  const second = await db.upsertUser({ sub: "g-1", email: "new@example.com", name: "Ann" });
  assert.equal(first.id, second.id);
  assert.equal(second.email, "new@example.com");
});

test("two different Google accounts are two different users", async () => {
  await freshDb();
  const a = await db.upsertUser({ sub: "g-1", email: "a@example.com" });
  const b = await db.upsertUser({ sub: "g-2", email: "b@example.com" });
  assert.notEqual(a.id, b.id);
});

test("a board round-trips with its contents intact", async () => {
  await freshDb();
  const user = await db.upsertUser({ sub: "g-1" });
  const board = {
    categories: [
      { title: "Pokemon", clues: [{ value: 100, clue: "c", answer: "Pikachu", revealed: false, wager: null }] },
    ],
  };

  await db.saveBoard(user.id, "My Board", board);
  const back = await db.getBoard(user.id, "My Board");
  assert.deepEqual(back, board);
});

test("saving under the same name replaces rather than duplicating", async () => {
  await freshDb();
  const user = await db.upsertUser({ sub: "g-1" });

  await db.saveBoard(user.id, "Board", { categories: [{ title: "First", clues: [] }] });
  await db.saveBoard(user.id, "Board", { categories: [{ title: "Second", clues: [] }] });

  assert.deepEqual(await db.listBoards(user.id), ["Board"]);
  const back = await db.getBoard(user.id, "Board");
  assert.equal(back.categories[0].title, "Second");
});

test("two users may each have a board of the same name", async () => {
  await freshDb();
  const ann = await db.upsertUser({ sub: "g-1" });
  const bo = await db.upsertUser({ sub: "g-2" });

  await db.saveBoard(ann.id, "Movies", { categories: [{ title: "Ann's", clues: [] }] });
  await db.saveBoard(bo.id, "Movies", { categories: [{ title: "Bo's", clues: [] }] });

  assert.equal((await db.getBoard(ann.id, "Movies")).categories[0].title, "Ann's");
  assert.equal((await db.getBoard(bo.id, "Movies")).categories[0].title, "Bo's");
});

test("one user cannot read another user's board", async () => {
  await freshDb();
  const ann = await db.upsertUser({ sub: "g-1" });
  const bo = await db.upsertUser({ sub: "g-2" });

  await db.saveBoard(ann.id, "Secret", { categories: [{ title: "Answers", clues: [] }] });

  assert.equal(await db.getBoard(bo.id, "Secret"), null);
  assert.deepEqual(await db.listBoards(bo.id), []);
});

test("one user cannot delete another user's board", async () => {
  await freshDb();
  const ann = await db.upsertUser({ sub: "g-1" });
  const bo = await db.upsertUser({ sub: "g-2" });
  await db.saveBoard(ann.id, "Secret", { categories: [] });

  assert.equal(await db.deleteBoard(bo.id, "Secret"), false);
  assert.ok(await db.getBoard(ann.id, "Secret"), "the board must still be there");
});

test("deleting a board reports whether anything was removed", async () => {
  await freshDb();
  const user = await db.upsertUser({ sub: "g-1" });
  await db.saveBoard(user.id, "Board", { categories: [] });

  assert.equal(await db.deleteBoard(user.id, "Board"), true);
  assert.equal(await db.deleteBoard(user.id, "Board"), false);
  assert.deepEqual(await db.listBoards(user.id), []);
});

test("deleting an account takes its boards with it", async () => {
  await freshDb();
  const ann = await db.upsertUser({ sub: "g-1" });
  const bo = await db.upsertUser({ sub: "g-2" });
  await db.saveBoard(ann.id, "A", { categories: [] });
  await db.saveBoard(bo.id, "B", { categories: [] });

  await db.deleteUser(ann.id);

  assert.equal(await db.getUser(ann.id), null);
  assert.deepEqual(await db.listBoards(ann.id), [], "the cascade should have removed them");
  assert.deepEqual(await db.listBoards(bo.id), ["B"], "the other user is untouched");
});

test("boards come back in a stable order", async () => {
  await freshDb();
  const user = await db.upsertUser({ sub: "g-1" });
  for (const name of ["Zebra", "Apple", "Mango"]) {
    await db.saveBoard(user.id, name, { categories: [] });
  }
  assert.deepEqual(await db.listBoards(user.id), ["Apple", "Mango", "Zebra"]);
});
