# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Buzz Night** — a Jeopardy-style party game. The board goes on a laptop or TV,
players buzz in from their phones over a four-letter room code, and the host
rules on free-text answers. `README.md` is the user-facing documentation and is
kept current; read it before changing behaviour, and update it when behaviour
changes.

## This folder is a deliberate exception to the vault's rules

This repo lives inside an Obsidian vault (`C:\Users\maaza\BRAIN`) whose root
`CLAUDE.md` says the vault is notes, not software, and that no build or test
tooling should be added. That rule holds everywhere *except here*. This folder
was placed in the vault on purpose. Treat it as a normal software project; treat
everything outside it as notes.

It is also its own git repo (`AZ-sort/Jeopardy`, **public**) — the vault around
it is not version-controlled. Nothing here should contain secrets or anything
private to the vault.

## Architecture

One Node process serving static files and a WebSocket. No build step, no
framework, no bundler. The file map is in the README's "How it is built"
section — consult it rather than re-deriving the layout.

Two things worth knowing before changing anything:

- **`lib/game.js` is pure on purpose.** Every rule that can be got subtly wrong
  — lockouts, re-arming, who may buzz, scoring — is a plain function over a
  state object, so it is tested without a browser, phone or network. Keep new
  rules there and keep them pure.
- **It is one process, not serverless, by design.** A room is shared mutable
  state with exactly one correct buzz order; Node's single thread *is* the
  authority, so "first buzz off the socket wins" needs no locking. Do not
  propose moving to serverless functions without replacing that guarantee.

## AI generation goes through OpenRouter, not Anthropic

Clue generation defaults to **OpenRouter** here. There is no Anthropic API key
for this project, and a Claude Code subscription does not provide one — do not
assume one exists or suggest the Anthropic path as the default.

The provider is chosen automatically from whichever key is present
(`lib/generate.js`); the Anthropic adapter exists and is tested, it just isn't
what this deployment uses. Every response is schema-validated and retried once,
because models get trivia facts wrong often enough to spoil a game — generated
clues land in an editable grid, never straight onto the board.

## Commands

```bash
npm test          # rules, generation, db, auth — no server, no API key needed
npm start         # http://localhost:3000, reads .env if present
npm run smoke     # full game over real sockets, against a running server
```

`npm test` should be 79 passing at time of writing. The smoke test fires
simultaneous buzzes and asserts exactly one wins, and that answers never reach
a phone before the host reveals them.

Node >= 20 (uses `--env-file-if-exists`).

## Deployment

Railway, from `main`, at `jeopardy-production-dc41.up.railway.app`
(`railway.json`, healthcheck `/api/health`). Postgres and Google OAuth are
configured there, so saved boards and sign-in work in production.

**Rooms are held in memory** — any deploy ends a game in progress. Don't ship
during a party. Saved boards are in Postgres and survive.

## Working style

Same as the other projects in this vault:

- **Branch, commit, push, open a PR with a test plan — then stop.** The repo
  owner merges to `main` themselves, including under broad auto-mode
  permissions. Never merge, force-push, or push straight to `main`.
- **Verify against the live Railway deployment before calling anything done.**
  Static and local checks have missed real breakage on sibling projects;
  production is play-tested by hand after a change ships.

## A board is rounds, not categories

`{ rounds: [...], final, options: { doubleRound, finalRound } }`. `rounds[0]`
runs 100–500; `rounds[1]` exists only when `doubleRound` is on and runs
200–1000. `game.board` still means "the board being played right now", so every
rule that reads it was left alone; `game.rounds` and `game.roundIndex` are what
move between them.

Three things to know:

- **There is no conversion of old `{categories}` boards**, deliberately. There
  were none saved and the host UI has no import path. `validateBoard` refuses a
  board with no `rounds` array rather than mangling it.
- **`validateBoard` only inspects rounds that will be played** (`playedRounds`).
  An untouched round 2 behind an off toggle must never block *Start the game* —
  there is a test for exactly that.
- **A round holds 1 to `MAX_CATEGORIES` columns.** The host adds and removes
  them; blank ones are still dropped underneath as a safety net.

`public/js/host.js` keeps its own copies of `ROUND_VALUES` and
`MAX_CATEGORIES`, because the browser cannot import `lib/board.js` — it pulls
in zod and there is no build step. Change one, change both; the smoke test
asserts round 2's values over the wire.

## The Daily Double

`DAILY_DOUBLES_PER_ROUND` — one in round 1, two in round 2 — placed at random
by `startGame` and `startNextRound`, which take an injectable `random` so tests
can pin them to known squares. Placement prefers one per category and falls
back to any free square when a round is too short. Opening it enters `PHASE.WAGER`:
the host names who found it, that player bets from their phone in hundreds, and
locking the bet sets `buzzedPlayer` so the ordinary `judge()` path scores it via
`clue.wager ?? clue.value`. The only special case is that a wrong answer closes
the clue instead of re-arming the buzzers.

Two things here are load-bearing and easy to undo by accident:

- **The clue text is withheld from players during `PHASE.WAGER`.** Betting with
  the question visible is not a Daily Double.
- **The board payload never carries `dailyDouble`.** It is host-only until the
  square is opened, or a player could read its location off the socket.

The wager ceiling comes from the board's own highest value, not a hardcoded
500, so a second 200–1000 board will work without touching it.

## Not built yet

Final Jeopardy, sound, and any timer outside Final Jeopardy's answer window.
The `final` field and the `finalRound` toggle already exist in the board shape
and the setup screen shows the checkbox disabled, so PR 2 adds behaviour rather
than changing the shape again. The design for it is in
`docs/specs/2026-10-03-rounds-and-final-jeopardy-design.md`.
