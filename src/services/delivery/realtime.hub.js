/**
 * Real-time fan-out with Server-Sent Events: no extra package, works through Render's proxy, and every page also has a plain
 * polling endpoint, so a dropped stream only means "a few seconds slower", never "broken".
 *
 * Channels used by the delivery module:
 *   trk:<trackKey>   one customer following one delivery
 *   biz:<businessId> managers / owners / cashiers watching the live board (each subscriber passes a branch filter)
 *   usr:<userId>     one rider (new assignments, "you are at the customer", payment confirmed)
 *
 * NOTE: the hub lives in this process. With ONE server instance (your render.yaml) that is exact. If you ever scale to several
 * instances, pages keep working through the polling endpoints; to make the stream exact too, swap publish() for Redis pub/sub.
 */
const logger = require('../../utils/logger');

const channels = new Map();           // channel -> Set<client>
const MAX_PER_CHANNEL = 60;           // a runaway tab can never exhaust the server
const HEARTBEAT_MS = 25000;
let seq = 0;
let timer = null;

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => {
    for (const set of channels.values()) for (const c of set) { try { c.res.write(': ping\n\n'); } catch (e) { drop(c); } }
  }, HEARTBEAT_MS);
  if (timer.unref) timer.unref();
}
function drop(client) {
  const set = channels.get(client.channel);
  if (set) { set.delete(client); if (!set.size) channels.delete(client.channel); }
  try { client.res.end(); } catch (e) { /* already closed */ }
}
const write = (res, event, data) => { seq += 1; res.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

/**
 * Opens the stream on `res`. `filter(payload)` (optional) lets one subscriber see only what concerns it (a branch).
 * `hello` is sent immediately so the page can paint without waiting for the first event.
 */
function subscribe(channel, req, res, { filter, hello } = {}) {
  const set = channels.get(channel) || new Set();
  if (set.size >= MAX_PER_CHANNEL) { res.status(429).json({ success: false, message: 'Too many open live connections for this view.', code: 'STREAM_LIMIT' }); return null; }
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',      // no-transform: the compression middleware must not buffer the stream
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write('retry: 3000\n\n');
  const client = { channel, res, filter };
  set.add(client); channels.set(channel, set); ensureTimer();
  if (hello !== undefined) write(res, 'hello', hello);
  req.on('close', () => drop(client));
  return client;
}

/** Sends one event to everybody on a channel. Never throws. */
function publish(channel, event, data) {
  const set = channels.get(channel); if (!set) return 0;
  let n = 0;
  for (const c of [...set]) {
    try { if (c.filter && !c.filter(data)) continue; write(c.res, event, data); n += 1; } catch (e) { drop(c); logger.warn('SSE write failed', { channel, error: e.message }); }
  }
  return n;
}
const listeners = (channel) => (channels.get(channel) ? channels.get(channel).size : 0);
function closeAll() { for (const set of channels.values()) for (const c of [...set]) drop(c); if (timer) { clearInterval(timer); timer = null; } }

module.exports = { subscribe, publish, listeners, closeAll, ch: { track: (k) => `trk:${k}`, biz: (id) => `biz:${id}`, user: (id) => `usr:${id}` } };
