// Audio engine: one chain per processed tab inside a shared AudioContext.
// The service worker closes this document as soon as no tab is processed.
import { createChain, loadWorklets } from './shared/engine.js';

let ctx = null;
let ready = null;
const graphs = new Map();

// One context for every processed tab, with the pitch and limiter worklets loaded once.
async function getContext() {
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    ready = loadWorklets(ctx, chrome.runtime.getURL('shared/worklets.js'));
  }
  await ready;
  return ctx;
}

function stop(tabId) {
  const g = graphs.get(tabId);
  if (!g) return;
  graphs.delete(tabId);
  g.stream.getTracks().forEach((track) => track.stop());
  g.chain.dispose();
  if (!graphs.size && ctx) {
    ctx.close();
    ctx = null;
    ready = null;
  }
}

async function start(tabId, streamId, state) {
  if (graphs.has(tabId)) {
    graphs.get(tabId).chain.apply(state);
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });
  const ac = await getContext();
  const chain = createChain(ac, ac.createMediaStreamSource(stream));
  chain.output.connect(ac.destination);
  const g = { stream, chain };
  graphs.set(tabId, g);
  chain.apply(state);
  if (ac.state === 'suspended') await ac.resume();
  // Tab closed or capture ended elsewhere.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (graphs.get(tabId) !== g) return;
    stop(tabId);
    chrome.runtime.sendMessage({ type: 'engine:ended', tabId, remaining: graphs.size }).catch(() => {});
  });
}

const ops = {
  start: ({ tabId, streamId, state }) => start(tabId, streamId, state),
  update({ tabId, state }) {
    const g = graphs.get(tabId);
    if (!g) return { missing: true };
    g.chain.apply(state);
  },
  stop({ tabId }) {
    stop(tabId);
    return { remaining: graphs.size };
  },
  spectrum({ tabId }) {
    const g = graphs.get(tabId);
    return g ? { bars: g.chain.spectrum() } : { bars: null };
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || !ops[msg.op]) return false;
  Promise.resolve()
    .then(() => ops[msg.op](msg))
    .then((res) => sendResponse(res ?? { ok: true }), (err) => sendResponse({ error: err?.message || String(err) }));
  return true;
});
