// Phone/browser: WebRTC data channel straight to the companion app on the same network.
// The QR/link payload carries the app's address and ICE credentials; the offer is rebuilt from it
// (shared/protocol.js), answered locally, and never sent anywhere. See PLAN-companion.md.
import { hub } from './index.js';
import { decodePayload, payloadToOffer, encodeFrames, Reassembler } from '../shared/protocol.js';

const STORE = 'fc.device';
const CONNECT_TIMEOUT_MS = 9000;
const REQUEST_TIMEOUT_MS = 20000;

const loadDevice = () => { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } };
const saveDevice = (d) => { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* private mode */ } };

class Link {
  constructor(payload, h) {
    this.payload = payload; this.h = h;
    this.pending = new Map(); this.nextId = 1; this.msgId = 1;
    this.re = new Reassembler();
    this.closed = false;
    this.onClose = () => {};
  }

  /** Opens the data channel and authenticates with `first` ({auth} or {pair}). Resolves with the hello. */
  async open(first) {
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    const helloP = new Promise((resolve, reject) => { this.helloResolve = resolve; this.helloReject = reject; });
    const timer = setTimeout(() => this.helloReject(new Error("Couldn't reach the computer. Is the app running, and are both devices on the same Wi-Fi?")), CONNECT_TIMEOUT_MS);
    pc.ondatachannel = (ev) => {
      const dc = ev.channel;
      this.dc = dc;
      dc.onmessage = (m) => this.#onMessage(m.data);
      dc.onopen = () => this.#send(first);
      dc.onclose = () => this.#closed();
    };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) this.#closed(); };
    await pc.setRemoteDescription({ type: 'offer', sdp: payloadToOffer(this.payload) });
    await pc.setLocalDescription(await pc.createAnswer());
    try { return await helloP; } finally { clearTimeout(timer); }
  }

  #send(obj) { for (const f of encodeFrames(obj, this.msgId++)) this.dc.send(f); }

  #onMessage(raw) {
    const msg = this.re.push(raw);
    if (!msg) return;
    if (msg.hello) return msg.hello.ok ? this.helloResolve(msg.hello) : this.helloReject(new Error(msg.hello.error || 'Refused'));
    if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); return; }
    if (msg.ev === 'state') this.h.emit('state', msg.d);
    else if (msg.ev === 'tick') this.h.emit('tick', msg.updatedAt);
  }

  request(m, p) {
    return new Promise((resolve, reject) => {
      if (!this.dc || this.dc.readyState !== 'open') return reject(new Error('Not connected to the computer'));
      const id = this.nextId++;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('The computer did not answer')); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, (msg) => { clearTimeout(t); msg.ok ? resolve(msg.r) : reject(new Error(msg.e || 'Failed')); });
      this.#send({ id, m, p });
    });
  }

  #closed() {
    if (this.closed) return;
    this.closed = true;
    this.helloReject?.(new Error('Connection closed'));
    for (const cb of this.pending.values()) cb({ ok: false, e: 'Connection closed' });
    this.pending.clear();
    this.onClose();
  }

  close() { this.closed = true; try { this.pc?.close(); } catch { /* ignore */ } }
}

export function createRtcTransport() {
  const h = hub();
  let link = null;
  let dev = loadDevice(); // { payload (encoded), token, name }
  let retry = 0; let retryTimer = 0; let wanted = false;

  const attach = (l) => {
    link = l;
    l.onClose = () => {
      if (link !== l) return;
      link = null;
      if (!wanted) return;
      h.emit('link', { state: 'offline', name: dev?.name });
      retryTimer = setTimeout(connectStored, Math.min(8000, 1000 * 2 ** retry++));
    };
  };

  async function connectStored() {
    if (!dev || !wanted) return;
    h.emit('link', { state: 'connecting', name: dev.name });
    const l = new Link(decodePayload(dev.payload), h);
    attach(l);
    try {
      await l.open({ auth: { token: dev.token } });
      retry = 0;
      h.emit('link', { state: 'online', name: dev.name });
    } catch (e) {
      if (link === l) { l.close(); link = null; }
      if (/Not paired/.test(e.message)) { h.emit('link', { state: 'offline', name: dev.name, error: 'This device was removed in the app. Pair again.' }); return; }
      h.emit('link', { state: 'offline', name: dev.name, error: e.message });
      retryTimer = setTimeout(connectStored, Math.min(8000, 1000 * 2 ** retry++));
    }
  }

  return {
    kind: 'rtc',
    request: (m, p) => (link ? link.request(m, p) : Promise.reject(new Error('Not connected to the computer'))),
    onState: h.on('state'), onTick: h.on('tick'), onLink: h.on('link'),
    device: () => dev,
    start() { wanted = true; clearTimeout(retryTimer); retry = 0; link?.close(); link = null; connectStored(); },
    forget() { wanted = false; clearTimeout(retryTimer); link?.close(); link = null; dev = null; try { localStorage.removeItem(STORE); } catch { /* ignore */ } h.emit('link', { state: 'offline', name: '' }); },
    /** Pairs with the computer in `linkText` using the code it shows; the connection stays open as the live one. */
    async pair(linkText, code, name) {
      const payload = decodePayload(linkText);
      const encoded = linkText.trim().replace(/^.*[#&?]fc=/, '');
      clearTimeout(retryTimer);
      link?.close(); link = null;
      const l = new Link(payload, h);
      wanted = true;
      attach(l);
      let hello;
      try { hello = await l.open({ pair: { code, name } }); } catch (e) { l.close(); link = null; wanted = false; throw e; }
      dev = { payload: encoded, token: hello.token, name: hello.name || payload.n };
      saveDevice(dev);
      retry = 0;
      h.emit('link', { state: 'online', name: dev.name });
    },
  };
}
