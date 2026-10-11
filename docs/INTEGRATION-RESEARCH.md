# Ashtonk!mania — integration research

Findings recorded **before** any ManiaFlow code was written, from inspecting the live
deployment at <https://ashtonkmania.vercel.app/> and its public source repository
(`ashtonkehler14-glitch/Ashtonk-mania`, whose GitHub `homepage` field is that URL).

Everything below is a verified fact about the target, not an assumption. Where ManiaFlow
cannot use a fact, that is stated too.

---

## 1. What the application is

A browser-based osu!mania client ("Ashtonk!mania"), shipped as a single built `index.html`
(≈2 MB) produced by `build.mjs` from `src/js/*.js` (files `00-util.js` … `20-app.js`,
concatenated in filename order into one `"use strict"` script scope).

There is **no build step, framework, bundler output map, or module system** to hook into.
All of its internals live in one script scope and are deliberately re-exported onto a
single global.

## 2. The one supported integration surface

`src/js/20-app.js:56`:

```js
window.AshtonkMania = { SafeMode, MapOffsets, Onboarding, Presence, NeruMascot, App, DB,
  Settings, ProfileManager, OsuMath, ExplorerScreen, OnlineBeatmaps, BeatmapManager,
  SkinManager, ScoreManager, ReplayManager, Music, AudioManager, Screens, GameplayScreen,
  Game, SongSelect, BeatmapParser, Collections, Favorites, SettingsPanel, ModSelect,
  MenuMusic, NowPlaying, Multiplayer, MultiplayerScreen, Zoom, healthModeFor, SkinHealthBar,
  friendlyError, AvatarPresets, Toast, Background, Spectate, Friends, OnlinePanel,
  DashboardScreen, UserPanels, Osr, Mobile, Dialog, Chat, Rankings, RankingsScreen, Daily,
  DailyScreen, Medals, ProfileScreen, Bus, ManageCollections, MpResults, SkinEditor,
  HudLayout, Screenshot, UserTags };
```

This is the **only** documented interface. There is no HTTP API, no `postMessage`
protocol, no extension manifest, and no plugin registry.

Consequence for ManiaFlow: an app served from `http://127.0.0.1:<port>` **cannot** read
`window.AshtonkMania` on `https://ashtonkmania.vercel.app` — that is a cross-origin
boundary, and browsers enforce it. Integration therefore requires a small script running
*inside* the game's own page context that relays to ManiaFlow over a local WebSocket.
ManiaFlow ships that script (`bridge/maniaflow-bridge.user.js`) and never pretends
otherwise.

## 3. Chart format

osu! beatmap text format (`.osu`), imported from `.osz` ZIP archives, loose folders, or
Web-Osu-Mania backups. `BeatmapParser.parse(text)`:

- Header `osu file format v<N>` required (defaults to 14); a file with neither the header
  nor `[HitObjects]` throws `BeatmapError`.
- **Format versions below 5 shift every time by +24 ms** (`const off = bm.formatVersion < 5 ? 24 : 0`).
- Sections parsed: `General`, `Editor`, `Metadata`, `Difficulty`, `Colours` (simple `k: v`),
  `Events`, `TimingPoints`, `HitObjects`.
- `TimingPoints` row: `time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects`.
  A **negative beat length is always an inherited (green/SV) line**, whatever the flag says.
  SV multiplier = `100 / -beatLength`.
- `HitObjects` row: `x,y,time,type,hitSound,extras`.
  Type bits: `1` circle, `2` slider, `8` spinner, `128` mania hold.
  A mania hold reads `endTime` from `extras.split(':')[0]`.
  **Column = `clamp(floor(x * keys / 512), 0, keys - 1)`**; `keys = clamp(round(CircleSize), 1, 18)`.
- Times beyond `MAX_MAP_TIME = 6 h` are treated as corrupt and the line is skipped.
- `Mode: 3` is native mania; `Mode: 0` (osu!standard) is converted lazer-style by
  `ManiaConvert`; modes 1 and 2 are rejected outright.
- Normalised note shape: `{ col, time, end, isLN, hs, sample }`, sorted by `time` then `col`.
- Per-column duplicates and LN overlaps are dropped: a note is discarded when
  `note.time <= lastEnd[col]`.

Scroll model (`BeatmapParser.scrollSegments`): red lines scroll at
`mostCommonBeatLength / beatLength`, green lines multiply the current red speed by
`100 / -beatLength`, integrated into `[{ time, pos, vel }]`. Converted (mode 0) maps ignore SV.

`mostCommonBeatLength` is the beat length covering the longest span **between the first and
last hit object** — BPM sections outside the notes do not count. That is the value reported
as the map's BPM.

## 4. Timing reference

"The clock is the audio." `Music` (in `05-audio.js`) is the single source of song position:

- `Music.timeAt(perfMs)` → song position in ms, from
  `AudioContext.getOutputTimestamp()` mapped onto `performance.now()`.
- `Music.rate`, `Music.playing`, `Music.gen` (bumped on every play/seek/pause/stop),
  `Music.timeAtCtx(ctxSeconds)`.
- `GameplayScreen.gameTime(at)` = `Music.timeAt(at) - offsetMs() * rate`, where
  `offsetMs()` = `Settings.get('audio.offset') + state.mapOffset`.
- Input is timestamped, not frame-timestamped:
  `inputTime(e)` = `Music.timeAtCtx(AudioManager.perfToCtx(e.timeStamp)) - offsetMs*rate - Settings.get('input.latency')*rate`.
- Rendering uses a separate lazer-style `InterpolatingFramedClock` (`frameTime(ts)`),
  damped toward the audio clock with a 50 ms half-life and hard-snapping beyond
  two 60 Hz frames. **Timing and rendering are already separate concerns** — ManiaFlow's
  engine mirrors that split.

## 5. Keyboard input

- Keybinds are `KeyboardEvent.code` strings, per column, with two keys allowed per column:
  `Settings.keybinds(keys)` → `[[code, …], …]`, falling back to `DEFAULT_KEYBINDS`
  (defined for 1K–18K). `Settings.setKeybinds(keys, binds)` writes them.
  `keyLabel(code)` produces the human-readable label.
- 4K default: `KeyD KeyF KeyJ KeyK`. 7K default: `KeyS KeyD KeyF Space KeyJ KeyK KeyL`.
- Gameplay listens on `window` with `capture: true`:
  `window.addEventListener('keydown'|'keyup', handler, true)`.
- `onKeyDown(e)` resolves `const col = s.keyMap.get(e.code)` and calls
  `keyDown(col, e.code, inputTime(e))`. `onKeyUp` mirrors it. A column is *pressed* when
  its first bound key goes down and *released* when its last one comes up
  (`s.down[col]` is a `Set`).
- Guards that a synthetic event must satisfy: `Screens.current === GameplayScreen`,
  no overlay open (`Overlays.top()`), state exists, loader finished, `s.running` true,
  `s.feed` falsy, and **`e.repeat` false**.
- **`e.isTrusted` is never checked.** A `KeyboardEvent` constructed in the page context is
  accepted. It is still `isTrusted === false` — ManiaFlow states that plainly and does not
  claim synthetic input is hardware input.

## 6. Game states

`Screens.register` names: `home`, `songselect`, `gameplay`, `results`, `beatmaps`,
`explore`, `dashboard`, `rankings`, `daily`, `multiplayer`, `collections`, `profile`,
`stats`, `replays`, `skins`. `Screens.current` / `Screens.currentName` / `Screens.go(name, params)`.
`Bus.emit('screen:changed', name)` fires on every transition.

Gameplay launch: `Game.launch({ mapId, mods, mode: 'play'|'practice'|'replay', replay })`.
State object `GameplayScreen.s` exposes: `rec, bm, keys, mods, rate, practice, auto, replay,
seed, windows, layout, scroll, baseNotes, endTime, redTiming, bars, firstNote, held, keyMap,
keyLabels, down, events, running, finished, failed, mode, loopA, loopB, mapOffset, mp, spectate`.

`Bus` events worth listening to: `screen:changed`, `settings:changed`, `library:changed`,
`music:changed`, `mods:changed`, `scores:changed`, `replays:changed`, `skin:changed`,
`audio:state`, `safemode:changed`, `import:status`, `mapoffset:changed`, `presence:changed`.

## 7. The game's own practice mode

This is the authorized local practice context ManiaFlow targets.

- Entered with F4 in song select, the "Practice" button, or
  `Game.launch({ mapId, mode: 'practice' })`.
- `s.practice === true`, `s.mode === 'practice'`, `noFail` forced on, and
  `rate = Settings.get('practice.speed')`.
- `PRACTICE_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]`.
- APIs: `practiceSeek(t)`, `practiceSpeed(sp)`, `setLoop('A'|'B'|'clear')`,
  `restartSection()`, `nudgeOffset(±5)`.
- Practice hotkeys: `[` `]` `\` `Backspace` `-` `=` `←` `→`.
- **Practice never records input events**: `if (!s.practice) s.events.push(t, col, down ? 1 : 0)`.
  A practice session is therefore never submitted for verification.

## 8. The game's built-in autoplay — deliberately NOT used

`08-mods.js` defines an `AT` (Auto) mod. When active, `15-screen-gameplay.js` sets
`s.auto = true`, `s.mode = 'auto'`, and `s.feed = generateAutoInputs(notes, keys).flat()`
(`09-gameplay.js:434`), then feeds those events straight into the engine, bypassing the
keyboard entirely.

ManiaFlow does not touch this. It never enables `AT`, never calls `generateAutoInputs`,
never assigns to `s.feed`, and refuses to arm its own input system while `s.auto` or
`s.feed` is set. Section 18 of the specification requires genuine key events through a
separate path; that is what `src/input/` implements.

## 9. Anti-cheat — verified, and respected

`09c-verify.js` is the game server's own judge, bundled identically into
`worker/verify-bundle.js`. Given the beatmap text (hash-checked) and the play's recorded
key events, it re-plays them through the same engine and computes score, accuracy, combo,
grade, stars and pp itself. It rejects a play when:

| Constant | Value | Meaning |
| --- | --- | --- |
| `VERIFY.MIN_HOLD` | 5 ms | a press/release closer than this "isn't a finger" → `impossible input` |
| `VERIFY.MIN_RATE` / `MAX_RATE` | 0.5 / 2 | speed out of range |
| `VERIFY.MAX_EVENTS` | 600 000 | replay size cap |
| `VERIFY.BOT_UR` / `BOT_NOTES` | 15 / 100 | **unstable rate below 15 over at least 100 judged notes is "a script, not a person"** → `inhuman timing` |
| `ModSystem.isRanked(mods)` | — | `AT` and helper mods are unranked → `unranked mods` |

Submission happens only here (`15-screen-gameplay.js:1756`):

```js
if (score.passed && !s.mods.includes('AT') && s.mode === 'play' && !s.practice) Verified.submit({...});
```

So a ranked play is *never* produced by practice mode, by Auto, or by a replay.

**What ManiaFlow does with this:** perfect-timing synthetic input on a scored play would be
detected and rejected as `inhuman timing` — that is the anti-cheat system working as
designed. ManiaFlow therefore hard-gates its input system:

1. It refuses to arm unless the game reports `s.practice === true` (or the session is a
   purely local offline simulation inside ManiaFlow itself).
2. It refuses if `s.mp`, `s.spectate`, `s.auto`, or `s.feed` is set (multiplayer,
   spectating, or the game's own autoplay).
3. It refuses if any selected mod is unranked-but-scored, and it warns if the play mode is
   `'play'` rather than `'practice'`.
4. It enforces `MIN_HOLD` (5 ms, rate-scaled) on every generated release so it never emits
   input the game would consider impossible.
5. It adds bounded, seeded timing variation only for *offline simulation study*, and labels
   every such run a simulation. It never claims a timing profile is human or undetectable,
   and it does not attempt to defeat the unstable-rate check.

## 10. Library records

`BeatmapManager.maps` is a `Map<id, record>`; `BeatmapManager.setById` groups by beatmap
set. Record fields (`_mapRecord`, `07-beatmap-manager.js:339`):

`id, hash, setId, onlineId, title, titleUnicode, artist, artistUnicode, creator, version,
source, tags, osuPath, audioFile, bgFile, previewTime, mode, keys, od, hp, problems,
warnings, srVersion, breaks, added, stars, bpm, bpmMin, bpmMax, length, drainLength,
noteCount, lnCount, objectCount, lnRatio, nps, firstNote, lastNote`.

Also: `playableMaps()`, `mapByHash(hash)`, `load(mapId)`, `getFile(setId, path)`,
`hasFile(setId, path)`, `exportOsz(setId)`, `importFiles(files)`, `thumbURL(set)`, `bgURL(map)`.

ManiaFlow's Chart Library mirrors this record shape exactly, so a chart loaded from the
bridge and a `.osu` file imported locally are the same object as far as the UI is concerned.

## 11. Limitations ManiaFlow reports honestly

| Area | Reality |
| --- | --- |
| Cross-origin state access | Impossible from a separate app; requires the in-page bridge script. |
| `isTrusted` | Synthetic `KeyboardEvent`s are `isTrusted === false`. The game accepts them; they are not hardware input, and ManiaFlow says so in the UI. |
| OS-level input | Needs an external helper (`xdotool`/`ydotool`, `cliclick`/`osascript`, PowerShell `SendKeys`) and the browser window focused. Detected and reported, never faked. |
| Audio | ManiaFlow does not own the game's audio clock. When bridged, it *reads* `Music.timeAt`; when offline it runs its own clock and labels the session a simulation. |
| Scoring | ManiaFlow computes no scores, pp, ranks or grades. It has no access to the game's score database beyond what the game itself exposes, and it does not fabricate any. |
| Judgement | ManiaFlow does not re-implement the game's OD windows for scoring purposes. It reads `s.windows` when bridged and shows them as read-only facts. |
