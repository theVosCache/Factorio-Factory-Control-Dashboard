// Picks how this page talks to the companion app:
//   ipc  - inside the desktop app (preload exposes window.fcBridge)
//   rtc  - everywhere else: a phone or browser paired with the app over WebRTC
import { createIpcTransport } from './ipc.js';
import { createRtcTransport } from './rtc.js';

export function pickTransport() {
  if (window.fcBridge) return createIpcTransport(window.fcBridge);
  return createRtcTransport();
}

/** Tiny shared pieces: a tiny event hub so transports stay small. */
export function hub() {
  const subs = { state: [], tick: [], link: [] };
  return {
    on: (k) => (fn) => { subs[k].push(fn); },
    emit: (k, v) => subs[k].forEach((fn) => fn(v)),
  };
}
