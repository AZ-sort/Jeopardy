# Buzz Night

A Jeopardy-style party game. The board goes on a laptop or TV, your friends buzz
in from their phones, and you decide who got it right.

- **No app, no accounts.** Phones join a four-letter code in a browser.
- **You are the judge.** Answers are free-text and fuzzy, so a human ruling beats
  any string match. Correct awards the value, Wrong deducts it and lets the
  others buzz — like the real show.
- **Categories can be written or generated.** Type a theme like `Pokemon` and
  Claude writes five clues rising from $100 to $500, which you then edit before
  playing.

## What it looks like

| The board | A clue | A phone |
|---|---|---|
| ![The board](docs/board.png) | ![A clue on screen](docs/clue.png) | ![A phone with the buzzer live](docs/phone.png) |

## Running it

```bash
npm install
npm start
```

The console prints two addresses:

```
Host screen:  http://localhost:3000      <- you, on the laptop
Phones join:  http://192.168.1.38:3000   <- everyone else, same wifi
```

Open the host address, click **Host**, build a board, and read the join address
out to the room. Change the port with `PORT=4000 npm start`.

### Turning on AI categories

Set **one** API key and restart. Which provider gets used is worked out
automatically from the key you set — there is nothing to choose in the UI, and
the host screen names the model it is using.

The tidiest way is a `.env` file, which `npm start` picks up automatically and
which git ignores:

```bash
cp .env.example .env
# open .env, paste your key, save
npm start
```

Or pass it on the command line for one run:

```bash
OPENROUTER_API_KEY=sk-or-...  npm start          # macOS / Linux
```

```powershell
$env:OPENROUTER_API_KEY="sk-or-..."; npm start   # Windows PowerShell
```

Keep the key out of anything you share — chat windows and screenshots included.
If one leaks, rotate it at [openrouter.ai/keys](https://openrouter.ai/keys).

Without a key everything else still works — you just write the clues yourself.

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables Anthropic. Get one at [console.anthropic.com](https://console.anthropic.com) |
| `OPENROUTER_API_KEY` | — | Enables OpenRouter. Get one at [openrouter.ai/keys](https://openrouter.ai/keys) |
| `AI_PROVIDER` | auto | `anthropic` or `openrouter`. Only needed if both keys are set — Anthropic wins the tie otherwise |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | |
| `OPENROUTER_MODEL` | `google/gemini-3.8-flash` | Any id from [openrouter.ai/models](https://openrouter.ai/models) |
| `OPENROUTER_BASE_URL` | OpenRouter | Point at a proxy or gateway instead |

A category costs roughly a cent on Claude Opus, or about a fifth of that on the
default OpenRouter model.

**Picking an OpenRouter model.** Prefer one that supports structured outputs —
filter the [models page](https://openrouter.ai/models?supported_parameters=structured_outputs)
by that parameter. Models without it will usually still work, because every
response is validated and retried once regardless of provider, but they fail
more often. Cheap models also get trivia facts wrong noticeably more, which
matters more here than raw fluency.

**Check what it writes.** Generated clues land in an editable grid, not straight
onto the board, because models get trivia facts wrong often enough to spoil a
game. Reading them through takes a minute and is worth it.

## Playing

1. **Build the board.** Six categories, five clues each. Write them, generate
   them, or load one you saved. You can play with fewer than six — empty
   categories are dropped.
2. **Start the game** once people have joined. The board locks at this point.
3. **Pick a clue.** It fills the screen. Read it out loud.
4. **Open the buzzers** when you have finished reading. Until you do, every
   phone says *Wait* — this is what stops people mashing the button early.
5. **Rule on it.** Whoever buzzed first appears on screen. Correct adds the
   value; Wrong subtracts it, locks that player out of this clue, and re-opens
   the buzzers for everyone else.

Host keyboard shortcuts, since you will be looking at the room and not the
screen: `Space` opens the buzzers, `Y` correct, `N` wrong, `Esc` back to board.

### If you are casting to a TV

The clue screen deliberately never shows the answer — the **Peek at answer**
button puts it in small type down in the control bar instead, and **Show answer
to all** is what puts it on the big screen for everyone.

## Hosting it so your computer can stay off

Any host that runs a Node process works. It needs a real process, not a static
host — GitHub Pages and the like cannot run this, because the game is a server
holding live room state.

### Railway

The repo includes `railway.json`, so Railway needs no extra setup beyond the
environment variables.

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick it.
3. Under **Variables**, set:

   | Variable | Value |
   |---|---|
   | `OPENROUTER_API_KEY` | your key |
   | `HOST_PASSWORD` | anything you like — see below |
   | `BOARDS_DIR` | `/data/boards` (only if you add a volume) |

4. Under **Settings → Networking**, click **Generate Domain**. That URL is the
   game.

Railway sets `PORT` and `RAILWAY_PUBLIC_DOMAIN` itself; the server reads both.

**Set `HOST_PASSWORD`.** Without it, anyone who finds the URL can open a game
and spend your API credit. With it, starting a game asks for the password once —
players still need nothing but the four-letter room code.

**Add a volume if you want saved boards to survive.** A container filesystem is
wiped on every restart and redeploy. In Railway, add a volume mounted at `/data`
and set `BOARDS_DIR=/data/boards`. Without one, boards you save are gone the
next time the service restarts.

### Just for tonight

If you would rather not deploy, a tunnel gives your laptop a public URL without
touching the firewall or the router — but only while the laptop is on:

```bash
cloudflared tunnel --url http://localhost:3000
```

## How it is built

A single Node process serving static files and a WebSocket. No build step, no
framework, no database.

```
server.js            HTTP + WebSocket, room registry, message routing
lib/game.js          the rules as pure functions - phases, buzzing, scoring
lib/board.js         board shape and validation, shared by all three input paths
lib/generate.js      picks a provider, validates and retries the result
lib/ai/shared.js     the prompt, the schema, and the category conversion
lib/ai/anthropic.js  Anthropic adapter
lib/ai/openrouter.js OpenRouter adapter (plain fetch, no extra SDK)
public/              the three screens, as plain HTML/CSS/JS
test/game.test.js    unit tests for the rules
test/generate.test.js  generation, against a mock OpenRouter
scripts/smoke.mjs    end-to-end test against a running server
railway.json         deploy config for Railway
```

**Why one process and not serverless.** A room is shared mutable state with
exactly one correct buzz order. One always-on process is its own authority:
because Node handles messages on a single thread, "the first buzz message off
the socket wins" needs no locking or external coordination. Serverless functions
would need a separate real-time service to decide the same question.

**`lib/game.js` is pure on purpose.** Every rule that can be got subtly wrong —
lockouts, re-arming, who may buzz — is a plain function over a state object, so
it is tested without a browser, a phone, or a network.

### Tests

```bash
npm test     # rules, in isolation - no server needed
npm start    # in one terminal
npm run smoke  # in another: full game over real sockets
```

The smoke test fires simultaneous buzzes and asserts exactly one wins, that the
loser is told once, and that answers are never sent to a phone before the host
reveals them. `npm test` also runs the OpenRouter adapter against a mock
OpenRouter, covering the request shape and every failure branch without a key.

## Known limits

- **Rooms are in memory.** Restarting the server — or a redeploy — ends any game
  in progress. Saved boards persist as JSON under `boards/`, or under
  `BOARDS_DIR` when that is set.
- **Buzz fairness is arrival order.** Someone on worse wifi is at a real
  disadvantage of a few tens of milliseconds. Fine among friends in one room;
  worth knowing if people are remote.
- **Remote play needs a tunnel.** The LAN address only works on your wifi. For
  friends elsewhere, expose the port with something like
  `cloudflared tunnel --url http://localhost:3000` and share that address.
- **Not yet built:** Daily Doubles and wagering, Final Jeopardy, a Double
  Jeopardy round, timers, sound. The `wager` field already exists on every clue
  so Daily Doubles will not need a data migration.
- **Fonts come from Google Fonts.** Playing fully offline falls back to system
  faces, which looks plainer but works.
- **Schema compliance varies by model.** OpenRouter routes a model through
  whichever upstream provider is available and not all of them enforce a JSON
  schema, so every response is validated here and retried once. A model that
  fails twice reports itself rather than producing a broken category.

## Renaming it

"Buzz Night" appears in the three `public/*.html` titles, the landing page
heading, and this file. Nothing depends on the name.
