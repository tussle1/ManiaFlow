# ManiaFlow

A local practice, chart-analysis and timing tool for [Ashtonk!mania](https://ashtonkmania.vercel.app/).

ManiaFlow is a standalone web app that runs on your own machine. It reads osu! `.osu` / `.osz`
charts, previews them on a canvas with the game's own scroll maths, analyses their timing, records
what you do in it, and — only inside the game's own **practice mode** — drives the game's lanes
through a raw keyboard-input path.

It is built for local testing, personal practice, accessibility and chart analysis. It is **not** a
score tool: it computes no scores, no pp, no ranks and no grades, and it fabricates none.

![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen) ![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) ![Tests](https://img.shields.io/badge/tests-238%20passing-brightgreen) ![License](https://img.shields.io/badge/license-UNLICENSED-lightgrey)

> The badges above describe this checkout as committed. There is no CI; the numbers come from
> running `npm test` and `npm run check` locally.

---

## Contents

- [What ManiaFlow is, and what it is not](#what-maniaflow-is-and-what-it-is-not)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [The seven screens](#the-seven-screens)
- [Connecting to Ashtonk!mania](#connecting-to-ashtonkmania)
- [The raw keyboard-input system](#the-raw-keyboard-input-system)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Project layout](#project-layout)
- [Tests and the startup check](#tests-and-the-startup-check)
- [Example charts](#example-charts)
- [Limitations, stated plainly](#limitations-stated-plainly)
- [Responsible use](#responsible-use)
- [Configuration reference](#configuration-reference)
- [License](#license)

---

## What ManiaFlow is, and what it is not

**It is**

- a chart reader whose output is verified to match Ashtonk!mania's own parser note-for-note;
- a preview player with lanes, a scroll-accurate canvas, a scrubbable timeline, speed, loops and offsets;
- a timing analyser for intervals, jacks, density, chords, holds, BPM/SV changes and beat snap;
- a session recorder and statistics page that only ever reports data it actually collected;
- an input laboratory with two honest backends and a safety gate;
- a dark, keyboard-first interface with no browser `alert()`s anywhere.

**It is not**

- **not** a way to play ranked or multiplayer automatically. Input is refused unless the game itself
  reports `practice === true`, and practice sessions are never submitted for score verification.
- **not** a scoring or ranking service. No score, grade, pp or leaderboard figure is produced or invented.
- **not** a claim that synthetic events are hardware events. Every dispatched `KeyboardEvent` has
  `isTrusted === false`, and the UI says so wherever input runs.
- **not** a bypass of the game's anti-cheat. ManiaFlow reads the game's verification thresholds,
  respects them, and never enables the `AT` (Auto) mod or calls the game's `generateAutoInputs`.

---

## Requirements

- **Node.js 20.11 or newer.** Developed and tested on Node 22.
- **No npm dependencies.** `node_modules` is never created; there is nothing to install beyond cloning.
- A browser with ES module and canvas support.
- Optional, for the OS-level input backend only: one of `xdotool` (Linux/X11), `ydotool`
  (Linux/Wayland), `cliclick` (macOS), or PowerShell (Windows).

```bash
git clone https://github.com/tussle1/ManiaFlow.git
cd ManiaFlow
npm start
```

---

## Quick start

```bash
npm start          # serves http://127.0.0.1:4310
```

Startup output looks like this:

```
ManiaFlow  →  http://127.0.0.1:4310
WebSocket bridge endpoint  →  ws://127.0.0.1:4310/ws
Bridge script (token filled in)  →  http://127.0.0.1:4310/bridge/installed.js
OS input on this machine: linux — run detect from Settings → Integration
```

Open the URL, then **Dashboard → "Load example charts"** to get three real charts into the library
without importing anything. Everything else works offline; the game connection is optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4310` | Port to listen on. |
| `HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` to expose it on your network — the bridge token then matters. |
| `MANIAFLOW_TOKEN` | generated | Bridge token. Otherwise one is generated once and stored in `.maniaflow/token` with mode `0600`. |

`.maniaflow/` is gitignored. Stop the server with `Ctrl+C`; it closes the WebSocket hub and releases
every armed key before exiting.

---

## The seven screens

Reachable from the sidebar, from `Alt`+`1`…`Alt`+`7`, or by hash (`#/library`, `#/practice`, …).

| Screen | Route | What it does |
| --- | --- | --- |
| **Dashboard** | `/` | Integration state at a glance, a 14-day session sparkline, recently opened charts, and links to every tool. States plainly what ManiaFlow is not. |
| **Chart Library** | `/library` | Search, sort and filter charts; import `.osu`/`.osz` by picker or drag-and-drop; recents; per-chart metadata; explicit loading, empty and error states. |
| **Practice Studio** | `/practice` | Canvas preview with lanes, receptors, bar lines, beat-snap colours and simultaneous-note highlighting; transport with play/pause/stop; scrub timeline; speed 0.25×–2×; A/B loop; timing offset. Clearly labelled as a **preview**, never as gameplay. |
| **Timing Lab** | `/timing` | Note-interval distribution, jacks, peak density, simultaneous notes, hold lengths, timing/scroll-velocity segments, and osu! beat-snap colours. Includes a timing-profile simulator with a **reproducible seed**. |
| **Input Lab** | `/input` | The safety gate, backend selection and detection, lane→key mapping, a live key monitor, a test-key screen, run controls, and every input error in words. |
| **Statistics** | `/statistics` | Sessions per day, time recorded, speed and timing summaries, per-chart breakdown, failure breakdown, session detail, and JSON export. Only genuinely collected data; a "Nothing recorded yet" state instead of invented numbers. |
| **Settings** | `/settings` | Appearance, Practice, Timing, Simulation, Integration, Input, Performance and Data. Every value is validated against a schema, persisted, and recoverable if storage is corrupt. |

---

## Connecting to Ashtonk!mania

Ashtonk!mania exposes exactly one integration surface: a `window.AshtonkMania` global. It has no
HTTP API, no `postMessage` protocol and no plugin registry. Because the game is served from
`ashtonkmania.vercel.app` and ManiaFlow from `127.0.0.1`, that global cannot be reached across the
origin boundary — so connection requires a small userscript you install yourself.

**Install the bridge**

1. Start ManiaFlow (`npm start`) and open **Settings → Integration**.
2. Copy the script, or open `http://127.0.0.1:4310/bridge/installed.js` — that copy already has this
   machine's token and WebSocket URL substituted in.
3. Paste it into Tampermonkey or Violentmonkey as a new script (or into the game page's DevTools
   console for a one-off session).
4. Load `https://ashtonkmania.vercel.app/`. The sidebar's connection indicator turns live.

**What the bridge relays**

| Request | Returns |
| --- | --- |
| `state` | Current screen, loaded chart id/mode/keys, running, practice flag, clock, input latency, rate, mods, `s.windows`. |
| `library` | The game's own library records (`_mapRecord` shape), read-only. |
| `chart` | A chart's note data as the game parsed it. |
| `keybinds` | The game's real `Settings.keybinds` for a lane count — `KeyboardEvent.code` values, up to two per column. |
| `gate` | Whether input is currently permitted, with the blocking reason in words. |
| `practice.seek` / `.speed` / `.loop` / `.restart` | The game's own practice-mode APIs. |
| `releaseAll` | Release every held key immediately. |

The bridge is read-only except for the practice APIs and the input path. It never writes to the
game's settings, library or score data.

**The token** exists so that another page open in your browser cannot pose as a bridge or read your
chart data. Non-`GET` requests to `/api/*` and `/bridge/installed.js` are rejected with `405`.

---

## The raw keyboard-input system

ManiaFlow deliberately does **not** use the game's built-in autoplay. The `AT` mod sets
`s.auto = true`, `s.mode = 'auto'` and `s.feed = generateAutoInputs(...)`; ManiaFlow never touches
any of those. Instead it splits the problem in three, exactly as the design intends:

| Concern | Owner |
| --- | --- |
| **Which lane** a note is in | `src/chart/ChartParser.js` (+ `ConvertMath.js` for lazer conversion maths) |
| **When** a key should fire | `src/playback/TimingEngine.js` and `src/input/InputScheduler.js` |
| **How** the key physically arrives | `src/input/KeyboardAdapter.js` and `server/osInput.js` |

### Two backends

**1. Synthetic (bridge) backend — `SyntheticBridgeBackend`**

The bridge dispatches real `KeyboardEvent` objects on `window` with the correct `code`, in the
capture phase, which is where the game listens and how it resolves `s.keyMap.get(e.code)`.

These events have **`isTrusted === false`**. The game accepts them because it never checks
`isTrusted`. They are *not* hardware input, they are trivially distinguishable from it, and
ManiaFlow labels them as synthetic in the Input Lab, in the status area and in every session
record. Nothing here claims otherwise.

**2. OS-level backend — `OsInputBackend`**

Sends keystrokes through the operating system, so they arrive as genuine input events:

| Platform | Helper | Model | Notes |
| --- | --- | --- | --- |
| Linux / X11 | `xdotool` | one persistent process; commands piped to `xdotool -` | Needs `DISPLAY` and a focused browser window. |
| Linux / Wayland | `ydotool` | one process per event | Needs `/dev/uinput` access and a running `ydotoold`. Adds several ms of latency per key. |
| macOS | `cliclick` | one process per event | — |
| Windows | PowerShell + `user32!SendInput` | one persistent PowerShell process | Browser window must be focused. |

Detection is honest. `detect()` reports `installed` and `available` separately, with a `reason`
string when a helper is present but unusable (for example: *"Installed, but this process has no
DISPLAY — xdotool needs an X11 session"*). Arming proves readiness with a handshake — `xdotool` is
primed with `getmouselocation` and the code waits for its `x:` reply — rather than assuming that
`spawn()` succeeded, because `spawn()` does not fail synchronously on `ENOENT`.

### Timing correctness

The scheduler runs on a **monotonic clock** (`process.hrtime.bigint()`), never on `Date.now()`, so
it cannot drift when the wall clock is adjusted.

Getting the delay right is subtle, because the game's clock is its *audio* clock and its practice
rate rescales time. With the anchor taken at chart time `C₀`, an event targeting chart time `T` must
be dispatched at real delay:

```
t = (T − C₀) / rate + latency
```

where `latency` is the game's own input-latency setting (also rate-scaled). Jitter from a timing
profile is applied to `T` in chart milliseconds, *before* the division. The full derivation is in
the header of `src/playback/Simulation.js`.

### Safety

- **Simultaneous notes** are emitted as distinct key-downs in the same tick, never merged, and each
  column tracks its own held state so a chord cannot drop or duplicate a key.
- **Holds** respect a minimum duration (`MIN_HOLD_MS`, 5 ms — the same floor the game's verifier
  uses) so a hold can never be shorter than a tap the game would reject.
- **Key release is guaranteed** on stop, on error, on blur, and on `SIGINT`/`SIGTERM`. A held-key
  set is tracked per backend and released before the process exits.
- **Duplicate presses are prevented**: a column already down is not re-pressed; a column already up
  is not re-released.
- **Emergency stop**: `Esc` anywhere releases every key on every backend immediately.
- **The gate**: input is refused unless the game reports practice mode, is running, has no overlay
  open, is not in multiplayer or spectating, and is not paused. The refusal reason is shown in words
  in the Input Lab — ManiaFlow reports the limitation rather than silently falling back to the
  game's autoplay.

---

## Keyboard shortcuts

Press `?` anywhere to open the list.

| Keys | Action |
| --- | --- |
| `Alt` + `1`…`7` | Jump to Dashboard … Settings, in sidebar order |
| `?` | Show the shortcut list |
| `/` | Focus search (Chart Library) |
| `Space` | Play / pause the preview |
| `Shift` + `Space` | Stop and return to the start |
| `←` / `→` | Seek ±5 s |
| `Shift` + `←` / `→` | Seek ±1 s |
| `[` / `]` | Set loop A / loop B |
| `\` | Clear the loop |
| `Backspace` | Restart the loop section |
| `-` / `=` | Step the speed down / up |
| `I` | Open the Input Lab |
| `Esc` | **Release every key on every backend immediately** |

Shortcuts yield to anything already handling the key: they never fire while you are typing in a
field, and focus, `aria-selected` and roving tabindex are maintained throughout. Dialogs trap focus
and return it to the element that opened them. Tooltips are announced without taking focus.

---

## Project layout

```
ManiaFlow/
├── index.html                  app shell
├── package.json                zero dependencies, ESM
├── server/
│   ├── index.js                HTTP server; exports start() and is main-guarded
│   ├── static.js               static file serving, MIME types, path-traversal safe
│   ├── websocket.js            hand-rolled RFC 6455 server (no ws dependency)
│   ├── bridgeHub.js            app ⇄ bridge relay with token auth
│   ├── osInput.js              xdotool / ydotool / cliclick / PowerShell backends + detect()
│   └── osInputRunner.js        hrtime-based key scheduler
├── bridge/
│   └── maniaflow-bridge.user.js   the userscript that runs inside the game page
├── src/
│   ├── chart/                  parser, lazer conversion maths, validator, metadata, records,
│   │                           .osz ZIP reader, importer
│   ├── playback/               TimingEngine (ScrollMap), PlaybackEngine, Simulation
│   ├── game/                   bridgeClient, AshtonKmaniaAdapter, IntegrationStatus
│   ├── input/                  KeyboardAdapter (both backends + registry), InputScheduler
│   ├── storage/                PreferencesStore (schema-driven), SessionStore
│   ├── analytics/              SessionRecorder, StatisticsEngine
│   ├── components/             Icon, Button, Tooltip, Dropdown, Dialog, Toast, primitives,
│   │                           controls, Sidebar, TopBar, StatusArea, ChartCanvas
│   ├── pages/                  Dashboard, ChartLibrary, PracticeStudio, TimingLab, InputLab,
│   │                           Statistics, Settings
│   ├── app/                    state (Store, ROUTES), router (hash-based), App
│   ├── styles/                 tokens, global, components, animations
│   └── utils/                  errors, validation, formatters, dom, emitter, rng
├── examples/                   three .osu charts + index.json, all parser-verified
├── tests/                      10 suites, 238 tests, plus a DOM stub and .osu fixtures
├── scripts/check.js            startup check: syntax, imports, exports, module evaluation
└── docs/INTEGRATION-RESEARCH.md   every verified fact about the game, with sources
```

Game-specific code is isolated in exactly two places — `src/game/AshtonKmaniaAdapter.js` and
`bridge/maniaflow-bridge.user.js`. Nothing else in the codebase knows the game exists; if the
integration surface changes, those two files are what change.

---

## Tests and the startup check

```bash
npm test          # 238 tests across 10 files
npm run check     # syntax + import graph + module evaluation + index.html refs
npm run verify    # both of the above
npm run test:watch
```

Current results on Node 22:

| Suite | Tests | Covers |
| --- | --- | --- |
| `chart-parser` | 24 | `.osu` parsing, modes, legacy v3 offsets, SV/green lines, spinners, corrupt input |
| `timing-engine` | 16 | ScrollMap, scroll constant 11485, segments, bar lines, BPM changes |
| `playback-engine` | 25 | Clock, seek, loops, rate changes, cleanup, validated config |
| `simulation` | 23 | Input schedules, timing-error distributions, seeded reproducibility |
| `storage` | 23 | Preference schema, validation, corrupt-storage recovery, session store |
| `statistics` | 15 | Aggregations computed only from recorded sessions |
| `integration` | 28 | Adapter, bridge client, safety gate, status reporting |
| `server` | 30 | Static serving, path traversal, `405` on write methods, WS handshake, OS-input errors |
| `ui-components` | 25 | Buttons, dialogs, toasts, dropdowns, sliders, switches, tabs, tooltips, focus trapping |
| `app-smoke` | 29 | Every screen renders, routes, imports charts, and loads the examples end-to-end |

The tests use a small DOM stub (`tests/helpers/dom-stub.js`) rather than a browser, so they run in
plain Node with no dependencies. They are real assertions about real behaviour — they have caught
genuine bugs in this codebase, including stale dialog stacks, deferred dropdown removal leaving
focusable menus behind, and tab arrow-navigation reading a stale active id.

`npm run check` verifies that the app can actually start: it parses every file, resolves every
relative import, confirms every named export exists, and imports 53/53 modules for real. It excludes
only `src/index.js` and the bridge userscript, which are browser-only by design.

```
  syntax         67 files
  import graph   244 relative imports resolved
  evaluation     53/53 modules imported cleanly

✓ No syntax errors, no unresolved imports, no missing exports.
```

### Parser parity

`tests/fixtures/expected.json` was produced by running **Ashtonk!mania's own `BeatmapParser`** over
the 12 fixtures in `tests/fixtures/`. The committed test suite asserts that ManiaFlow's parser
reproduces that ground truth exactly — note times, end times, columns, hold flags, BPM, scroll
segments and bar lines.

The hard cases are covered deliberately:

- **Spinners.** In native mania a spinner's column does not come from the note's `x`; it comes from
  lazer's seeded `LegacyRandom` (`seedOf`, `SpinnerGen`). `src/chart/ConvertMath.js` ports that
  algorithm rather than approximating it, and `spinners-8k.osu` pins the result.
- **Slider holds.** Durations use lazer's control-point stack, with SV clamped to 0.1–10,
  beatLength to 6–60000 ms and sliderMultiplier to 0.4–3.6.
- **Legacy files.** A pre-v5 file has every time shifted 24 ms later, as osu! does.
- **Dropped notes.** An LN overlapping the next note in its lane is dropped, as the game drops it.

During development the parser was additionally cross-verified against the game's own bundled
beatmaps — including a 1419-note chart with 634 holds — by running both parsers side by side in a
Node VM. Those files are the game's assets and are **not** part of this repository; what ships here
is the 12-fixture suite above, which `npm test` reproduces from a clean checkout.

Charts authored for osu!standard (mode 0) are **reported as unsupported locally** rather than
guessed at; when the bridge is connected their notes are read from the game instead.

---

## Example charts

Three real charts ship in `examples/`, each verified to parse identically in ManiaFlow and in the
game:

| File | Lanes | Notes | Notes on it |
| --- | --- | --- | --- |
| `neon-drift-4k.osu` | 4K | 548 (9 holds) | 120 BPM, 176.0 s, peak 6.0 n/s |
| `velocity-study-7k.osu` | 7K | 520 (31 holds) | three BPM sections (120–175), five SV changes |
| `hold-patterns-4k.osu` | 4K | 114 holds | 90 BPM, 447.3 s |

Load them from **Dashboard → "Load example charts"** or from the Chart Library's empty state. They
are generated patterns, not real songs, and they carry no audio — a preview runs on ManiaFlow's own
clock.

They ship without a star rating. `stars` is only ever populated from the game itself
(`ChartRecord.js`), so an example or an imported chart shows *"Only available from the game"* rather
than a number ManiaFlow made up.

---

## Limitations, stated plainly

| Area | Reality |
| --- | --- |
| **Cross-origin state** | Impossible from a separate app. Requires the in-page bridge script, installed by you. |
| **`isTrusted`** | Synthetic `KeyboardEvent`s are `isTrusted === false`. The game accepts them; they are not hardware input, and ManiaFlow says so in the UI. |
| **OS-level input** | Needs an external helper and a focused browser window. Detected and reported, never faked. |
| **Audio clock** | ManiaFlow does not own the game's audio clock. Bridged, it *reads* `Music.timeAt`; offline, it runs its own clock and labels the session a simulation. |
| **Scoring** | No scores, pp, ranks or grades are computed or fabricated. |
| **Judgement** | The game's OD windows are not re-implemented. `s.windows` is read when bridged and shown read-only. |
| **Star rating** | Not computed locally. Carried through from the game, or `null`. |
| **Mode 0 charts** | osu!standard conversion is not approximated locally; read from the game when bridged, otherwise reported unsupported. |

---

## Responsible use

Use ManiaFlow for local testing, personal practice, accessibility, replay analysis, or an explicitly
authorised test environment.

Do not use it to bypass anti-cheat, to disguise automated input as human, or to gain an unfair
advantage in public or competitive play. The bridge refuses to run input outside the game's own
practice mode precisely so that this is structurally difficult, and practice mode never records
`s.events` — so a practice session cannot become a ranked score.

Simulations are always labelled as simulations and carry a reproducible seed. No timing profile
produced by this tool is claimed to be human, and none is claimed to be undetectable. Ashtonk!mania's
verifier flags an unstable rate below `15` over at least `100` hits as *"inhuman timing"*; the Timing
Lab draws that threshold on its chart as a reference line so you can see where a profile sits
relative to it. It does not help you stay under it.

---

## Configuration reference

Settings are schema-driven (`PREFERENCES_SCHEMA` in `src/storage/PreferencesStore.js`). The same
schema provides defaults, validation and the Settings UI, so a control can never exist for a value
that is not validated. Everything persists to `localStorage` and is recovered — with the repair
reported — if the stored JSON is corrupt or of the wrong type.

| Section | Groups |
| --- | --- |
| **Appearance** | accent (violet, ice, mint, amber, rose, slate) · theme (dark, light) · high-contrast text · density (compact, comfortable, cozy) · animation (auto, full, reduced) · prefer original-language metadata |
| **Practice** | default rate · scroll speed · scroll direction · timing offset · preserve pitch · autoplay preview · bar lines · lane guides · beat-snap colours · key labels · simultaneous-note highlighting · draw only notes near the receptor |
| **Timing** | jack window · peak-density window · simultaneous-note tolerance |
| **Simulation** | distribution · sigma · uniform range · bias · early/late split · **seed** · tap hold · minimum hold · lead-in |
| **Integration** | connect to the bridge · read the library on connect · state poll rate · request timeout |
| **Input** | backend · OS helper · refuse to arm outside practice mode · release all keys on blur · compensate for the game's input latency |
| **Performance** | canvas resolution cap · frame rate cap · number of sessions kept |
| **Data** | export and import · delete a session · delete all history — every destructive action behind a confirm dialog |

Animation honours `prefers-reduced-motion` by default (`appearance.motion: 'auto'`). Setting it to
`reduced` collapses a single `--motion` multiplier to zero, so every transition and keyframe stops —
no separate code path, nothing left animating.

All motion — page transitions, dialogs, toasts, staggered reveals — animates `transform` and
`opacity` only. `src/styles/animations.css` contains literally nothing else, so it stays on the
compositor. The deliberate exceptions are progress bars, whose `width` *is* the value being
displayed, and cheap `background-color` hover states.

---

## License

`UNLICENSED`. This repository is private and no license has been chosen. Nothing here may be
redistributed until one is. See `package.json`.
