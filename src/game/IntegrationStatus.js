/**
 * IntegrationStatus — one honest description of what ManiaFlow can currently do.
 *
 * Integration has four independent links, and any of them can be the one that is missing:
 *
 *   1. the ManiaFlow server          (is the WebSocket open?)
 *   2. the in-page bridge            (has the user installed and loaded it?)
 *   3. the game inside that page     (is `window.AshtonkMania` there, and on which screen?)
 *   4. an OS keyboard helper         (only needed for the OS-level input backend)
 *
 * Collapsing those into a single green/red light would hide which one is broken, so the
 * status keeps each link separate *and* derives one overall level for the sidebar dot.
 * Nothing here talks to the network; it is a pure function of what the adapter has observed,
 * which is what makes it testable.
 */

export const Level = Object.freeze({
  OK: 'ok',                 // everything needed for the current action is present
  PARTIAL: 'partial',       // connected, but the game is not where input would be accepted
  UNAVAILABLE: 'unavailable', // a link is missing; offline features still work
  ERROR: 'error',           // something failed and the reason is known
});

export const Link = Object.freeze({
  SERVER: 'server',
  BRIDGE: 'bridge',
  GAME: 'game',
  OS_INPUT: 'os-input',
});

/**
 * The screens Ashtonk!mania registers, mapped to the words its own UI uses.
 * Kept here rather than in the adapter so a screen name is never shown to the user as a
 * registry key ("songselect") by one surface and as a word ("Song select") by another.
 */
export const SCREEN_LABELS = Object.freeze({
  home: 'Main menu', songselect: 'Song select', gameplay: 'Gameplay', results: 'Results',
  beatmaps: 'Beatmaps', explore: 'Browse', dashboard: 'Dashboard', rankings: 'Rankings',
  daily: 'Daily challenge', multiplayer: 'Multiplayer', collections: 'Collections',
  profile: 'Profile', stats: 'Statistics', replays: 'Replays', skins: 'Skins',
});

export function screenLabel(screen) {
  if (!screen) return null;
  return SCREEN_LABELS[screen] || screen;
}

const LABELS = {
  [Level.OK]: 'Connected',
  [Level.PARTIAL]: 'Connected, not in practice',
  [Level.UNAVAILABLE]: 'Not connected',
  [Level.ERROR]: 'Integration error',
};

/**
 * @param {object} observed
 * @param {{ state: string, connected: boolean, lastError: string|null }} observed.server
 * @param {{ connected: boolean, info: object|null, latencyMs: number|null }} observed.bridge
 * @param {{ available: boolean, screen: string|null, practice: boolean, reason?: string|null }} observed.game
 * @param {{ detected: boolean, available: boolean, backendId: string|null, reason?: string|null }} [observed.osInput]
 */
export function assess(observed = {}) {
  const server = observed.server || {};
  const bridge = observed.bridge || {};
  const game = observed.game || {};
  const osInput = observed.osInput || {};

  const links = [
    {
      id: Link.SERVER,
      label: 'ManiaFlow server',
      ok: !!server.connected,
      detail: server.connected ? 'WebSocket open' : (server.state === 'reconnecting' ? 'Reconnecting…' : server.lastError || 'Not connected'),
    },
    {
      id: Link.BRIDGE,
      label: 'In-page bridge',
      ok: !!server.connected && !!bridge.connected,
      detail: !server.connected ? 'Needs the server first'
        : bridge.connected ? `Loaded${bridge.info?.bridgeVersion ? ` (v${bridge.info.bridgeVersion})` : ''}`
          : 'No bridge has connected. Install it from Settings → Integration.',
    },
    {
      id: Link.GAME,
      label: 'Ashtonk!mania',
      ok: !!bridge.connected && !!game.available,
      detail: !bridge.connected ? 'Needs the bridge first'
        : game.available ? `On the ${game.screen || 'unknown'} screen`
          : game.reason || 'window.AshtonkMania is not present',
    },
    {
      id: Link.OS_INPUT,
      label: 'OS keyboard helper',
      // Only relevant when that backend is selected; otherwise it is not a failure.
      ok: osInput.required ? !!osInput.available : true,
      optional: !osInput.required,
      detail: !osInput.required ? 'Not needed for synthetic input'
        : osInput.available ? `${osInput.backendId} is armed or arming`
          : osInput.reason || (osInput.detected ? 'No helper is available on this machine' : 'Not checked yet'),
    },
  ];

  const required = links.filter((link) => !link.optional);
  const allOk = required.every((link) => link.ok);
  const serverOk = links[0].ok;
  const bridgeOk = links[1].ok;

  let level;
  if (server.state === 'error' || (server.lastError && !serverOk)) level = Level.ERROR;
  else if (!serverOk || !bridgeOk) level = Level.UNAVAILABLE;
  else if (!allOk) level = Level.ERROR;
  else if (game.available && !game.practice) level = Level.PARTIAL;
  else level = Level.OK;

  // Whether input is permitted right now. `practice` alone is not enough: the game's own
  // Auto, a replay feed, multiplayer, spectating and a paused session all close the gate,
  // and the caller reports that as `blocked`. Deriving this from `practice` only would hand
  // out a capability the bridge would then refuse — two answers to one question.
  const inputAllowed = bridgeOk && !!game.available && !!game.practice && !game.blocked;

  // What can actually be done right now. Every feature checks this rather than guessing.
  const capabilities = {
    offline: true,                                     // always: imported charts work with no integration
    readState: bridgeOk && !!game.available,
    readLibrary: bridgeOk && !!game.available,
    readChart: bridgeOk && !!game.available,
    readKeybinds: bridgeOk && !!game.available,
    practiceControls: inputAllowed,
    syntheticInput: inputAllowed,
    osInput: !!osInput.available,
  };

  const blocking = !inputAllowed && bridgeOk && game.available ? (game.reason || null) : null;

  return {
    level,
    label: LABELS[level],
    detail: summarise(level, { serverOk, bridgeOk, game, capabilities }),
    links,
    capabilities,
    blockingReason: blocking,
    screen: game.screen ?? null,
    screenLabel: screenLabel(game.screen),
    practice: !!game.practice,
    latencyMs: Number.isFinite(+bridge.latencyMs) ? +bridge.latencyMs : null,
    bridgeInfo: bridge.info || null,
    checkedAt: Date.now(),
  };
}

function summarise(level, { serverOk, bridgeOk, game, capabilities }) {
  switch (level) {
    case Level.OK:
      return game.practice
        ? 'Practice mode is active — reading state and sending input are both available.'
        : 'Connected to the game.';
    case Level.PARTIAL:
      return `Connected and reading state from the ${screenLabel(game.screen) || 'current'} screen. `
        + (game.reason || 'Input needs the game to be in its own practice mode.');
    case Level.UNAVAILABLE:
      if (!serverOk) return 'The ManiaFlow server is not reachable. Charts you import still work offline.';
      if (!bridgeOk) return 'No bridge is connected. Charts you import still work offline.';
      return 'Part of the integration is missing. Charts you import still work offline.';
    case Level.ERROR:
      return game.reason || capabilities.syntheticInput
        ? 'A required integration link failed.'
        : 'A required integration link failed.';
    default:
      return '';
  }
}

/** A one-line description for the status bar. */
export function shortLabel(status) {
  if (!status) return 'Offline';
  if (status.level === Level.OK && status.practice) return 'Practice live';
  if (status.level === Level.OK) return 'Game connected';
  if (status.level === Level.PARTIAL) return `Connected · ${status.screenLabel || 'game'}`;
  if (status.level === Level.ERROR) return 'Integration error';
  return status.links?.[1]?.ok ? 'Bridge only' : 'Offline';
}

export const IntegrationStatus = { assess, shortLabel, screenLabel, Level, Link, LABELS, SCREEN_LABELS };
