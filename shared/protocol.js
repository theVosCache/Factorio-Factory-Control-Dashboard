// Shared between the companion (Node) and the PWA (browser): framing over the WebRTC data channel,
// and the pairing payload (what the QR code carries) plus the SDP the browser rebuilds from it.

export const CHUNK = 15000; // characters per data channel message; larger payloads are split

/* ---------- framing ---------- */
// A message is a JSON string. Anything longer than CHUNK is sent as `C|<id>|<i>|<n>|<piece>` frames.
export function encodeFrames(obj, msgId) {
  const text = JSON.stringify(obj);
  if (text.length <= CHUNK) return [text];
  const n = Math.ceil(text.length / CHUNK);
  const frames = [];
  for (let i = 0; i < n; i++) frames.push(`C|${msgId}|${i}|${n}|${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  return frames;
}

export class Reassembler {
  constructor() { this.parts = new Map(); }
  /** Feeds one frame; returns the decoded message when complete, otherwise null. */
  push(frame) {
    if (typeof frame !== 'string') return null;
    if (frame[0] !== 'C') return JSON.parse(frame);
    const [, id, i, n, ...rest] = frame.split('|');
    const piece = rest.join('|');
    let entry = this.parts.get(id);
    if (!entry) { entry = { n: Number(n), got: 0, pieces: [] }; this.parts.set(id, entry); }
    if (entry.pieces[Number(i)] === undefined) { entry.pieces[Number(i)] = piece; entry.got++; }
    if (entry.got < entry.n) return null;
    this.parts.delete(id);
    return JSON.parse(entry.pieces.join(''));
  }
}

/* ---------- pairing payload ---------- */
const b64u = {
  enc: (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))),
};

/** payload: { v, n: name, ip, p: port, u: ice ufrag, w: ice pwd, f: dtls fingerprint (hex, no colons) } */
export const encodePayload = (payload) => b64u.enc(JSON.stringify(payload));
export function decodePayload(text) {
  const raw = String(text).trim().replace(/^.*[#&?]fc=/, '');
  const p = JSON.parse(b64u.dec(raw));
  if (p.v !== 1 || !p.ip || !p.p || !p.u || !p.w || !p.f) throw new Error('Not a Factory Control pairing code');
  return p;
}

/** The offer SDP the companion would have sent, rebuilt from the payload (no signaling needed). */
export function payloadToOffer(p) {
  const fp = p.f.toUpperCase().match(/.{2}/g).join(':');
  return [
    'v=0', 'o=- 1 0 IN IP4 0.0.0.0', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic:WMS *',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    `a=candidate:1 1 udp 2116026367 ${p.ip} ${p.p} typ host generation 0 ufrag ${p.u}`, 'a=end-of-candidates',
    `a=ice-ufrag:${p.u}`, `a=ice-pwd:${p.w}`, 'a=ice-lite', 'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fp}`, 'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:65536', '',
  ].join('\r\n');
}
