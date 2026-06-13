// In-process event bus for Server-Sent Events. The webhook + heartbeat handlers
// broadcast a "run updated" signal after writing Mongo; the /wed/stream SSE
// endpoint forwards it to connected dashboards so they update WITHOUT polling.
//
// Single-process assumption: this works because the backend runs as one Express
// instance (a webhook hitting instance A won't reach an SSE client on instance B).
// Fine at this scale; revisit with a shared bus (Redis pub/sub) if it ever scales
// horizontally.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per connected SSE client; don't warn

function broadcast(type, data) {
  bus.emit('event', { type, data, ts: Date.now() });
}

module.exports = { bus, broadcast };
