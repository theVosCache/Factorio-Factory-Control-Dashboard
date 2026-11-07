// Desktop app: talk to the core in the main process through the preload bridge.
import { hub } from './index.js';

export function createIpcTransport(bridge) {
  const h = hub();
  bridge.onState((d) => h.emit('state', d));
  bridge.onTick?.((t) => h.emit('tick', t));
  return {
    kind: 'ipc',
    request: (m, p) => bridge.request(m, p),
    onState: h.on('state'), onTick: h.on('tick'), onLink: h.on('link'),
    start: async () => { h.emit('link', { state: 'online', name: 'this computer' }); h.emit('state', await bridge.request('state')); },
    device: () => null,
  };
}
