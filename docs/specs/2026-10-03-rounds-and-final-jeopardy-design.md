# Two rounds and Final Jeopardy

Design, 2026-10-03. Status: approved, not yet implemented.

## Why

Buzz Night plays one board and then stops. The board empties, the phase flips
to `done`, and the phones read "That is the whole board." There is no second
half and no ending.

This adds both, as two toggles the host sets while building the board:

- **Second round** — another full board at 200–1000, with two Daily Doubles
  instead of one.
- **Final Jeopardy** — one clue, everyone bets in secret, everyone types an
  answer, and the answers are revealed one at a time.

Both default off. With both off the game is exactly what it is today, which is
the bar every part of this has to clear.

Everything is authored during setup, before the game starts. Nobody stops
mid-game to type a clue — the only mid-game decision is pressing *Start round
2*.

## The shape of a board

Today a board is `{ categories: [...] }` and that is also what sits in
Postgres. It becomes:

```js
{
  rounds: [ { categories: [...] }, { categories: [...] }? ],
  final: { category: string, clue: string, answer: string } | null,
  options: { doubleRound: boolean, finalRound: boolean },
}
```

`rounds[0]` is the 100–500 board. `rounds[1]` exists only when
`options.doubleRound` is on, and carries values 200–1000. `final` is populated
only when `options.finalRound` is on.

### Upgrading what is already saved

Boards live in a JSONB column (`boards.data`, `lib/db.js`), so there is **no SQL
migration**. But every board already saved is the bare old shape, and so is
every board someone pasted in or exported. One function handles it:

```js
upgradeBoard(input) // {categories} -> {rounds:[{categories}], final:null, options:{off,off}}
```

It runs on every board read — from Postgres, from the saved-board API, and on
a draft restored into a room. A board already in the new shape passes through
untouched.

This is the riskiest single piece of the change: get it wrong and the host's
saved boards stop loading. It gets its own tests, including a real round-trip
through the Postgres-backed `db` test suite, and the rule is that an old board
must still play start to finish with both toggles off.

## Authoring

Two checkboxes in the setup screen, both off by default.

**Second round** reveals a second six-category grid, identical to the first but
labelled 200–1000. **Final Jeopardy** reveals a single category / clue / answer
trio.

`validateBoard` only inspects a section whose toggle is on. An untouched round
2 must never block *Start the game* — that is the most likely way this feature
annoys someone, so it is a test, not a note.

"Fill with AI" works per category exactly as it does now; round 2 categories
are no different. `collectAnswers` must gather from every round and from the
Final Jeopardy answer, so generation does not repeat an answer across rounds —
today it only walks one board.

`CLUE_VALUES` for round 2 is `[200, 400, 600, 800, 1000]`. Round 1 keeps
`[100, 200, 300, 400, 500]`.

## Playing a second round

`game` gains `rounds`, `roundIndex`, and `options`; `game.board` keeps meaning
"the board being played right now", so every existing rule that reads
`game.board` is untouched.

When the last clue of a board closes, the phase becomes **`ROUND_END`** if
anything is still to come, and `DONE` if nothing is — exactly as today when
both toggles are off. `ROUND_END` is a scoreboard and a single button, whose
label depends on what is left:

| Just finished | Still to come | Button |
|---|---|---|
| Round 1 | round 2 | **Start round 2** |
| Round 1 | final only | **Start Final Jeopardy** |
| Round 1 | nothing | *(no `ROUND_END`; straight to `DONE`)* |
| Round 2 | final | **Start Final Jeopardy** |
| Round 2 | nothing | *(no `ROUND_END`; straight to `DONE`)* |

So a host who enables Final Jeopardy but not round 2 gets a perfectly ordinary
one-board game with a finish, and never sees a mention of a second round.

**Start round 2** loads `rounds[1]` into `game.board`, sets `roundIndex` to 1,
and hides **two** Daily Doubles rather than one.

`placeDailyDouble` grows a count parameter. The two in round 2 must land on
different squares, and on different categories where that is possible — the
real show never puts both in one column.

Wagering needs no change at all: the ceiling already derives from the board's
own highest value, so round 2 bets reach $1000 on their own.

## Final Jeopardy

Four phases, in order. `PHASE` values stay lowercase strings as they are
today: `"round-end"`, `"final-wager"`, `"final-clue"`, `"final-reveal"`.

### 1. `FINAL_WAGER`

Every player gets the pad. The range is **$0 up to their own score**, in
hundreds. A player at or below zero sees a locked $0 — they are still in the
round, they simply cannot bet anything.

Note this deliberately differs from a Daily Double, which has a floor of $100
and a ceiling of `max(score, board high)`. Final Jeopardy is the classic rule:
you can bet nothing, and you can never bet more than you hold.

**The clue is withheld from every phone until the last bet is in.** Same rule
as a Daily Double and the same reason.

### 2. `FINAL_CLUE`

The clue appears. Every player types an answer on their phone and submits it.
This is the first text players have ever sent — until now phones could only
buzz and wager — so the input is length-capped and trimmed server-side like
every other player-supplied string.

A player who submits nothing is treated as having answered blank. The host can
move on without waiting for everyone; stragglers are not allowed to hold up
the room.

### 3. `FINAL_REVEAL`

Ordered **poorest first**. The host steps through one player at a time. The
screen shows that player's answer and what they bet.

### 4. Ruling

Correct or Wrong per player, moving their score by **their own bet**. Once the
last player is ruled on, the phase becomes `DONE`.

### Final Jeopardy state

```js
game.final = {
  wagers:  { [playerId]: number },
  answers: { [playerId]: string },
  order:   [playerId],   // poorest first, fixed when FINAL_REVEAL begins
  revealIndex: number,
  judged:  { [playerId]: boolean },
}
```

## What must not leak

The Daily Double established the pattern and Final Jeopardy depends on it far
more heavily. `publicState` must enforce, for players:

| Thing | Hidden until |
|---|---|
| Final clue text | every bet is locked |
| Another player's wager | that player is revealed |
| Another player's answer | that player is revealed |
| Round 2's Daily Double squares | the square is opened |

A player sees their own wager and their own answer at all times, and nobody
else's. These are withheld from the payload, never merely hidden in the UI —
the phones are untrusted. Each row above is a test that asserts the value is
absent from a serialized player view, in the style of the existing "the player
view never includes clue answers".

## Testing

`lib/game.js` stays pure, so the rules go in `test/game.test.js` as usual:
round transition and its gating on the toggles, two non-overlapping Daily
Doubles in round 2, the $0-to-score wager range, blank answers, reveal order by
score, and scoring by each player's own bet.

`upgradeBoard` gets its own tests plus a Postgres round-trip in
`test/db.test.js`.

The smoke test gains a full two-round game with a Final Jeopardy finish, driven
over real sockets, asserting the secrecy table above from a player socket
rather than from the game object.

Browser play-through on the Railway deployment before either PR is called done,
per `CLAUDE.md`.

## Shipping it

**Two PRs, not one.**

1. **The board shape and round 2** — the wrapper, `upgradeBoard`, the setup
   toggles, `ROUND_END`, and two Daily Doubles in the second board. Playable
   and worth a game night on its own.
2. **Final Jeopardy** — the four phases, typed answers, and the reveal.

They share only the wrapper shape. Splitting them means a two-board night can
be play-tested in a real room before the typed-answer machinery exists, and
either can be backed out without the other.

## Not in scope

Timers, sound, a third round, and per-round category counts other than six.
