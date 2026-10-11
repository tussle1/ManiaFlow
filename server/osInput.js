/**
 * Operating-system level keyboard input.
 *
 * This is the "how" half of section 18: given a `KeyboardEvent.code` and a down/up
 * transition, put a real key event into the operating system's input queue so a focused
 * browser window receives it exactly as it would receive one from a physical keyboard.
 *
 * Browsers cannot do this. A web page can only dispatch events inside its own document,
 * and those are always `isTrusted === false`. Reaching the OS needs a native helper, so
 * this runs in the ManiaFlow server process and drives one of the documented automation
 * interfaces below:
 *
 *   Linux / X11      xdotool          persistent process, commands piped to `xdotool -`
 *   Linux / Wayland  ydotool          one process per event (needs uinput access)
 *   macOS            cliclick         one process per event
 *   Windows          PowerShell +     persistent process, user32 `SendInput`
 *                    SendInput
 *
 * Nothing here is faked. `detect()` probes for the actual binaries and reports what is
 * genuinely usable; when no helper is present the backend reports `unsupported` with the
 * reason, and the UI shows that instead of pretending.
 *
 * SAFETY: OS-level key events land in whatever window has focus. They are only ever sent
 * while an armed ManiaFlow input session is running, and the session is gated on the game
 * reporting its own practice mode. `releaseAll()` runs on stop, on error, on disconnect
 * and on process exit so a key can never be left down.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ─────────────────────────── key tables ─────────────────────────── */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** X11 keysym names, as `xdotool key` expects them. */
function toX11(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return `KP_${code.slice(6)}`;
  return {
    Space: 'space', Semicolon: 'semicolon', Quote: 'apostrophe', Comma: 'comma', Period: 'period',
    Slash: 'slash', Backslash: 'backslash', Minus: 'minus', Equal: 'equal', Backquote: 'grave',
    BracketLeft: 'bracketleft', BracketRight: 'bracketright', Tab: 'Tab', Enter: 'Return',
    NumpadEnter: 'KP_Enter', Escape: 'Escape', Backspace: 'BackSpace', Delete: 'Delete',
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    ShiftLeft: 'shift', ShiftRight: 'shift', ControlLeft: 'ctrl', ControlRight: 'ctrl',
    AltLeft: 'alt', AltRight: 'alt', MetaLeft: 'super', MetaRight: 'super',
    CapsLock: 'Caps_Lock', NumpadAdd: 'KP_Add', NumpadSubtract: 'KP_Subtract',
    NumpadMultiply: 'KP_Multiply', NumpadDivide: 'KP_Divide', NumpadDecimal: 'KP_Decimal',
    PageUp: 'Prior', PageDown: 'Next', Home: 'Home', End: 'End', IntlBackslash: 'backslash',
  }[code] || null;
}

/** Linux input-event codes, as `ydotool key <code>:<down>` expects them. */
const EV = (() => {
  const t = {};
  const order = 'esc1234567890minus-equal-backspace-tab qwertyuiop-leftbrace-rightbrace-enter leftctrl-asdfghjkl-semicolon-apostrophe-grave-leftshift-backslash-zxcvbnm-comma-dot-slash-rightshift';
  void order;
  const seq = [
    ['Escape', 1], ['Digit1', 2], ['Digit2', 3], ['Digit3', 4], ['Digit4', 5], ['Digit5', 6],
    ['Digit6', 7], ['Digit7', 8], ['Digit8', 9], ['Digit9', 10], ['Digit0', 11], ['Minus', 12],
    ['Equal', 13], ['Backspace', 14], ['Tab', 15], ['KeyQ', 16], ['KeyW', 17], ['KeyE', 18],
    ['KeyR', 19], ['KeyT', 20], ['KeyY', 21], ['KeyU', 22], ['KeyI', 23], ['KeyO', 24],
    ['KeyP', 25], ['BracketLeft', 26], ['BracketRight', 27], ['Enter', 28], ['ControlLeft', 29],
    ['KeyA', 30], ['KeyS', 31], ['KeyD', 32], ['KeyF', 33], ['KeyG', 34], ['KeyH', 35],
    ['KeyJ', 36], ['KeyK', 37], ['KeyL', 38], ['Semicolon', 39], ['Quote', 40], ['Backquote', 41],
    ['ShiftLeft', 42], ['Backslash', 43], ['KeyZ', 44], ['KeyX', 45], ['KeyC', 46], ['KeyV', 47],
    ['KeyB', 48], ['KeyN', 49], ['KeyM', 50], ['Comma', 51], ['Period', 52], ['Slash', 53],
    ['ShiftRight', 54], ['AltLeft', 56], ['Space', 57], ['CapsLock', 58], ['ArrowUp', 103],
    ['ArrowLeft', 105], ['ArrowRight', 106], ['ArrowDown', 108], ['ControlRight', 97],
    ['AltRight', 100], ['MetaLeft', 125], ['MetaRight', 126], ['NumpadEnter', 96],
    ['NumpadDivide', 98], ['NumpadDecimal', 83], ['NumpadAdd', 78], ['NumpadSubtract', 74],
    ['Numpad0', 82], ['Numpad1', 79], ['Numpad2', 80], ['Numpad3', 81], ['Numpad4', 75],
    ['Numpad5', 76], ['Numpad6', 77], ['Numpad7', 71], ['Numpad8', 72], ['Numpad9', 73],
  ];
  for (const [code, n] of seq) t[code] = n;
  for (let i = 1; i <= 12; i++) t[`F${i}`] = 58 + i;
  return t;
})();

/** cliclick key names (macOS). */
function toCliclick(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  return {
    Space: 'space', Enter: 'return', NumpadEnter: 'enter', Tab: 'tab', Escape: 'esc',
    Backspace: 'delete', Delete: 'forwarddelete', ArrowLeft: 'arrow-left', ArrowRight: 'arrow-right',
    ArrowUp: 'arrow-up', ArrowDown: 'arrow-down', ShiftLeft: 'shift', ShiftRight: 'shift',
    ControlLeft: 'ctrl', ControlRight: 'ctrl', AltLeft: 'alt', AltRight: 'alt',
    MetaLeft: 'cmd', MetaRight: 'cmd', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Backquote: '`',
  }[code] || null;
}

/** Windows virtual-key codes. */
function toVk(code) {
  if (/^Key[A-Z]$/.test(code)) return 0x41 + (code.charCodeAt(3) - 65);
  if (/^Digit[0-9]$/.test(code)) return 0x30 + Number(code.slice(5));
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return 0x70 + (Number(code.slice(1)) - 1);
  if (/^Numpad[0-9]$/.test(code)) return 0x60 + Number(code.slice(6));
  return {
    Backspace: 0x08, Tab: 0x09, Enter: 0x0d, ShiftLeft: 0x10, ShiftRight: 0x10,
    ControlLeft: 0x11, ControlRight: 0x11, AltLeft: 0x12, AltRight: 0x12, Escape: 0x1b,
    Space: 0x20, PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24, ArrowLeft: 0x25,
    ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, Delete: 0x2e, Semicolon: 0xba,
    Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0,
    BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde, NumpadMultiply: 0x6a,
    NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
    NumpadEnter: 0x0d, MetaLeft: 0x5b, MetaRight: 0x5c, CapsLock: 0x14,
  }[code] ?? null;
}

const SUPPORTED = {
  xdotool: (code) => toX11(code) !== null,
  ydotool: (code) => EV[code] !== undefined,
  cliclick: (code) => toCliclick(code) !== null,
  'windows-sendinput': (code) => toVk(code) !== null,
};

/* ─────────────────────────── detection ─────────────────────────── */

function probe(command, args = ['--version']) {
  return new Promise((resolveProbe) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore' });
    } catch {
      resolveProbe(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolveProbe(false);
    }, 2500);
    child.on('error', () => { clearTimeout(timer); resolveProbe(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolveProbe(code === 0 || code === null); });
  });
}

const CANDIDATES = {
  linux: [
    {
      id: 'xdotool', binary: 'xdotool', label: 'xdotool (X11)',
      note: 'Persistent process; key commands are piped into `xdotool -`. Needs an X11 display and a focused window.',
    },
    {
      id: 'ydotool', binary: 'ydotool', label: 'ydotool (Wayland/uinput)',
      note: 'One process per event, which adds several milliseconds of latency per key. Needs access to /dev/uinput and a running ydotoold.',
    },
  ],
  darwin: [
    {
      id: 'cliclick', binary: 'cliclick', label: 'cliclick', probeArgs: ['-V'],
      note: 'One process per event, which adds latency per key. Needs Accessibility permission for the terminal that started ManiaFlow.',
    },
  ],
  win32: [
    {
      id: 'windows-sendinput', binary: 'powershell', label: 'PowerShell + user32 SendInput',
      note: 'Persistent PowerShell process calling SendInput. The browser window must be focused.',
      probeArgs: ['-NoProfile', '-Command', 'exit 0'],
    },
  ],
};

/** Which helpers are actually installed on this machine. Never guesses. */
export async function detect() {
  const platform = process.platform;
  const candidates = CANDIDATES[platform] || [];
  const noSession = platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const results = [];
  for (const candidate of candidates) {
    const installed = await probe(candidate.binary, candidate.probeArgs);
    // A helper that is installed but has no graphical session to talk to is *not* usable.
    // Saying otherwise would let the UI offer a button that cannot work.
    const blocked = installed && candidate.id === 'xdotool' && noSession;
    results.push({
      id: candidate.id, label: candidate.label, binary: candidate.binary,
      platform, installed, available: installed && !blocked, note: candidate.note,
      reason: !installed ? `${candidate.binary} was not found on PATH`
        : blocked ? 'Installed, but this process has no DISPLAY — xdotool needs an X11 session'
          : null,
      supports: installed && !blocked ? describeSupport(candidate.id) : null,
    });
  }
  return {
    platform,
    backends: results,
    recommended: results.find((b) => b.available)?.id || null,
    warnings: noSession
      ? ['No DISPLAY or WAYLAND_DISPLAY in this process environment — OS-level input needs a graphical session.']
      : [],
  };
}

function describeSupport(id) {
  const probeCodes = ['KeyD', 'KeyF', 'KeyJ', 'KeyK', 'Space', 'Semicolon', 'ArrowLeft', 'KeyA'];
  return probeCodes.filter((c) => SUPPORTED[id](c));
}

/* ─────────────────────────── backends ─────────────────────────── */

/** Base contract every OS backend satisfies. */
class OsBackend {
  constructor(id) {
    this.id = id;
    this.held = new Set();
    this.opened = false;
  }

  get supportsHolds() { return true; }

  /* eslint-disable no-unused-vars */
  async open() { throw new Error('not implemented'); }
  async press(_code) { throw new Error('not implemented'); }
  async release(_code) { throw new Error('not implemented'); }
  async close() { throw new Error('not implemented'); }
  /* eslint-enable no-unused-vars */

  /** Let every key go. Runs on stop, error, disconnect and process exit. */
  async releaseAll() {
    const stuck = [...this.held];
    for (const code of stuck) {
      try { await this.release(code); } catch { /* best effort — the point is to try every key */ }
    }
    this.held.clear();
    return stuck;
  }
}

/**
 * Spawn a long-lived helper and wait for proof that it is usable.
 *
 * A spawn that fails (`ENOENT`, no display, no permission) reports asynchronously, so
 * simply calling `spawn()` and assuming success is how a backend ends up claiming to be
 * armed when it is not. This waits for an explicit readiness signal, and rejects on the
 * first `error` or premature `exit`, carrying the helper's own stderr as the reason.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ isReady: (stdout: string) => boolean, prime?: string, timeoutMs?: number, stdio?: string[] }} options
 */
function startPersistent(command, args, options) {
  const { isReady, prime, timeoutMs = 4000, stdio = ['pipe', 'pipe', 'pipe'] } = options;
  return new Promise((resolveStart, rejectStart) => {
    let child;
    try {
      child = spawn(command, args, { stdio, windowsHide: true });
    } catch (err) {
      rejectStart(new Error(`could not start ${command}: ${err.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      const reason = stderr.trim() ? `: ${stderr.trim().split('\n')[0]}` : '';
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(rejectStart, new Error(`${command} did not become ready within ${timeoutMs} ms${reason}`));
    }, timeoutMs);

    child.on('error', (err) => finish(rejectStart, new Error(
      err.code === 'ENOENT' ? `${command} is not installed or not on PATH` : `could not start ${command}: ${err.message}`,
    )));
    child.on('exit', (code, signal) => {
      if (settled) return;
      const reason = stderr.trim() ? ` — ${stderr.trim().split('\n')[0]}` : '';
      finish(rejectStart, new Error(`${command} exited immediately (code ${code}${signal ? `, ${signal}` : ''})${reason}`));
    });
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (isReady(stdout)) finish(resolveStart, child);
      });
    }
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    if (prime && child.stdin?.writable) child.stdin.write(prime);
  });
}

/**
 * xdotool driven as one persistent process reading commands from stdin (`xdotool -`).
 * A spawn per key would cost milliseconds; this costs a pipe write.
 *
 * Readiness is proven, not assumed: `getmouselocation` is piped in and the backend waits
 * for the `x:… y:…` reply. That single probe catches a missing binary, a missing `$DISPLAY`
 * and a refused X connection alike.
 */
class XdotoolBackend extends OsBackend {
  constructor() { super('xdotool'); this.child = null; }

  async open() {
    if (this.opened) return;
    this.child = await startPersistent('xdotool', ['-'], {
      prime: 'getmouselocation\n',
      isReady: (stdout) => /\bx:\s*-?\d+/.test(stdout),
    });
    // From here on a crash must not throw inside an event handler — that would take the
    // whole server down. It marks the backend unusable; the next send reports it.
    this.child.on('error', () => { this.opened = false; this.child = null; this.held.clear(); });
    this.child.on('exit', () => { this.opened = false; this.child = null; this.held.clear(); });
    this.opened = true;
  }

  _command(text) {
    if (!this.opened || !this.child || !this.child.stdin?.writable) {
      throw new Error('xdotool process is not running');
    }
    this.child.stdin.write(text + '\n');
  }

  async press(code) {
    const keysym = toX11(code);
    if (!keysym) throw new Error(`xdotool has no keysym for ${code}`);
    if (this.held.has(code)) return;
    this._command(`keydown ${keysym}`);
    this.held.add(code);
  }

  async release(code) {
    const keysym = toX11(code);
    if (!keysym) return;
    if (!this.held.has(code)) return;
    this._command(`keyup ${keysym}`);
    this.held.delete(code);
  }

  async close() {
    await this.releaseAll().catch(() => {});
    if (this.child) {
      try { this.child.stdin.end(); } catch { /* already closed */ }
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    this.child = null;
    this.opened = false;
  }
}

/**
 * ydotool / cliclick: no stdin command mode, so one short-lived process per event.
 * Works, but the spawn cost is real — reported to the UI as added latency rather than hidden.
 */
class PerEventBackend extends OsBackend {
  constructor(id, binary, buildArgs, probeArgs) {
    super(id);
    this.binary = binary;
    this.buildArgs = buildArgs;
    this.probeArgs = probeArgs;
  }

  /** Prove the helper actually runs before claiming to be armed. */
  async open() {
    if (this.opened) return;
    if (this.probeArgs) await this._run(this.probeArgs, `${this.binary} did not respond to its version probe`);
    this.opened = true;
  }

  async _run(args, failureMessage) {
    return new Promise((resolveRun, rejectRun) => {
      let child;
      try {
        child = spawn(this.binary, args, { stdio: 'ignore', windowsHide: true });
      } catch (err) {
        rejectRun(new Error(`could not start ${this.binary}: ${err.message}`));
        return;
      }
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish(rejectRun, new Error(`${this.binary} timed out`));
      }, 3000);
      child.on('error', (err) => finish(rejectRun, new Error(
        err.code === 'ENOENT' ? `${this.binary} is not installed or not on PATH` : err.message,
      )));
      child.on('exit', (code) => {
        if (code === 0) finish(resolveRun);
        else finish(rejectRun, new Error(failureMessage || `${this.binary} exited with ${code}`));
      });
    });
  }

  async press(code) {
    const args = this.buildArgs(code, true);
    if (!args) throw new Error(`${this.id} cannot send ${code}`);
    if (this.held.has(code)) return;
    await this._run(args);
    this.held.add(code);
  }

  async release(code) {
    const args = this.buildArgs(code, false);
    if (!args) return;
    if (!this.held.has(code)) return;
    await this._run(args);
    this.held.delete(code);
  }

  async close() {
    await this.releaseAll().catch(() => {});
    this.opened = false;
  }
}

const PS_SEND_INPUT = String.raw`
Add-Type -Namespace Mf -Name Keys -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
public struct INPUT { public uint type; public KEYBDINPUT ki; public ulong pad1; public ulong pad2; }
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; }
'@ -PassThru | Out-Null

function Send-Key([int]$vk, [bool]$up) {
  $i = New-Object Mf.Keys+INPUT
  $i.type = 1
  $i.ki = New-Object Mf.Keys+KEYBDINPUT
  $i.ki.wVk = [uint16]$vk
  $i.ki.wScan = 0
  $i.ki.dwFlags = if ($up) { 2 } else { 0 }   # KEYEVENTF_KEYUP
  $i.ki.time = 0
  $i.ki.dwExtraInfo = [System.IntPtr]::Zero
  $arr = [Mf.Keys+INPUT[]]@($i)
  [Mf.Keys]::SendInput(1, $arr, [System.Runtime.InteropServices.Marshal]::SizeOf([type][Mf.Keys+INPUT])) | Out-Null
}

[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'quit') { break }
  $parts = $line -split ' '
  if ($parts.Count -lt 2) { continue }
  $vk = [int]$parts[1]
  Send-Key $vk ($parts[0] -eq 'up')
}
`;

/** Windows: one persistent PowerShell process exposing user32 SendInput over stdin. */
class WindowsSendInputBackend extends OsBackend {
  constructor() { super('windows-sendinput'); this.child = null; this.tmpDir = null; }

  async open() {
    if (this.opened) return;
    this.tmpDir = await mkdtemp(join(tmpdir(), 'maniaflow-'));
    const script = join(this.tmpDir, 'send-input.ps1');
    await writeFile(script, PS_SEND_INPUT, 'utf8');
    const exe = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell';
    // The helper prints `ready` once its Add-Type wrapper has compiled — that is the proof.
    this.child = await startPersistent(exe, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], { isReady: (stdout) => stdout.includes('ready'), timeoutMs: 15000 });
    this.child.on('error', () => { this.opened = false; this.child = null; this.held.clear(); });
    this.child.on('exit', () => { this.opened = false; this.child = null; this.held.clear(); });
    this.opened = true;
  }

  _command(text) {
    if (!this.opened || !this.child || !this.child.stdin?.writable) throw new Error('SendInput helper is not running');
    this.child.stdin.write(text + '\n');
  }

  async press(code) {
    const vk = toVk(code);
    if (vk == null) throw new Error(`SendInput has no virtual-key code for ${code}`);
    if (this.held.has(code)) return;
    this._command(`down ${vk}`);
    this.held.add(code);
  }

  async release(code) {
    const vk = toVk(code);
    if (vk == null || !this.held.has(code)) return;
    this._command(`up ${vk}`);
    this.held.delete(code);
  }

  async close() {
    await this.releaseAll().catch(() => {});
    if (this.child) {
      try { this.child.stdin.write('quit\n'); this.child.stdin.end(); } catch { /* already closed */ }
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    this.child = null;
    this.opened = false;
    if (this.tmpDir) { await rm(this.tmpDir, { recursive: true, force: true }).catch(() => {}); this.tmpDir = null; }
  }
}

/** Create a backend by id, or null when this machine does not offer it. */
export function createBackend(id) {
  switch (id) {
    case 'xdotool': return new XdotoolBackend();
    case 'ydotool':
      return new PerEventBackend('ydotool', 'ydotool',
        (code, down) => {
          const n = EV[code];
          return n === undefined ? null : ['key', `${n}:${down ? 1 : 0}`];
        },
        ['--help']);
    case 'cliclick':
      return new PerEventBackend('cliclick', 'cliclick',
        (code, down) => {
          const name = toCliclick(code);
          return name ? [`${down ? 'kd' : 'ku'}:${name}`] : null;
        },
        ['-V']);
    case 'windows-sendinput': return new WindowsSendInputBackend();
    default: return null;
  }
}

/** Whether a code can be sent by a given backend — used to validate lane mappings up front. */
export function canSend(backendId, code) {
  const fn = SUPPORTED[backendId];
  return typeof fn === 'function' && fn(code);
}

export { LETTERS, toX11, toVk, toCliclick, EV };
