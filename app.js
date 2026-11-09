// Factory Control dashboard. Plain JS, no build step.
// Talks to the companion app through one transport (desktop IPC, WebRTC from a phone, or the dev HTTP server);
// see transports/. Every server call goes through `call()`.
import { pickTransport } from './transports/index.js';
import { decodePayload } from './shared/protocol.js';
const tp = pickTransport();
// Installed app (or ?tabs): one section at a time with a tab bar, also on wide screens.
const APP_TABS = tp.kind === 'ipc' || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  || new URLSearchParams(location.search).has('tabs');
const $ = (id) => document.getElementById(id);
// Only touch the DOM when the markup changed, so clicks and hovers survive the 2 s refresh.
const html = new Map();
function setHTML(el, markup) {
  if (html.get(el) === markup) return false;
  html.set(el, markup);
  el.innerHTML = markup;
  hydrateIcons();
  return true;
}

let data = null;
const ui = {
  surface: Number(localStorage.getItem('fc.surface')) || null,
  tab: ({ power: 'groups' })[localStorage.getItem('fc.tab')] || localStorage.getItem('fc.tab') || 'research',
  pop: null, // { kind: 'signal', key } | { kind: 'group', group }
  anchor: null,
  openNets: new Set(),
  openDepots: new Set(), // Cybersyn depot cards opened to show their trains
  shuttleMsg: null, // { text, ok, until }
  chipView: localStorage.getItem('fc.chipView') === 'icon' ? 'icon' : 'text', // remote chips: icon + text or icon only
};

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Icons come from the companion as data over the transport. icon() hands back a blob URL when we have it, or a
// blank pixel tagged with the icon key; hydrateIcons() fills those in after each render.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const iconCache = new Map(); // "type/name" -> blob URL
const iconBusy = new Set();
const iconKey = (sig) => (sig && sig.name ? `${sig.type || 'item'}/${sig.name}` : 'virtual/unknown');
const icon = (sig) => { const k = iconKey(sig); return iconCache.get(k) || `${BLANK}#ic=${esc(k)}`; };
let iconTimer = 0;
function hydrateIcons() {
  clearTimeout(iconTimer);
  iconTimer = setTimeout(async () => {
    const imgs = [...document.querySelectorAll('img[src*="#ic="]')];
    const want = [...new Set(imgs.map((i) => decodeURIComponent(i.getAttribute('src').split('#ic=')[1] || '').replace(/&amp;/g, '&')))]
      .filter((k) => k && !iconCache.has(k) && !iconBusy.has(k));
    for (let i = 0; i < want.length; i += 60) {
      const keys = want.slice(i, i + 60);
      keys.forEach((k) => iconBusy.add(k));
      try {
        const { icons } = await call('icons', { keys }, true);
        for (const [k, v] of Object.entries(icons || {})) {
          const bytes = Uint8Array.from(atob(v.b64), (c) => c.charCodeAt(0));
          iconCache.set(k, URL.createObjectURL(new Blob([bytes], { type: v.mime })));
        }
      } catch { /* retried on the next render */ }
      keys.forEach((k) => iconBusy.delete(k));
    }
    for (const img of document.querySelectorAll('img[src*="#ic="]')) {
      const k = decodeURIComponent(img.getAttribute('src').split('#ic=')[1] || '').replace(/&amp;/g, '&');
      if (iconCache.has(k)) img.src = iconCache.get(k);
    }
  }, 30);
}
const sigBox = (sig, cls = '') => `<span class="sig ${cls}"><img src="${icon(sig)}" alt="" loading="lazy"></span>`;
const pretty = (name) => String(name || '').replace(/^signal-/, '').replace(/^(se|kr)-/, '').replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const isDigit = (sig) => sig && sig.type === 'virtual' && /^signal-[0-9]$/.test(sig.name);

function surfaceIcon(s) {
  const k = s.kind || '';
  if (k === 'platform') return { type: 'item', name: 'space-platform-starter-pack' };
  if (k === 'planet' && s.planet) return { type: 'space-location', name: s.planet };
  const se = { 'se-planet': 'se-planet', 'se-moon': 'se-moon', 'se-orbit': 'se-planet-orbit', 'se-asteroid-belt': 'se-asteroid-belt',
    'se-asteroid-field': 'se-asteroid-field', 'se-spaceship': 'se-spaceship', 'se-star': 'se-star', 'se-anomaly': 'se-anomaly' };
  if (se[k]) return { type: 'virtual', name: se[k] };
  if (k.startsWith('se-')) return { type: 'virtual', name: 'se-planet' };
  return { type: 'virtual', name: 'signal-dot' };
}

function surfaceHealth(idx) {
  const st = data?.bySurface?.[idx]?.status;
  if (!st) return 'ok';
  if (st.level == null) return 'muted';
  return st.groups.some((g) => !g.empty && !g.effective_on && g.override !== 'off') ? 'warn' : 'ok';
}

// One request over the transport. Resolves to the result; with `quiet` errors don't show a toast.
async function call(method, params, quiet = false) {
  try {
    return await tp.request(method, params);
  } catch (e) {
    if (!quiet) toast(e.message, true);
    throw e;
  }
}
// The mod-style `{ ok, error }` shape the UI already handles: calls that change something never throw.
async function api(method, params, quiet = false) {
  try {
    const res = await tp.request(method, params);
    if (res && res.ok === false && !quiet) toast(res.error || 'Failed', true);
    return res;
  } catch (e) {
    if (!quiet) toast(e.message, true);
    return { ok: false, error: e.message };
  }
}
const setChange = (change) => api('set', { surface: ui.surface, ...change });

let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = bad ? 'bad' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

const tri = (value, action, extra) => `<span class="tri">${['off', 'auto', 'on'].map((v) =>
  `<button class="${value === v ? `sel-${v}` : ''}" data-act="${action}" data-value="${v}" ${extra}>${v.toUpperCase()}</button>`).join('')}</span>`;
function fmtPower(w) {
  if (w >= 1e9) return `${(w / 1e9).toFixed(2).replace(/\.?0+$/, '')} GW`;
  if (w >= 1e6) return `${(w / 1e6).toFixed(2).replace(/\.?0+$/, '')} MW`;
  if (w >= 1e3) return `${(w / 1e3).toFixed(1).replace(/\.0$/, '')} kW`;
  return `${w} W`;
}

/* ---------------- header ---------------- */
// Which optional mods are in the game. factory-control 0.3.2+ reports it; older ones are guessed from their data.
function loadedMods() {
  const m = data?.mods;
  const surfaces = data?.surfaces || [];
  return {
    cybersyn: m ? !!m.cybersyn : !!data?.cybersynAvailable || surfaces.some((s) => s.cybersyn_stops > 0),
    shuttle: m ? !!m.shuttle : surfaces.some((s) => s.entities?.pax > 0),
    repair: !!data?.repair,
  };
}
// The desktop app has room for both: one "Power" tab shows the power groups and the power plants together.
const COMBINE_POWER = tp.kind === 'ipc';

// Tabs of a mod only exist while that mod is loaded; research, plants and groups are always there.
function syncTabs() {
  $('powerTab').hidden = !COMBINE_POWER;
  $('plantsTab').hidden = COMBINE_POWER;
  $('groupsTab').hidden = COMBINE_POWER;
  if (COMBINE_POWER && (ui.tab === 'plants' || ui.tab === 'groups')) ui.tab = 'power';
  const mods = loadedMods();
  $('cyberTab').hidden = !mods.cybersyn;
  $('shuttleTab').hidden = !mods.shuttle;
  $('repairTab').hidden = !mods.repair;
  const ok = { cyber: mods.cybersyn, shuttle: mods.shuttle, repair: mods.repair };
  if (ok[ui.tab] === false) ui.tab = 'research';
}

function renderHeader() {
  syncTabs();
  const surfaces = data?.surfaces || [];
  if (!surfaces.some((s) => s.index === ui.surface)) {
    const withPower = surfaces.find((s) => s.entities && (s.entities.status || s.entities.remotes || s.entities.plants || s.entities.pax));
    ui.surface = (withPower || surfaces[0])?.index ?? null;
  }
  setHTML($('surfaceTabs'), surfaces.map((s) => `
    <button class="surface-tab ${s.index === ui.surface ? 'active' : ''}" data-act="surface" data-surface="${s.index}">
      <img src="${icon(surfaceIcon(s))}" alt="">${esc(s.display_name || s.name)}<span class="dot ${surfaceHealth(s.index)}"></span>
    </button>`).join(''));
  const sel = $('surfaceSelect');
  setHTML(sel, surfaces.map((s) => `<option value="${s.index}" ${s.index === ui.surface ? 'selected' : ''}>${esc(s.display_name || s.name)}</option>`).join(''));
  const cur = surfaces.find((s) => s.index === ui.surface);
  $('surfaceSelectIcon').src = cur ? icon(surfaceIcon(cur)) : BLANK;
  hydrateIcons();
  const updated = data?.updatedAt ? `Updated ${Math.max(0, Math.round((Date.now() - Date.parse(data.updatedAt)) / 1000))}s ago` : '';
  setHTML($('conn'), data?.connected
    ? `<span class="pill">LIVE · RCON</span><span class="updated">${updated}</span>`
    : `<span class="pill bad">OFFLINE</span>`);
  document.body.className = `tab-${ui.tab}${APP_TABS ? ' app' : ''}${data?.connected ? '' : ' readonly'}`;
}

function renderBanner() {
  const b = [];
  if (!data) b.push(link.state === 'offline' ? ['bad', `Can't reach ${esc(deviceName())}. Is the app running, and are both devices on the same Wi-Fi?${link.error ? `<br>${esc(link.error)}` : ''}`] : ['warn', 'Connecting to the companion app…']);
  else if (!data.connected) {
    b.push(['bad', `${esc(data.error || 'Not connected to Factorio.')}<br>Start Factorio, load your save via <b>Multiplayer → Host saved game</b> (RCON is on <code>127.0.0.1:27015</code>). The dashboard is read-only until then.`]);
  }
  if (data?.icons?.outdated) b.push(['warn', 'Icons are missing or out of date for your current mods. Close Factorio and use <b>Update icons</b> in the companion app.']);
  setHTML($('banner'), b.map(([c, t]) => `<div class="b ${c}">${t}</div>`).join(''));
}

/* ---------------- power ---------------- */
function groupRule(g) {
  if (g.group === 0) return 'never shed';
  if (!g.breaker) return 'never shed (breaker 0)';
  return `<span class="long">off &lt; ${g.breaker}% · on ≥ ${g.restore_at}%</span><span class="short">off&lt;${g.breaker} on≥${g.restore_at}</span>`;
}
function groupPill(g) {
  if (g.effective_on) return g.override === 'on' ? ['KEPT ON', 'accent'] : ['ON', ''];
  return g.override === 'off' ? ['KEPT OFF', 'bad'] : ['SHED', 'bad'];
}
function signalName(s) {
  const names = (s.display_names || []).filter(Boolean);
  if (names.length) return names[0] + (names.length > 1 ? ` +${names.length - 1}` : '');
  if (s.signal?.name) return pretty(s.signal.name);
  if (s.icon?.name) return '';
  const unit = s.key?.match(/^unit\/(\d+)$/)?.[1];
  return unit ? `Switch #${unit}` : 'Remote';
}
function findSignal(st, key) {
  for (const g of st.groups) for (const s of g.signals) if (s.key === key) return { g, s };
  return null;
}

function renderPower() {
  const el = $('power');
  const st = data?.bySurface?.[ui.surface]?.status;
  if (!st) {
    setHTML(el, `<div class="card empty">No power management on this surface yet.<br>Place a <b>Power grid status combinator</b>, remotes or power plant switches here.</div>`);
    return;
  }
  const shedGroups = st.groups.filter((g) => !g.empty && !g.effective_on && g.override !== 'off');
  const lvl = st.level;
  const tone = lvl == null ? 'muted' : shedGroups.length ? 'warn' : 'ok';
  const breakers = st.groups.filter((g) => g.group > 0 && g.breaker > 0 && !g.empty);
  const src = st.level_source || {};
  const maxPow = typeof src.max_power === 'number' ? src.max_power : null;
  let srcText;
  if (!src.present) srcText = 'No status combinator on this surface — nothing is shed';
  else if (!src.connected || !src.signal) srcText = 'Status combinator has no wire or no signal set — nothing is shed';
  else srcText = `from Power grid status combinator${src.inactive_count ? ` · ${src.inactive_count} inactive extra` : ''}`;
  const nextBack = shedGroups.filter((g) => g.override === 'auto').sort((a, b) => a.group - b.group)[0];

  const plantGroups = new Map();
  for (const p of st.plants || []) {
    const key = `${p.signal?.type}:${p.signal?.name}`;
    if (!plantGroups.has(key)) plantGroups.set(key, []);
    plantGroups.get(key).push(p);
  }
  const plants = [...plantGroups.values()].map((grp) => {
    const rep = grp[0];
    const v = typeof rep.value === 'number' ? Math.max(0, Math.min(100, rep.value)) : null;
    const onCount = grp.filter((p) => p.on).length;
    const total = grp.length;
    if (total === 1) {
      const p = rep;
      return `<div class="card plant">
        <div class="plant-head">${sigBox(p.icon || p.signal)}<span class="name">${esc(p.name || `Plant #${p.unit}`)}</span>
          <span class="pill ${p.on ? '' : 'muted'}">${p.on ? 'CONNECTED' : 'STANDBY'}</span></div>
        <div class="plant-gauge"><span class="val">${v == null ? '—' : `${p.value}%`}</span>
          <div class="track"><div class="fill ${p.on ? 'bg-ok' : 'bg-info'}" style="width:${v ?? 0}%"></div>
          <div class="mark" style="left:${p.disconnect_below}%"></div><div class="mark" style="left:${p.connect_above}%"></div></div></div>
        <div class="hint">Connect above ${p.connect_above}% · disconnect below ${p.disconnect_below}%</div>
      </div>`;
    }
    const pillText = onCount === total ? 'ALL CONNECTED' : onCount === 0 ? 'ALL STANDBY' : `${onCount} / ${total} ON`;
    const pillCls = onCount === total ? '' : onCount === 0 ? 'muted' : 'warn';
    return `<div class="card plant">
      <div class="plant-head">${sigBox(rep.icon || rep.signal)}<span class="name">${pretty(rep.signal?.name)} · ${total} plants</span>
        <span class="pill ${pillCls}">${pillText}</span></div>
      <div class="plant-gauge"><span class="val">${v == null ? '—' : `${rep.value}%`}</span>
        <div class="track"><div class="fill ${onCount === total ? 'bg-ok' : 'bg-info'}" style="width:${v ?? 0}%"></div>
        <div class="mark" style="left:${rep.disconnect_below}%"></div><div class="mark" style="left:${rep.connect_above}%"></div></div></div>
      <div class="hint">Connect above ${rep.connect_above}% · disconnect below ${rep.disconnect_below}%</div>
      <div class="plant-members">${[...grp].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true })).map((p) => {
        const pv = typeof p.value === 'number' ? Math.max(0, Math.min(100, p.value)) : null;
        return `<div class="plant-member">
          <span class="plant-member-name ${p.on ? '' : 'muted'}">${esc(p.name || `#${p.unit}`)}</span>
          <div class="plant-member-bar">
            <div class="track"><div class="fill ${p.on ? 'bg-ok' : 'bg-info'}" style="width:${pv ?? 0}%"></div>
            <div class="mark" style="left:${p.disconnect_below}%"></div><div class="mark" style="left:${p.connect_above}%"></div></div>
          </div>
          <span class="plant-member-val ${p.on ? '' : 'muted'}">${pv == null ? '—' : `${p.value}%`}</span>
        </div>`;
      }).join('')}</div>
    </div>`;
  }).join('');

  const rows = st.groups.filter((g) => !g.empty || g.override !== 'auto').map((g) => {
    const [pt, pc] = groupPill(g);
    const chips = g.signals.map((s) => {
      const cls = [s.override !== 'auto' ? `ov-${s.override}` : '', s.effective_on ? '' : 'off'].join(' ');
      const ov = s.override === 'on' ? '<span class="ov c-ok">ON</span>' : s.override === 'off' ? '<span class="ov c-bad">OFF</span>' : '';
      return `<button class="chip ${cls}" data-act="pop-signal" data-key="${esc(s.key)}" title="${esc(signalName(s))} ×${s.remote_count}">${sigBox(s.icon || s.signal, 'sm')}
        <span class="n">${esc(signalName(s))}</span><span class="c">×${s.remote_count}</span>${ov}</button>`;
    }).join('') || '<span class="hint">No remotes</span>';
    return `<div class="group ${g.effective_on ? '' : 'is-shed'}">
      <button class="badge" data-act="pop-group" data-group="${g.group}">${g.group}</button>
      <button class="gmeta" data-act="pop-group" data-group="${g.group}"><div class="t">Group ${g.group}</div>
        <div class="r"><span class="st ${pc ? `c-${pc}` : 'c-ok'}">${pt} · </span>${groupRule(g)}</div></button>
      <div class="gstate"><span class="pill ${pc}">${pt}</span>${tri(g.override, 'group-ov', `data-group="${g.group}"`)}</div>
      <div class="chips ${ui.chipView === 'icon' ? 'icons' : ''}">${chips}</div>
    </div>`;
  }).join('');
  const empty = st.groups.filter((g) => g.empty && g.override === 'auto').map((g) => g.group);

  setHTML(el, `
    <div class="card level-card sec-groups">
      <div><div class="label">Grid level · ${esc(data.surfaces.find((s) => s.index === ui.surface)?.display_name || '')}</div>
        <div class="level-num c-${tone}">${lvl == null ? '—' : lvl}<small>${lvl == null ? '' : '%'}</small></div></div>
      ${maxPow != null ? `<div><div class="label">Max gen</div>
        <div class="level-num" style="font-size:2rem;line-height:1.2">${fmtPower(maxPow)}</div></div>` : ''}
      <div class="gauge">
        <div class="track"><div class="fill bg-${tone}" style="width:${lvl ?? 0}%"></div>
          ${breakers.map((g) => `<div class="mark" style="left:${g.breaker}%" title="Group ${g.group} sheds below ${g.breaker}%"></div>`).join('')}</div>
        ${breakers.length ? `<div class="marks">Breakers&nbsp;&nbsp;${breakers.map((g) => `G${g.group} ${g.breaker}%`).join(' · ')}</div>` : ''}
        <div class="source">${src.signal ? sigBox(src.signal, 'sm') : ''}${srcText}</div>
      </div>
      <div class="shed">${shedGroups.length ? `<span class="pill warn">${shedGroups.length} GROUP${shedGroups.length > 1 ? 'S' : ''} SHED</span>` : '<span class="pill">ALL GROUPS ON</span>'}
        ${nextBack ? `<span class="hint">Group ${nextBack.group} returns at ${nextBack.restore_at}%</span>` : ''}</div>
    </div>
    ${plants ? `<div class="sec-plants"><div class="sec-head"><span class="title">Power plants</span><span class="hint">Self-operating · RS latch</span></div><div class="plants">${plants}</div></div>`
      : '<div class="sec-plants mobile-only card empty">No power plant switches on this surface.</div>'}
    <div class="card groups sec-groups">
      <div class="groups-head"><span class="title">Power groups</span><span class="hint">Shed 9 → 1 · restore 1 → 9 · +20% hysteresis · click a group or signal to edit</span>
        <span class="tri view">${[['text', 'ICON + TEXT'], ['icon', 'ICON']].map(([v, t]) =>
          `<button class="${ui.chipView === v ? 'sel-auto' : ''}" data-act="chip-view" data-value="${v}">${t}</button>`).join('')}</span></div>
      ${rows || '<div class="empty">No remotes on this surface yet.</div>'}
      ${empty.length ? `<div class="empty-note">Groups ${empty.join(', ')} are empty — move a signal there, or build a remote with that digit signal.</div>` : ''}
    </div>`);
}

/* ---------------- cybersyn ---------------- */
const STATE_GROUPS = {
  depot: ['in_depot'],
  moving: ['to_provider', 'to_requester', 'returning', 'to_refueler'],
  station: ['at_provider', 'at_requester', 'at_refueler'],
  tele: ['teleporting'],
};
const sumStates = (t, keys) => keys.reduce((a, k) => a + (t?.[k] || 0), 0);

function dispatcherState() {
  for (const e of Object.values(data?.bySurface || {})) if (e.cybersyn) return e.cybersyn.dispatcher_enabled;
  return null;
}
// True when the dashboard's choice differs from Cybersyn's map setting (which only Cybersyn can change).
function dispatcherOverride() {
  for (const e of Object.values(data?.bySurface || {})) if (e.cybersyn) return !!e.cybersyn.dispatcher_override;
  return false;
}

function renderCyber() {
  const el = $('cyber');
  if (!loadedMods().cybersyn) {
    setHTML(el, '');
    return;
  }
  const cy = data.bySurface?.[ui.surface]?.cybersyn;
  const disp = dispatcherState();
  const sub = dispatcherOverride()
    ? `Set from the dashboard · in-game map setting still shows ${disp ? 'off' : 'on'}`
    : 'Map setting · applies to every surface';
  const ts = cy?.totals?.train_states;
  const dispatcher = `<div class="card pad">
    <div class="disp">${sigBox({ type: 'item', name: 'cybersyn-combinator' })}
      <div class="txt"><div class="title">Cybersyn dispatcher</div><div class="hint">${sub}</div></div>
      <button class="switch ${disp ? 'on' : ''}" data-act="dispatcher" aria-label="Dispatcher"></button></div>
    ${cy ? `<div class="stats">
      <div class="stat"><div class="v">${sumStates(ts, STATE_GROUPS.depot)}</div><div class="l">In depot</div></div>
      <div class="stat"><div class="v" style="color:var(--info)">${sumStates(ts, STATE_GROUPS.moving)}</div><div class="l">Delivering</div></div>
      <div class="stat"><div class="v c-ok">${sumStates(ts, STATE_GROUPS.station)}</div><div class="l">At station</div></div>
      <div class="stat"><div class="v c-accent">${sumStates(ts, STATE_GROUPS.tele)}</div><div class="l">Elevator</div></div></div>` : ''}
  </div>`;
  if (!cy) {
    setHTML(el, dispatcher + '<div class="card empty">No Cybersyn stops on this surface.</div>');
    return;
  }
  // factory-control 0.2.9+: trains per depot, each with its pickup and drop-off.
  if (cy.depots.some((d) => d.trains)) {
    setHTML(el, dispatcher + (cy.depots.map(depotCard).join('') || '<div class="card empty">No Cybersyn depots on this surface.</div>'));
    return;
  }
  const nets = cy.networks.map((n) => {
    const tot = n.train_total || 0;
    const seg = (keys, cls) => { const v = sumStates(n.trains, keys); return v ? `<div class="${cls}" style="flex:${v}"></div>` : ''; };
    const name = n.signal ? (n.signal.type === 'virtual' && /^signal-/.test(n.signal.name) ? `Network ${pretty(n.signal.name)}` : pretty(n.signal.name)) : 'No network';
    const open = ui.openNets.has(n.network);
    const stations = open ? `<div class="stations">${n.stations.map((s) => `<div><span class="nm">${richName(s.name)}</span>
      <span class="c mono muted">×${s.count}</span>${s.provider ? '<span class="tag">P</span>' : ''}${s.requester ? '<span class="tag">R</span>' : ''}
      <span class="mono muted">${s.deliveries} open</span></div>`).join('') || '<div class="muted">No stations</div>'}</div>` : '';
    return `<div class="net">
      <button class="net-head" data-act="net" data-net="${esc(n.network)}">${n.signal ? sigBox(n.signal, 'sm') : ''}<span class="nm">${esc(name)}</span>
        <span class="mono hint">${tot} train${tot === 1 ? '' : 's'} ${open ? '▴' : '▾'}</span></button>
      <div class="bar">${seg(STATE_GROUPS.depot, 'bg-muted')}${seg(STATE_GROUPS.moving, 'bg-info')}${seg(STATE_GROUPS.station, 'bg-ok')}${seg(STATE_GROUPS.tele, 'bg-warn')}</div>
      <div class="hint">${n.providers} providers · ${n.requesters} requesters · ${n.open_deliveries} open deliveries</div>
      ${stations}
    </div>`;
  }).join('');
  const depots = cy.depots.map((d) => `<div class="depot">${sigBox({ type: 'item', name: 'train-stop' }, 'sm')}<span class="nm">${richName(d.name)}</span>
    <span class="mono ${d.waiting_trains === 0 ? 'c-warn' : 'muted'}">${d.waiting_trains} / ${d.count} waiting</span></div>`).join('');
  setHTML(el, dispatcher + `
    <div class="card pad"><div class="sec-head"><span class="title">Networks</span>
      <span class="legend"><span><i class="bg-muted"></i>depot</span><span><i class="bg-info"></i>moving</span><span><i class="bg-ok"></i>station</span></span></div>
      <div style="margin-top:12px">${nets || '<div class="hint">No networks on this surface.</div>'}</div></div>
    ${depots ? `<div class="card pad"><div class="title" style="margin-bottom:8px">Depots</div>${depots}</div>` : ''}`);
}

const CS_PILL = {
  in_depot: ['IN DEPOT', 'muted'], to_provider: ['TO PICKUP', 'info'], at_provider: ['LOADING', ''],
  to_requester: ['DELIVERING', 'info'], at_requester: ['UNLOADING', ''], returning: ['RETURNING', 'muted'],
  to_refueler: ['TO REFUEL', 'warn'], at_refueler: ['REFUELING', 'warn'], teleporting: ['ELEVATOR', 'accent'], other: ['?', 'muted'],
};
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
function trainRow(t) {
  const [pt, pc] = CS_PILL[t.state] || CS_PILL.other;
  const leg = ['to_provider', 'at_provider'].includes(t.state) ? 'p' : ['to_requester', 'at_requester'].includes(t.state) ? 'r' : '';
  const cargo = t.manifest.map((m) => `<span class="cargo"><img src="${icon(m)}" alt="" title="${esc(pretty(m.name))}">${fmtCount(m.count)}</span>`).join('');
  const route = t.provider || t.requester
    ? `<div class="route"><span class="stop ${leg === 'p' ? 'now' : ''}">${richName(t.provider || '?')}</span><span class="arrow">→</span>
        <span class="stop ${leg === 'r' ? 'now' : ''}">${richName(t.requester || '?')}</span></div>`
    : `<div class="route muted">${t.state === 'returning' ? 'Heading back to the depot' : t.state === 'in_depot' ? 'Waiting for a delivery' : ''}</div>`;
  return `<div class="cs-train ${t.state === 'in_depot' ? 'idle' : ''}">
    <div class="top"><span class="nm">${esc(t.name || `Train ${t.id}`)}</span>${cargo}<span class="pill ${pc}">${pt}</span></div>
    ${route}
  </div>`;
}
// Collapsed: an overview (state bar, counts, cargo on the move). Tap the header for the trains.
function depotCard(d) {
  const trains = d.trains || [];
  const open = ui.openDepots.has(d.name);
  const count = (keys) => trains.filter((t) => keys.includes(t.state)).length;
  const seg = (keys, cls) => { const v = count(keys); return v ? `<div class="${cls}" style="flex:${v}"></div>` : ''; };
  const parts = [[STATE_GROUPS.moving, 'on the way'], [STATE_GROUPS.station, 'at a station'], [STATE_GROUPS.tele, 'in the elevator'], [STATE_GROUPS.depot, 'in depot']]
    .map(([keys, label]) => [count(keys), label]).filter(([n]) => n).map(([n, label]) => `${n} ${label}`);
  const cargo = trains.flatMap((t) => t.manifest).map((m) => `<span class="cargo"><img src="${icon(m)}" alt="" title="${esc(pretty(m.name))}">${fmtCount(m.count)}</span>`).join('');
  return `<div class="card pad cs-depot-card">
    <button class="cs-depot-head" data-act="depot" data-depot="${esc(d.name)}" aria-expanded="${open}">
      <span class="cs-depot">${sigBox({ type: 'item', name: 'train-stop' }, 'sm')}<span class="title">${richName(d.name)}</span></span>
      <span class="mono hint">${trains.length} train${trains.length === 1 ? '' : 's'} · ${d.count} stop${d.count === 1 ? '' : 's'} ${open ? '▴' : '▾'}</span>
    </button>
    ${trains.length ? `<div class="bar" style="margin-top:12px">${seg(STATE_GROUPS.depot, 'bg-muted')}${seg(STATE_GROUPS.moving, 'bg-info')}${seg(STATE_GROUPS.station, 'bg-ok')}${seg(STATE_GROUPS.tele, 'bg-warn')}</div>
      <div class="cs-sum"><span class="hint">${parts.join(' · ')}</span>${cargo ? `<span class="cs-cargo">${cargo}</span>` : ''}</div>` : ''}
    ${open ? `<div class="cs-trains">${trains.map(trainRow).join('') || '<div class="hint">No trains from this depot.</div>'}</div>` : ''}
  </div>`;
}

/* ---------------- shuttle ---------------- */
const RICH = { item: 'item', fluid: 'fluid', 'virtual-signal': 'virtual', entity: 'entity', recipe: 'recipe', 'space-location': 'space-location', quality: 'quality' };
// "[item=iron-plate] PAX" -> icon + text
function richName(name) {
  return esc(name || '').replace(/\[([\w-]+)=([\w.\/-]+)(?:,[^\]]*)?\]/g, (m, type, n) => {
    if (type === 'img' && n.includes('/')) [type, n] = n.split('/'); // [img=item/iron-plate]
    return RICH[type] ? `<img class="ri" src="${icon({ type: RICH[type], name: n })}" alt="">` : m;
  });
}
const SHUTTLE_PILL = {
  waiting: ['WAITING', 'warn'], on_its_way: ['ON ITS WAY', 'info'], in_depot: ['IN DEPOT', 'muted'],
  in_use: ['IN USE', 'accent'], at_station: ['AT STATION', 'muted'], moving: ['MOVING', 'info'], idle: ['IDLE', 'muted'],
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function trainSub(t) {
  const at = t.station ? richName(t.station.name) : '';
  const to = t.target ? richName(t.target.name) : '';
  switch (t.state) {
    case 'waiting': return `At ${at}${t.leaves_in != null ? ` · leaves in ${mmss(t.leaves_in)}` : ''}`;
    case 'on_its_way': return `Heading to ${to}`;
    case 'in_use': return to ? `In use · heading to ${to}` : 'Someone is on board';
    case 'in_depot': case 'at_station': return at;
    case 'moving': return to ? `Heading to ${to}` : 'Moving';
    default: return 'Idle';
  }
}

function renderShuttle() {
  const el = $('shuttle');
  if (!loadedMods().shuttle) { setHTML(el, ''); return; }
  const sh = data?.bySurface?.[ui.surface]?.shuttle;
  if (!sh) {
    setHTML(el, data?.connected ? '<div class="card empty mobile-only">No pax stations on this surface yet.<br>Build a <b>Pax station</b> and give it an icon.</div>' : '');
    return;
  }
  const msg = ui.shuttleMsg && ui.shuttleMsg.until > Date.now() ? ui.shuttleMsg : null;
  const paxTile = (st) => `<button class="pax ${st.state || ''}" data-act="call" data-unit="${st.unit}" data-here="${st.state === 'here' ? 1 : ''}"
      title="${st.state === 'here' ? 'Shuttle waiting here: tap to send it back to the depot' : 'Call the nearest free shuttle here'}">
      <img src="${icon(st.icon || { type: 'item', name: 'fc-pax-station' })}" alt="">
      ${st.state ? `<span class="st">${st.state === 'here' ? 'HERE' : 'ON ITS WAY'}</span>` : ''}</button>`;
  // Pax stations sorted into the power group of the remote with the same signal; the rest go to group 0.
  const st = data?.bySurface?.[ui.surface]?.status;
  const groupOf = new Map();
  for (const g of st?.groups || []) for (const s of g.signals) {
    const sig = s.icon || s.signal;
    if (sig?.name) groupOf.set(`${sig.type || 'item'}:${sig.name}`, g.group);
  }
  const byGroup = new Map();
  for (const p of sh.stations) {
    const g = (p.icon && groupOf.get(`${p.icon.type || 'item'}:${p.icon.name}`)) ?? 0;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(p);
  }
  const groups = [...byGroup.keys()].sort((a, b) => a - b).map((g) => {
    const shed = st?.groups?.[g] && !st.groups[g].effective_on;
    return `<div class="card pad sh-group">
      <div class="sh-ghead"><span class="badge ${shed ? 'shed' : ''}">${g}</span><span class="title">${st ? `Group ${g}` : 'Pax stations'}</span>
        ${shed ? '<span class="pill bad">SHED</span>' : ''}<span class="hint">${byGroup.get(g).length} station${byGroup.get(g).length === 1 ? '' : 's'}</span></div>
      <div class="pax-grid">${byGroup.get(g).map(paxTile).join('')}</div>
    </div>`;
  }).join('');
  const trains = sh.trains.map((t) => {
    const [pt, pc] = SHUTTLE_PILL[t.state] || ['?', 'muted'];
    return `<div class="sh-tile" title="${esc(t.name)}">
      <img src="${icon({ type: 'item', name: 'locomotive' })}" alt="">
      <span class="nm">${esc(t.name)}</span>
      <span class="pill ${pc}">${pt}</span>
      <span class="sub">${trainSub(t)}</span>
    </div>`;
  }).join('');
  setHTML(el, `<div class="card pad">
    <div class="sh-head">${sigBox({ type: 'item', name: 'locomotive' })}<div class="txt"><div class="title">Shuttle</div>
      <div class="hint">${sh.available ? 'Tap a station to call a shuttle · tap a green one to send it back' : 'Shuttle Train Refresh is not installed'}</div></div></div>
    ${msg ? `<div class="sh-msg ${msg.ok ? '' : 'bad'}">${richName(msg.text)}</div>` : ''}
    ${trains ? `<div class="sh-tiles">${trains}</div>` : '<div class="hint" style="margin-top:14px">No shuttle trains on this surface. Put the shuttle equipment in a locomotive.</div>'}
  </div>
  ${groups}`);
}

/* ---------------- repair wards ---------------- */
const RW_STATE = { working: ['REPAIRING', ''], idle: ['IDLE', 'muted'], 'no-packs': ['NO PACKS', 'bad'], full: ['OUTPUT FULL', 'warn'] };
// How long the packs in the chest last when the ward keeps working at full speed (1 durability = 2 HP, scaled by its consumption).
function rwPackSeconds(w) {
  const burn = (w.hp_per_second / 2) * Math.max(0.2, 1 + (w.consumption_bonus || 0)); // durability per second
  return burn > 0 ? w.packs_durability / burn : Infinity;
}
// The repair-ward mod decides the level (map settings: low below 30 packs, critical below 10, none = empty),
// the same rule as its in-game alerts. The local rule is only for an older repair-ward without packs_level.
const RW_LEVELS = { empty: ['EMPTY', 'bad'], critical: ['CRITICAL', 'bad'], low: ['LOW', 'warn'], ok: ['OK', ''] };
function rwPackLevel(w) {
  if (w.packs_level) return RW_LEVELS[w.packs_level] || RW_LEVELS.ok;
  const rules = data?.repair?.rules || { low: 30, critical: 10 };
  if (w.packs_durability <= 0.5) return RW_LEVELS.empty;
  if (w.packs < rules.critical) return RW_LEVELS.critical;
  if (w.packs < rules.low) return RW_LEVELS.low;
  return RW_LEVELS.ok;
}
const rwRulesHint = () => { const r = data?.repair?.rules; return r ? `Low below ${r.low} packs, critical below ${r.critical}` : ''; };
const rwChip = (e) => `<span class="rw-chip" title="${esc(pretty(e.name))}${e.health < 1 ? ` · ${Math.round(e.health * 100)}% health` : ''}"><img src="${icon({ type: 'item', name: e.name })}" alt="">${fmtCount(e.count)}</span>`;

function renderRepair() {
  const el = $('repair');
  const rw = data?.repair;
  if (!rw) {
    setHTML(el, '');
    return;
  }
  const wards = rw.wards.filter((w) => w.surface === ui.surface);
  if (!wards.length) {
    setHTML(el, '<div class="card empty mobile-only">No repair wards on this surface.</div>');
    return;
  }
  const count = (lvl) => wards.filter((w) => rwPackLevel(w)[0] === lvl).length;
  const empty = count('EMPTY'), critical = count('CRITICAL'), low = count('LOW');
  const n = (k, word) => `${k} ward${k === 1 ? '' : 's'} ${word}`;
  const headline = empty ? n(empty, 'out of repair packs') : critical ? n(critical, 'critically low on repair packs') : n(low, 'low on repair packs');
  const more = [empty && (critical || low) ? `${critical + low} more running low` : '', !empty && critical && low ? `${low} more low` : ''].filter(Boolean).join('');
  const warn = empty || critical || low
    ? `<div class="card pad rw-warn ${empty || critical ? 'bad' : ''}"><b>${headline}</b>
        <span class="hint">${more ? `${more} · ` : ''}Check that repair packs are in the logistic network.</span></div>`
    : '';
  const cards = wards.map((w) => {
    const [st, stCls] = RW_STATE[w.state] || [String(w.state).toUpperCase(), 'muted'];
    const [pk, pkCls] = rwPackLevel(w);
    const j = w.job;
    const frac = j && j.total > 0 ? Math.min(1, j.done / j.total) : j ? 1 : 0;
    const secs = rwPackSeconds(w);
    const left = Number.isFinite(secs) ? (secs >= 3600 ? '>1 h' : `${mmss(Math.round(secs))}`) : '';
    return `<div class="card pad rw">
      <div class="rw-head"><button class="rw-ping" data-act="ward-ping" data-unit="${w.unit}" title="Ping this ward in the game" aria-label="Ping this ward in the game">${sigBox({ type: 'item', name: 'repair-pack' })}</button>
        <div class="txt"><div class="title">Repair ward</div><div class="hint">${Math.round(w.position.x)}, ${Math.round(w.position.y)} · ${Math.round(w.hp_per_second)} HP/s</div></div>
        <span class="pill ${stCls}">${st}</span></div>
      ${j ? `<div class="rw-job">${sigBox({ type: 'item', name: j.name })}
        <div class="rw-jbody"><div class="rw-jname">${esc(pretty(j.name))}<span class="hint">${Math.round(j.health * 100)}% health${j.quality && j.quality !== 'normal' ? ` · ${esc(j.quality)}` : ''}</span></div>
          <div class="rw-bar"><span class="fill" style="width:${Math.round(frac * 100)}%"></span></div>
          <div class="hint">${Math.round(j.done)} / ${Math.round(j.total)} HP restored</div></div></div>`
        : '<div class="hint" style="margin-top:14px">Nothing is being repaired.</div>'}
      <div class="rw-stats">
        <div><span class="k">Waiting</span><span class="v">${fmtCount(w.queue_total)}</span></div>
        <div><span class="k">In network</span><span class="v">${fmtCount(w.network_damaged)}</span></div>
        <div><span class="k">Output</span><span class="v">${fmtCount(w.output_total)}</span></div>
        <div class="rw-packs" title="${esc(rwRulesHint())}"><span class="k">Packs</span><span class="v">${w.packs}${left ? `<small>${left}</small>` : ''}<span class="pill ${pkCls}">${pk}</span></span></div>
      </div>
      ${w.queue.length ? `<div class="rw-chips" title="Waiting to be repaired">${w.queue.map(rwChip).join('')}</div>` : ''}
    </div>`;
  }).join('');
  setHTML(el, warn + cards);
}

/* ---------------- research ---------------- */
// "mining-productivity-16" at level 18 -> "Mining productivity 18"
const techName = (t) => (t.upgrade ? `${pretty(t.name.replace(/-\d+$/, ''))} ${t.level}` : pretty(t.name));
const RQ_SLOTS = 7; // the in-game research queue holds 7 technologies

function renderResearch() {
  const el = $('research');
  const rs = data?.research;
  if (!rs) {
    setHTML(el, data?.connected ? '<div class="card empty mobile-only">No research info from the game.<br>Needs <b>factory-control 0.2.8</b>: restart Factorio after updating the mod.</div>' : '');
    return;
  }
  const q = rs.queue || [];
  const tiles = q.map((t, i) => {
    const saved = i > 0 && t.progress > 0 ? `<span class="saved" style="width:${Math.round(t.progress * 100)}%"></span>` : '';
    return `<button class="rq-tile ${i === 0 && rs.current ? 'cur' : ''} ${ui.pop?.tech === t.name ? 'sel' : ''}" data-act="pop-tech" data-tech="${esc(t.name)}" title="${esc(techName(t))} · ${t.count} × ${t.unit_time}s">
      <div class="ic"><img src="${icon({ type: 'technology', name: t.name })}" alt="" loading="lazy"></div>
      ${t.upgrade ? `<span class="lvl">${t.level}</span>` : ''}
      <div class="cost">${t.ingredients.map((g) => `<img src="${icon(g)}" alt="" title="${esc(pretty(g.name))} ×${g.amount}">`).join('')}</div>${saved}
    </button>`;
  }).join('') + (q.length < RQ_SLOTS ? '<div class="rq-tile empty"></div>' : '');
  const cur = rs.current && q[0];
  const pct = cur ? Math.max(0, Math.min(100, (rs.progress || 0) * 100)) : 0;
  const now = cur ? `<div class="rq-now">
      <div class="top"><span class="nm">${esc(techName(cur))}</span><span class="pct">${pct.toFixed(1)}%</span></div>
      <div class="track"><div class="fill bg-ok" style="width:${pct}%"></div></div>
      <div class="hint">${Math.round((rs.progress || 0) * cur.count)} / ${cur.count} units · ${cur.unit_time}s per unit</div>
    </div>` : '<div class="hint" style="margin-top:14px">Nothing is being researched.</div>';
  // Available research: cheapest science first (fewest pack types), then the game's own order.
  const avail = [...(rs.available || [])].sort((a, b) => a.ingredients.length - b.ingredients.length
    || (a.order || '').localeCompare(b.order || '') || a.name.localeCompare(b.name));
  const aTile = (t) => `<button class="ra-tile ${t.after_queue ? 'later' : ''} ${ui.pop?.tech === t.name ? 'sel' : ''}" data-act="pop-tech" data-tech="${esc(t.name)}" title="${esc(techName(t))} · ${t.count} × ${t.unit_time}s">
      <div class="ic"><img src="${icon({ type: 'technology', name: t.name })}" alt="" loading="lazy"></div>
      <div class="nm">${esc(techName(t))}</div>
      <div class="cost"><div class="packs">${t.ingredients.map((g) => `<img src="${icon(g)}" alt="" title="${esc(pretty(g.name))} ×${g.amount}">`).join('')}</div>
        <span class="units">${t.count}×</span></div>
    </button>`;
  const ready = avail.filter((t) => !t.after_queue);
  const later = avail.filter((t) => t.after_queue);
  const section = (title, hint, list) => list.length ? `<div class="ra-sec"><div class="sec-head"><span class="label">${title} · ${list.length}</span>
      <span class="hint">${hint}</span></div><div class="ra-grid">${list.map(aTile).join('')}</div></div>` : '';
  setHTML(el, `<div class="card pad">
    <div class="sec-head"><span class="title">Research queue</span><span class="hint">${q.length} / ${RQ_SLOTS}</span></div>
    <div class="rq">${tiles}</div>
    ${now}
  </div>
  <div class="card pad">
    <div class="sec-head"><span class="title">Available research</span></div>
    ${section('Available now', 'all prerequisites researched', ready)}
    ${section('After the queue', 'unlocked by queued research', later)}
    ${avail.length ? '' : '<div class="hint" style="margin-top:12px">Nothing to research right now.</div>'}
  </div>`);
}

/* ---------------- factoriopedia ---------------- */
// The data is built once per mod set by the server (RCON, cached on disk) and fetched here when
// the tab is opened. Indexes are derived client side.
const pedia = { q: '', sel: null, hist: [], group: localStorage.getItem('fc.pdGroup'), loading: false, hash: null, idx: null, failed: null };
const PD_ICON = { item: 'item', fluid: 'fluid', entity: 'entity', recipe: 'recipe', tech: 'technology' };
const PD_KIND = { item: 'Item', fluid: 'Fluid', entity: 'Entity', recipe: 'Recipe', tech: 'Technology' };
const pdIcon = (kind, name) => icon({ type: PD_ICON[kind], name });
const pdFmt = (n) => (Math.round(n * 100) / 100).toString();

async function pediaLoad() {
  if (pedia.loading) return;
  pedia.loading = true; pedia.failed = null;
  try {
    pedia.idx = pediaIndex(await tp.request('pedia'));
    pedia.hash = pedia.idx.hash;
  } catch (err) { pedia.failed = err.message; }
  pedia.loading = false;
  renderPedia();
}

function pediaIndex(d) {
  const by = (list) => new Map(list.map((x) => [x.n, x]));
  const idx = { hash: d.hash, item: by(d.item), fluid: by(d.fluid), entity: by(d.entity), recipe: by(d.recipe), tech: by(d.tech) };
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  idx.madeBy = new Map(); idx.usedIn = new Map(); idx.unlockedBy = new Map(); idx.crafters = new Map();
  idx.byCat = new Map(); idx.placedBy = new Map(); idx.requiredBy = new Map();
  for (const r of d.recipe) {
    for (const o of r.o) push(idx.madeBy, o[1], r);
    for (const i of r.i) push(idx.usedIn, i[1], r);
    for (const c of r.c) push(idx.byCat, c, r);
  }
  for (const t of d.tech) {
    for (const f of t.fx) push(idx.unlockedBy, f, t);
    for (const p of t.pre) push(idx.requiredBy, p, t);
  }
  for (const e of d.entity) for (const c of e.c) push(idx.crafters, c, e);
  for (const it of d.item) if (it.p) push(idx.placedBy, it.p, it);
  // Search list: everything with a page of its own; recipes only when no item/fluid shares the name.
  idx.all = [];
  for (const kind of ['item', 'fluid', 'entity', 'tech']) for (const x of idx[kind].values()) idx.all.push({ kind, name: x.n });
  for (const r of idx.recipe.values()) if (!idx.item.has(r.n) && !idx.fluid.has(r.n)) idx.all.push({ kind: 'recipe', name: r.n });
  for (const a of idx.all) a.text = `${a.name} ${pretty(a.name)}`.toLowerCase();
  // Overview like the in-game Factoriopedia: groups (tabs) -> subgroups (rows) -> entries in game order.
  const cmp = (a, b) => String(a.ord ?? '').localeCompare(String(b.ord ?? '')) || a.n.localeCompare(b.n);
  const bySub = new Map();
  for (const a of idx.all) {
    if (a.kind === 'tech' || (a.kind === 'entity' && (idx.placedBy.has(a.name) || idx.item.has(a.name)))) continue; // entities are reached through their item
    const e = idx[a.kind].get(a.name);
    push(bySub, e.s, { kind: a.kind, name: a.name, ord: e.ord || '', n: a.name });
  }
  for (const list of bySub.values()) list.sort(cmp);
  idx.groups = [...d.group].sort(cmp).map((g) => ({
    name: g.n,
    subs: [...g.subs].sort(cmp).map((sg) => ({ name: sg.n, list: bySub.get(sg.n) || [] })).filter((sg) => sg.list.length),
  })).filter((g) => g.subs.length);
  if (d.tech.length) {
    idx.groups.push({ name: 'technology', icon: { type: 'technology', name: [...d.tech].sort(cmp)[0].n },
      subs: [{ name: 'technology', list: [...d.tech].sort(cmp).map((t) => ({ kind: 'tech', name: t.n })) }] });
  }
  return idx;
}

function pdSearch(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const a of pedia.idx.all) {
    if (!words.every((w) => a.text.includes(w))) continue;
    const shown = pretty(a.name).toLowerCase();
    out.push({ a, rank: shown === q.toLowerCase() ? 0 : shown.startsWith(words[0]) ? 1 : 2 });
  }
  const order = { item: 0, fluid: 1, entity: 2, recipe: 3, tech: 4 };
  return out.sort((x, y) => x.rank - y.rank || order[x.a.kind] - order[y.a.kind] || x.a.name.length - y.a.name.length).slice(0, 60).map((x) => x.a);
}

const pdChip = (kind, name, amount, extra = '') => `<button class="pd-chip" data-act="pedia-go" data-kind="${kind}" data-name="${esc(name)}" title="${esc(name)}">
  <img src="${pdIcon(kind, name)}" alt="" loading="lazy">${amount != null ? `<span class="n">${esc(pdFmt(amount))}×</span>` : ''}${esc(pretty(name))}${extra}</button>`;
const pdAmountChip = (a) => pdChip(a[0] === 'fluid' ? 'fluid' : 'item', a[1], a[2], a[3] ? `<span class="n">${Math.round(a[3] * 100)}%</span>` : '');

function pdRecipeCard(r) {
  const x = pedia.idx;
  const machines = [...new Map(r.c.flatMap((c) => x.crafters.get(c) || []).map((e) => [e.n, e])).values()].slice(0, 6);
  return `<div class="pd-recipe">
    <div class="grp">${r.i.map(pdAmountChip).join('') || '<span class="hint">no ingredients</span>'}</div>
    <div class="mid"><span class="arrow">→</span>${pdFmt(r.t)}s</div>
    <div class="grp">${r.o.map(pdAmountChip).join('')}</div>
    ${machines.length ? `<div class="grp" style="margin-left:auto">${machines.map((e) => `<button class="pd-chip ico" data-act="pedia-go" data-kind="entity" data-name="${esc(e.n)}" title="${esc(pretty(e.n))}"><img src="${pdIcon('entity', e.n)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
  </div>`;
}

function pdRecipes(title, list, cap = 30) {
  if (!list || !list.length) return '';
  const sorted = [...list].sort((a, b) => a.i.length - b.i.length || a.n.localeCompare(b.n));
  return `<div class="pd-sec"><span class="label">${title} · ${list.length}</span>${sorted.slice(0, cap).map(pdRecipeCard).join('')}
    ${list.length > cap ? `<div class="pd-more">+${list.length - cap} more</div>` : ''}</div>`;
}

const pdTechs = (title, techs) => techs && techs.length
  ? `<div class="pd-sec"><span class="label">${title}</span><div class="pd-chips">${[...techs].sort((a, b) => a.n.localeCompare(b.n)).map((t) => pdChip('tech', t.n)).join('')}</div></div>` : '';

const pdStat = (label, value) => `<div><span class="hint">${label}</span><b>${esc(value)}</b></div>`;

function pdPage(sel) {
  const x = pedia.idx;
  const e = x[sel.kind]?.get(sel.name);
  if (!e) return '<div class="card pad empty">Not found.</div>';
  let stats = []; let body = '';
  if (sel.kind === 'item' || sel.kind === 'fluid') {
    const unlock = new Map();
    for (const r of x.madeBy.get(e.n) || []) for (const t of x.unlockedBy.get(r.n) || []) unlock.set(t.n, t);
    if (e.k) stats.push(pdStat('Stack size', e.k));
    if (e.f) stats.push(pdStat('Fuel value', `${pdFmt(e.f / 1e6)} MJ`));
    const placed = e.p && x.entity.get(e.p);
    body = (placed ? `<div class="pd-sec"><span class="label">Places</span><div class="pd-chips">${pdChip('entity', e.p)}</div></div>` : '')
      + pdRecipes('Made by', x.madeBy.get(e.n)) + pdRecipes('Used in', x.usedIn.get(e.n)) + pdTechs('Unlocked by', [...unlock.values()]);
  } else if (sel.kind === 'entity') {
    stats = [pdStat('Type', e.y)];
    if (e.hp) stats.push(pdStat('Health', pdFmt(e.hp)));
    if (e.sp) stats.push(pdStat('Crafting speed', pdFmt(e.sp)));
    if (e.pw) stats.push(pdStat('Max power', e.pw >= 1e6 ? `${pdFmt(e.pw / 1e6)} MW` : `${pdFmt(e.pw / 1e3)} kW`));
    if (e.ms) stats.push(pdStat('Module slots', e.ms));
    const made = new Map(); const used = new Map(); const unlock = new Map();
    for (const it of e.i) {
      for (const r of x.madeBy.get(it) || []) { made.set(r.n, r); for (const t of x.unlockedBy.get(r.n) || []) unlock.set(t.n, t); }
      for (const r of x.usedIn.get(it) || []) used.set(r.n, r);
    }
    const crafts = new Map(e.c.flatMap((c) => x.byCat.get(c) || []).map((r) => [r.n, r]));
    body = (e.i.length ? `<div class="pd-sec"><span class="label">Built with</span><div class="pd-chips">${e.i.map((n) => pdChip('item', n)).join('')}</div></div>` : '')
      + pdRecipes('Made by', [...made.values()]) + pdRecipes('Used in', [...used.values()])
      + (crafts.size ? pdRecipes('Can craft', [...crafts.values()], 20) : '') + pdTechs('Unlocked by', [...unlock.values()]);
  } else if (sel.kind === 'recipe') {
    stats = [pdStat('Craft time', `${pdFmt(e.t)}s`), pdStat('Category', e.c.join(', '))];
    body = `<div class="pd-sec">${pdRecipeCard(e)}</div>` + pdTechs('Unlocked by', x.unlockedBy.get(e.n));
  } else if (sel.kind === 'tech') {
    stats = [pdStat('Cost', e.cnt ? `${e.cnt} × ${pdFmt(e.t)}s` : `formula × ${pdFmt(e.t)}s`)];
    body = `<div class="pd-sec"><span class="label">Science</span><div class="pd-chips">${e.u.map(pdAmountChip).join('')}</div></div>`
      + pdTechs('Requires', e.pre.map((n) => x.tech.get(n)).filter(Boolean))
      + pdTechs('Required by', x.requiredBy.get(e.n))
      + (e.fx.length ? `<div class="pd-sec"><span class="label">Unlocks</span>${e.fx.map((n) => x.recipe.get(n)).filter(Boolean).slice(0, 30).map(pdRecipeCard).join('')}</div>` : '');
  }
  return `<div class="card pad">
    <div class="pd-head"><button class="pd-back" data-act="pedia-back">← ${pedia.hist.length ? 'Back' : 'Overview'}</button>
      <img src="${pdIcon(sel.kind, e.n)}" alt=""><div class="t"><div class="name">${esc(pretty(e.n))}</div><div class="pd-kind">${PD_KIND[sel.kind]} · ${esc(e.n)}</div></div></div>
    ${stats.length ? `<div class="pd-stats">${stats.join('')}</div>` : ''}${body}</div>`;
}

const pdTile = (a) => `<button class="pd-tile" data-act="pedia-go" data-kind="${a.kind}" data-name="${esc(a.name)}" title="${esc(pretty(a.name))}">
  <img src="${pdIcon(a.kind, a.name)}" alt="" loading="lazy"></button>`;

function pdOverview() {
  const groups = pedia.idx.groups;
  const cur = groups.find((g) => g.name === pedia.group) || groups[0];
  const tabs = groups.map((g) => `<button class="pd-gtab ${g === cur ? 'on' : ''}" data-act="pedia-group" data-group="${esc(g.name)}" title="${esc(pretty(g.name))}">
    <img src="${icon(g.icon || { type: 'item-group', name: g.name })}" alt="" loading="lazy"></button>`).join('');
  const rows = cur.subs.map((sg) => `<div class="pd-row">${sg.list.map(pdTile).join('')}</div>`).join('');
  return `<div class="pd-groups">${tabs}</div><div class="pd-grid">${rows}</div>`;
}

function renderPedia() {
  const el = $('pedia');
  const ps = data?.pedia;
  if (!el.firstChild) {
    el.innerHTML = '<div class="card pad" id="pdTop"></div><div id="pdPage"></div>';
  }
  const top = $('pdTop');
  const status = ps?.status || 'idle';
  if (status === 'ready' && ps.hash !== pedia.hash && !pedia.loading && !pedia.failed && (ui.tab === 'pedia' || !APP_TABS)) pediaLoad();
  if (!pedia.idx) {
    const pct = Math.round((ps?.progress || 0) * 100);
    const msg = pedia.failed ? `Could not load Factoriopedia: ${esc(pedia.failed)}`
      : status === 'loading' ? `Reading Factoriopedia from the game… ${pct}%<div class="pd-bar"><span style="width:${pct}%"></span></div>`
      : status === 'unavailable' || status === 'error' ? esc(ps.error || 'Factoriopedia is unavailable.')
      : status === 'ready' ? 'Loading Factoriopedia…'
      : data?.connected ? 'Waiting for the game…' : 'Connect to Factorio once to build the Factoriopedia; it is cached afterwards.';
    setHTML(top, `<div class="sec-head"><span class="title">Factoriopedia</span></div><div class="hint" style="margin-top:10px">${msg}</div>`);
    setHTML($('pdPage'), '');
    return;
  }
  // The search box lives outside setHTML so typing and focus survive the live refresh.
  if (!$('pdQ')) {
    html.delete(top);
    top.innerHTML = `<div class="sec-head"><span class="title">Factoriopedia</span><span class="hint" id="pdCount"></span></div>
      <input class="pd-q" id="pdQ" type="search" placeholder="Search items, fluids, recipes, machines, technologies…" autocomplete="off" autocapitalize="off" spellcheck="false" style="margin-top:12px">
      <div id="pdRes"></div><div id="pdOver"></div>`;
    $('pdQ').value = pedia.q;
  }
  // An entry opens as its own screen; Back returns to the overview.
  top.hidden = !!pedia.sel;
  $('pdCount').textContent = `${pedia.idx.all.length} entries`;
  const searching = pedia.q.trim() !== '';
  const hits = searching ? pdSearch(pedia.q) : [];
  setHTML($('pdRes'), hits.length ? `<div class="pd-res">${hits.map((a) => `<button class="pd-hit" data-act="pedia-go" data-kind="${a.kind}" data-name="${esc(a.name)}">
      <span class="sig sm"><img src="${pdIcon(a.kind, a.name)}" alt="" loading="lazy"></span><span class="nm">${esc(pretty(a.name))}</span><span class="pd-kind">${PD_KIND[a.kind]}</span></button>`).join('')}</div>`
    : searching ? '<div class="hint" style="margin-top:12px">Nothing found.</div>' : '');
  setHTML($('pdOver'), searching ? '' : pdOverview());
  setHTML($('pdPage'), pedia.sel ? pdPage(pedia.sel) : '');
}

function pediaGo(sel, push = true) {
  if (push && pedia.sel) pedia.hist.push(pedia.sel);
  pedia.sel = sel || null;
  renderPedia();
  scrollTo(0, 0);
}

/* ---------------- popover ---------------- */
function renderPopover() {
  const pop = $('popover');
  const st = data?.bySurface?.[ui.surface]?.status;
  let markup = null;
  if (ui.pop && st) {
    if (ui.pop.kind === 'signal') {
      const f = findSignal(st, ui.pop.key);
      if (f) {
        const { g, s } = f;
        const state = s.effective_on ? 'ON' : 'OFF';
        markup = `<div class="pop-head">${sigBox(s.icon || s.signal)}<div class="t"><div>${esc(signalName(s))}</div>
            <div class="hint">${s.remote_count} remote${s.remote_count === 1 ? '' : 's'} · currently ${state}${s.override !== 'auto' ? ' (override)' : ''}</div></div>
            <button class="x" data-act="close" aria-label="Close">×</button></div>
          <div class="label">Power group</div>
          <div class="picker">${Array.from({ length: 10 }, (_, i) => `<button class="${i === g.group ? 'sel' : ''}" data-act="move" data-group="${i}">${i}</button>`).join('')}</div>
          <div class="label">Override</div>
          <div>${tri(s.override, 'unit-ov', '')}</div>
          <div class="note">Wins over the group override and the breaker.</div>
          <div class="label">Locate</div>
          <div class="qbtns"><button data-act="remote-ping" title="Ping ${s.remote_count === 1 ? 'this remote' : 'these remotes'} in the game, like a map ping">◎ Ping in game</button></div>`;
      }
    } else if (ui.pop.kind === 'group') {
      const g = st.groups[ui.pop.group];
      if (g) {
        const [pt, pc] = groupPill(g);
        markup = `<div class="pop-head"><span class="badge">${g.group}</span><div class="t"><div>Group ${g.group}</div>
            <div class="hint">${g.signals.length} signal${g.signals.length === 1 ? '' : 's'} · <span class="${pc ? `c-${pc}` : 'c-ok'}">${pt}</span></div></div>
            <button class="x" data-act="close" aria-label="Close">×</button></div>
          <div class="label">Breaker level</div>
          ${g.group === 0 ? '<div class="note">Group 0 is never shed automatically. You can still force it off below.</div>'
            : `<div class="breaker"><input type="range" min="0" max="100" step="1" value="${g.breaker}" data-act="breaker">
               <output>${g.breaker}%</output></div>
               <div class="note" data-breaker-note>${g.breaker ? `Off below ${g.breaker}%, back on at ${Math.min(100, g.breaker + 20)}%.` : 'Breaker 0: this group is never shed.'}</div>`}
          <div class="label">Override</div>
          <div>${tri(g.override, 'group-ov', `data-group="${g.group}"`)}</div>`;
      }
    }
  }
  if (ui.pop?.kind === 'tech') markup = techPopover();
  if (!markup) {
    pop.hidden = true;
    setHTML(pop, '');
    document.querySelector('.scrim')?.remove();
    return;
  }
  const changed = setHTML(pop, markup);
  pop.hidden = false;
  if (!document.querySelector('.scrim')) {
    const s = document.createElement('div');
    s.className = 'scrim';
    s.addEventListener('click', closePop);
    document.body.appendChild(s);
  }
  if (changed) positionPop();
}

// Popover for a research tile: move/remove a queued technology, or add an available one.
function techPopover() {
  const rs = data?.research;
  if (!rs) return null;
  const q = rs.queue || [];
  const qi = q.findIndex((t) => t.name === ui.pop.tech);
  const t = qi >= 0 ? q[qi] : (rs.available || []).find((a) => a.name === ui.pop.tech);
  if (!t) return null;
  const size = rs.queue_size || RQ_SLOTS;
  const cost = t.ingredients.map((g) => `<span class="cargo"><img src="${icon(g)}" alt="">${g.amount}</span>`).join('');
  const head = `<div class="pop-head"><span class="sig"><img src="${icon({ type: 'technology', name: t.name })}" alt=""></span>
      <div class="t"><div>${esc(techName(t))}</div><div class="hint">${t.count} units × ${t.unit_time}s</div></div>
      <button class="x" data-act="close" aria-label="Close">×</button></div>
    <div class="tech-cost">${cost}</div>`;
  if (qi >= 0) {
    const last = qi === q.length - 1;
    return `${head}
      <div class="label">Queue position ${qi + 1} of ${q.length}${qi === 0 && rs.current ? ' · researching now' : ''}</div>
      <div class="qbtns">
        <button data-act="r-move" data-dir="first" ${qi === 0 ? 'disabled' : ''}>⇤ First</button>
        <button data-act="r-move" data-dir="up" ${qi === 0 ? 'disabled' : ''}>↑ Up</button>
        <button data-act="r-move" data-dir="down" ${last ? 'disabled' : ''}>↓ Down</button>
        <button class="bad" data-act="r-remove">✕ Remove</button>
      </div>
      <div class="note">Prerequisites stay in front of what needs them. Removing also removes queued research that needs this one.</div>`;
  }
  const full = q.length >= size;
  return `${head}
    <div class="label">${t.after_queue ? 'After the queue' : 'Available now'}</div>
    <div class="qbtns">
      <button class="go" data-act="r-add" ${full ? 'disabled' : ''}>+ Add to queue</button>
      <button data-act="r-add" data-first="1" ${full ? 'disabled' : ''}>⇤ Research first</button>
    </div>
    <div class="note">${full ? `The queue is full (${q.length} / ${size}).`
      : t.after_queue ? 'Needs queued research first: “Research first” puts it right after its prerequisites.' : 'All prerequisites are researched.'}</div>`;
}

function positionPop() {
  const pop = $('popover');
  if (pop.hidden || !ui.anchor || matchMedia('(max-width: 900px)').matches) return;
  const r = ui.anchor;
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let x = Math.min(r.left, innerWidth - w - 16);
  let y = r.bottom + 8;
  if (y + h > innerHeight - 16) y = Math.max(16, r.top - h - 8);
  pop.style.left = `${Math.max(16, x)}px`;
  pop.style.top = `${y}px`;
}

function closePop() {
  ui.pop = null;
  renderPopover();
  renderResearch(); // drop the selected-tile highlight
}

/* ---------------- events ---------------- */
let breakerTimer;
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const act = t.dataset.act;
  if (act === 'surface') {
    ui.surface = Number(t.dataset.surface);
    localStorage.setItem('fc.surface', ui.surface);
    ui.pop = null;
    render();
  } else if (act === 'pop-signal' || act === 'pop-group') {
    ui.pop = act === 'pop-signal' ? { kind: 'signal', key: t.dataset.key } : { kind: 'group', group: Number(t.dataset.group) };
    ui.anchor = t.getBoundingClientRect();
    renderPopover();
  } else if (act === 'close') {
    closePop();
  } else if (act === 'group-ov') {
    await setChange({ op: 'group_override', group: Number(t.dataset.group), value: t.dataset.value });
  } else if (act === 'unit-ov' || act === 'move') {
    const st = data?.bySurface?.[ui.surface]?.status;
    const f = st && findSignal(st, ui.pop?.key);
    if (!f) return;
    if (act === 'unit-ov') await setChange({ op: 'unit_override', key: f.s.key, value: t.dataset.value });
    else await setChange({ op: 'set_unit_group', key: f.s.key, group: Number(t.dataset.group) });
  } else if (act === 'dispatcher') {
    const next = !dispatcherState();
    const res = await api('dispatcher', { enabled: next });
    if (res.ok) toast(`Cybersyn dispatcher ${next ? 'enabled' : 'paused'}`);
  } else if (act === 'call') {
    if (!data?.connected) return;
    const dismiss = t.dataset.here === '1';
    const res = await api('shuttle', { surface: ui.surface, station: Number(t.dataset.unit), dismiss }, true);
    ui.shuttleMsg = { text: res.message || res.error || (res.ok ? 'Done' : 'Failed'), ok: !!res.ok, until: Date.now() + 15000 };
    renderShuttle();
  } else if (act === 'pop-tech') {
    ui.pop = { kind: 'tech', tech: t.dataset.tech };
    ui.anchor = t.getBoundingClientRect();
    renderPopover();
    renderResearch();
  } else if (act === 'r-add' || act === 'r-move' || act === 'r-remove') {
    const tech = ui.pop?.tech;
    if (!tech) return;
    const change = act === 'r-add' ? { op: 'research_add', tech, first: t.dataset.first === '1' }
      : act === 'r-move' ? { op: 'research_move', tech, dir: t.dataset.dir } : { op: 'research_remove', tech };
    closePop(); // any button closes the popup; the result shows as a toast
    const res = await api('set', change, true);
    if (!res.ok) {
      // The mod answers with technology names ("needs automation first"): show display names.
      const rs = data?.research;
      const names = new Map([...(rs?.queue || []), ...(rs?.available || [])].map((x) => [x.name, techName(x)]));
      const msg = String(res.error || 'Failed').replace(/[\w-]+/g, (w) => names.get(w) || w);
      toast(msg.charAt(0).toUpperCase() + msg.slice(1), true);
    } else if (act === 'r-remove') {
      toast(res.also_removed ? `Removed, together with ${res.also_removed.map(pretty).join(', ')}` : 'Removed from the queue');
    } else if (act === 'r-add') toast(change.first ? 'Added to the front of the queue' : 'Added to the queue');
    else toast({ first: 'Moved to the front', up: 'Moved up', down: 'Moved down' }[change.dir] || 'Moved');
  } else if (act === 'pedia-go') {
    pediaGo({ kind: t.dataset.kind, name: t.dataset.name });
  } else if (act === 'pedia-back') {
    pediaGo(pedia.hist.pop(), false);
  } else if (act === 'pedia-group') {
    pedia.group = t.dataset.group;
    localStorage.setItem('fc.pdGroup', pedia.group);
    renderPedia();
  } else if (act === 'remote-ping') {
    if (!data?.connected) return;
    const st = data?.bySurface?.[ui.surface]?.status;
    const f = st && findSignal(st, ui.pop?.key);
    if (!f) return;
    const res = await api('set', { op: 'ping_remotes', units: f.s.remotes }, true);
    toast(res.ok ? 'Pinged in the game' : (res.error || 'Ping failed'), !res.ok);
  } else if (act === 'ward-ping') {
    if (!data?.connected) return;
    const res = await api('set', { op: 'ping_ward', unit: Number(t.dataset.unit) }, true);
    toast(res.ok ? 'Pinged in the game' : (res.error || 'Ping failed'), !res.ok);
  } else if (act === 'chip-view') {
    ui.chipView = t.dataset.value;
    localStorage.setItem('fc.chipView', ui.chipView);
    renderPower();
  } else if (act === 'depot') {
    const n = t.dataset.depot;
    if (ui.openDepots.has(n)) ui.openDepots.delete(n); else ui.openDepots.add(n);
    renderCyber();
  } else if (act === 'net') {
    const n = t.dataset.net;
    if (ui.openNets.has(n)) ui.openNets.delete(n); else ui.openNets.add(n);
    renderCyber();
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.dataset.act !== 'breaker') return;
  const v = Number(ev.target.value);
  ev.target.nextElementSibling.textContent = `${v}%`;
  const note = document.querySelector('[data-breaker-note]');
  if (note) note.textContent = v ? `Off below ${v}%, back on at ${Math.min(100, v + 20)}%.` : 'Breaker 0: this group is never shed.';
  clearTimeout(breakerTimer);
  breakerTimer = setTimeout(() => setChange({ op: 'breaker', group: ui.pop.group, value: v }), 400);
});

document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'pdQ') return;
  pedia.q = ev.target.value;
  renderPedia();
});

$('surfaceSelect').addEventListener('change', (ev) => {
  ui.surface = Number(ev.target.value);
  localStorage.setItem('fc.surface', ui.surface);
  ui.pop = null;
  render();
});
document.querySelectorAll('.mobile-tabs button').forEach((b) => b.addEventListener('click', () => {
  ui.tab = b.dataset.tab;
  localStorage.setItem('fc.tab', ui.tab);
  renderHeader();
  renderPedia();
}));
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closePop(); });
addEventListener('resize', positionPop);

/* ---------------- render + live updates ---------------- */
function render() {
  renderHeader();
  renderBanner();
  renderPower();
  renderCyber();
  renderShuttle();
  renderRepair();
  renderResearch();
  renderPedia();
  // Don't rebuild the popover while the breaker slider is being dragged.
  if (!$('popover').contains(document.activeElement) || document.activeElement.type !== 'range') renderPopover();
}

/* ---------------- connection to the companion app ---------------- */
let link = { state: 'connecting', name: '', error: '' };
const deviceName = () => (tp.kind === 'rtc' ? tp.device()?.name : '') || 'the companion app';

tp.onState((d) => { data = d; render(); });
tp.onTick?.((updatedAt) => { if (data) data.updatedAt = updatedAt; });
tp.onLink((l) => {
  link = l;
  if (l.state === 'offline') data = data ? { ...data, connected: false, error: `Lost connection to ${deviceName()}` } : null;
  renderServerBtn();
  render();
});

function renderServerBtn() {
  const btn = $('serverBtn');
  btn.hidden = tp.kind !== 'rtc';
  $('serverHost').textContent = tp.kind === 'rtc' ? (tp.device()?.name || 'Pair') : '';
  btn.title = tp.kind === 'rtc' && tp.device() ? `Paired with ${tp.device().name} (${link.state}) — tap to manage` : 'Pair with a computer';
}

/* ---------------- pairing screen (phone/browser only) ---------------- */
const defaultDeviceName = () => {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Browser';
  return os;
};

function renderPaired() {
  const d = tp.kind === 'rtc' ? tp.device() : null;
  setHTML($('recentList'), d ? `<div class="recent-h">Paired computer</div>
    <div class="recent"><button type="button" data-use="1">${esc(d.name)} <span class="muted">· ${esc(link.state)}</span></button>
    <button type="button" class="x" data-forget="1" aria-label="Forget this computer">×</button></div>` : '');
}

function showPairing(prefill = '') {
  $('linkInput').value = prefill;
  $('codeInput').value = '';
  $('nameInput').value = $('nameInput').value || defaultDeviceName();
  $('connectMsg').textContent = '';
  renderPaired();
  renderAppStatus();
  $('connectScreen').hidden = false;
  (prefill ? $('codeInput') : $('linkInput')).focus();
}

$('connectForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('connectMsg');
  const text = $('linkInput').value.trim();
  const code = $('codeInput').value.trim();
  if (!text) { msg.className = 'bad'; msg.textContent = 'Paste the pairing link, or scan the QR code with your camera.'; return; }
  try { decodePayload(text); } catch (e) { msg.className = 'bad'; msg.textContent = e.message; return; }
  if (!/^\d{6}$/.test(code)) { msg.className = 'bad'; msg.textContent = 'Type the 6-digit code shown in the app on your computer.'; return; }
  msg.className = ''; msg.textContent = 'Pairing…';
  $('connectGo').disabled = true;
  try {
    await tp.pair(text, code, $('nameInput').value.trim() || defaultDeviceName());
    msg.textContent = '';
    history.replaceState(null, '', location.pathname + location.search);
    $('connectScreen').hidden = true;
    renderServerBtn();
  } catch (e) {
    msg.className = 'bad'; msg.textContent = e.message;
  } finally { $('connectGo').disabled = false; }
});
$('recentList').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-forget]')) { tp.forget(); data = null; renderPaired(); renderServerBtn(); render(); }
  else if (ev.target.closest('[data-use]')) { $('connectScreen').hidden = true; tp.start(); }
});
$('serverBtn').addEventListener('click', () => showPairing());

/* ---------------- QR scanner (pairing screen) ---------------- */
// BarcodeDetector where the browser has it (Chrome/Android); jsQR (ui/vendor) everywhere else, e.g. iOS Safari.
// The camera needs a secure context: https or localhost.
const scan = { stream: null, raf: 0 };
function stopScan() {
  cancelAnimationFrame(scan.raf);
  scan.stream?.getTracks().forEach((t) => t.stop());
  scan.stream = null;
  $('scanVideo').srcObject = null;
  $('scanWrap').hidden = true;
}
function loadJsQr() {
  if (window.jsQR) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/jsQR.js'; s.onload = resolve; s.onerror = () => reject(new Error('Could not load the QR reader'));
    document.head.append(s);
  });
}
async function startScan() {
  const msg = $('connectMsg');
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    msg.className = 'bad';
    msg.textContent = 'The camera needs a secure (https) address. Open this app over https, or scan the QR code with your phone camera and paste the link here.';
    return;
  }
  try {
    scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) {
    msg.className = 'bad';
    msg.textContent = e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it for this site, or paste the link instead.' : `No camera available (${e.message}).`;
    return;
  }
  msg.textContent = '';
  const video = $('scanVideo');
  video.srcObject = scan.stream;
  $('scanWrap').hidden = false;
  await video.play().catch(() => {});
  const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
  if (!detector) await loadJsQr().catch((e) => { msg.className = 'bad'; msg.textContent = e.message; stopScan(); });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const found = (text) => {
    try { decodePayload(text); } catch { return false; } // some other QR code: keep looking
    stopScan();
    $('linkInput').value = text;
    $('codeInput').focus();
    return true;
  };
  const tick = async () => {
    if (!scan.stream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        if (detector) {
          for (const c of await detector.detect(video)) if (found(c.rawValue)) return;
        } else if (window.jsQR) {
          const w = 640; const h = Math.round((video.videoHeight / video.videoWidth) * w);
          canvas.width = w; canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          const hit = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
          if (hit && found(hit.data)) return;
        }
      } catch { /* a frame failed: try the next one */ }
    }
    scan.raf = requestAnimationFrame(tick);
  };
  tick();
}
$('scanBtn').addEventListener('click', startScan);
$('scanCancel').addEventListener('click', stopScan);
// A pairing link opened while the app is already running (installed app, link handed over by the browser).
addEventListener('hashchange', () => { if (tp.kind === 'rtc' && /[#&]fc=/.test(location.hash)) { stopScan(); showPairing(location.href); } });

/* ---------------- keep the screen on (Wake Lock, needs a secure origin) ---------------- */
const wake = { want: localStorage.getItem('fc.wake') === '1', lock: null };
async function applyWake() {
  if (wake.want && !wake.lock && document.visibilityState === 'visible') {
    try {
      wake.lock = await navigator.wakeLock.request('screen');
      wake.lock.addEventListener('release', () => { wake.lock = null; renderWake(); });
    } catch { wake.lock = null; }
  } else if (!wake.want && wake.lock) {
    await wake.lock.release().catch(() => {});
    wake.lock = null;
  }
  renderWake();
}
function renderWake() {
  const b = $('wakeBtn');
  b.classList.toggle('on', !!wake.lock);
  b.title = wake.lock ? 'Screen stays on — tap to allow sleep' : 'Keep the screen on';
}
if ('wakeLock' in navigator) {
  $('wakeBtn').hidden = false;
  $('wakeBtn').addEventListener('click', () => {
    wake.want = !wake.want;
    localStorage.setItem('fc.wake', wake.want ? '1' : '0');
    applyWake();
  });
  document.addEventListener('visibilitychange', applyWake);
  applyWake();
}

/* ---------------- install (PWA) ---------------- */
let installEvt = null;
const standaloneMode = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function showInstall() {
  for (const id of ['installBtn', 'installBtn2']) $(id).hidden = !installEvt;
}
addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); installEvt = ev; showInstall(); renderAppStatus(); });
addEventListener('appinstalled', () => { installEvt = null; showInstall(); renderAppStatus(); });
for (const id of ['installBtn', 'installBtn2']) {
  $(id).addEventListener('click', async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice.catch(() => {});
    installEvt = null;
    showInstall();
  });
}

// What the browser thinks of this page as an app; shown on the connect screen to see why
// Chrome does or doesn't offer to install it.
async function renderAppStatus() {
  const chrome = navigator.userAgent.match(/Chrome\/(\d+)/)?.[1];
  const reg = window.isSecureContext && 'serviceWorker' in navigator
    ? await navigator.serviceWorker.getRegistration().catch(() => null) : null;
  const rows = [
    [window.isSecureContext, 'Secure address', window.isSecureContext ? location.origin
      : `${location.origin} is not trusted. In chrome://flags/#unsafely-treat-insecure-origin-as-secure enter exactly ${location.origin}, set Enabled, Relaunch.`],
    [!!reg?.active, 'Offline support', reg?.active ? 'service worker active'
      : swError ? `service worker failed: ${swError}. Usually the certificate wasn't trusted when it loaded: force-stop Chrome and open the page again.`
        : window.isSecureContext ? 'not active yet: reload the page once' : 'needs a secure address'],
    [standaloneMode() || !!installEvt, standaloneMode() ? 'Installed' : 'Install offered',
      standaloneMode() ? 'running as an app' : installEvt ? 'tap Install as an app' : 'Chrome hasn\'t offered it yet: reload, wait a few seconds, or use ⋮ → Install app / Add to Home screen'],
    ['wakeLock' in navigator, 'Keep screen on', 'wakeLock' in navigator ? 'available' : 'needs a secure address'],
  ];
  setHTML($('appStatus'), `<div class="recent-h">App status${chrome ? ` · Chrome ${chrome}` : ''}</div>${rows.map(([ok, t, d]) =>
    `<div class="st-row"><span class="dot ${ok ? '' : 'warn'}"></span><div><b>${esc(t)}</b><div class="muted">${esc(d)}</div></div></div>`).join('')}`);
}
navigator.serviceWorker?.addEventListener?.('controllerchange', renderAppStatus);

/* ---------------- start ---------------- */
let swError = '';
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(renderAppStatus)
    .catch((e) => { swError = e.message || String(e); renderAppStatus(); });
}

(function boot() {
  renderServerBtn();
  if (tp.kind === 'ipc') { $('backBtn').hidden = false; $('backBtn').addEventListener('click', () => window.fcBridge.backToPairing()); }
  if (tp.kind !== 'rtc') { $('connectScreen').hidden = true; tp.start(); return; }
  if (/[#&]fc=/.test(location.hash)) return showPairing(location.href); // opened from the QR code
  if (tp.device()) { tp.start(); return; }
  showPairing();
}());
setInterval(renderHeader, 1000);
