/**
 * Entry point.
 *
 * Its whole job is to start the app and to make a failure visible. A boot error that only
 * lands in the console leaves the user staring at a spinner forever, so anything thrown
 * here is written into the page instead.
 */

import { App } from './app/App.js';
import { describeError } from './utils/errors.js';

const root = document.getElementById('app');

function renderBootFailure(title, message, detail) {
  if (!root) return;
  root.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText = 'max-width:620px;margin:12vh auto;padding:24px;font:14px/1.6 system-ui,sans-serif;color:#eceef2';
  const heading = document.createElement('h1');
  heading.style.cssText = 'font-size:18px;margin:0 0 8px';
  heading.textContent = title;
  const body = document.createElement('p');
  body.style.cssText = 'margin:0 0 12px;color:#a4abb7';
  body.textContent = message;
  box.append(heading, body);
  if (detail) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'padding:12px;border-radius:8px;background:#111317;border:1px solid rgba(255,255,255,.08);overflow:auto;font-size:12px;color:#a4abb7';
    pre.textContent = detail;
    box.append(pre);
  }
  const hint = document.createElement('p');
  hint.style.cssText = 'margin:12px 0 0;color:#757d8a;font-size:12px';
  hint.textContent = 'Start ManiaFlow with "npm start" and open the address it prints. If it is already running, reload this tab.';
  box.append(hint);
  root.append(box);
}

// Anything unhandled is reported rather than left to a blank screen.
window.addEventListener('error', (event) => {
  console.error('[ManiaFlow] unhandled error', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[ManiaFlow] unhandled rejection', event.reason);
});

async function boot() {
  if (!root) {
    renderBootFailure('ManiaFlow could not start', 'The #app element is missing from the page.');
    return;
  }
  try {
    const app = new App(root);
    await app.start();
    window.__maniaflow = app;   // for diagnostics in the console; nothing in the UI depends on it
  } catch (err) {
    console.error('[ManiaFlow] boot failed', err);
    renderBootFailure('ManiaFlow could not start', describeError(err), err?.stack || null);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
