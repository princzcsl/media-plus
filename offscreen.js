// Audio engine. Each processed tab gets its own small graph inside one shared
// AudioContext: tab stream -> mono -> 10-band EQ -> balance -> boost -> limiter -> speakers.
// The document is closed by the service worker as soon as no tab is processed.
import { BANDS, BAND_Q, bandType } from './shared/audio.js';

let ctx = null;
const graphs = new Map();
const RAMP = 0.015;

function getContext() {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

function build(stream) {
  const ac = getContext();
  const source = ac.createMediaStreamSource(stream);
  const mono = ac.createGain();
  mono.channelInterpretation = 'speakers';
  const filters = BANDS.map((freq, i) => {
    const f = ac.createBiquadFilter();
    f.type = bandType(i);
    f.frequency.value = freq;
    f.Q.value = BAND_Q;
    return f;
  });
  const balance = ac.createStereoPanner();
  const gain = ac.createGain();
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.2;

  source.connect(mono);
  let node = mono;
  for (const f of filters) {
    node.connect(f);
    node = f;
  }
  node.connect(balance);
  balance.connect(gain);
  return { stream, source, mono, filters, balance, gain, limiter, limited: null };
}

function apply(g, s) {
  const now = getContext().currentTime;
  g.filters.forEach((f, i) => f.gain.setTargetAtTime(s.eq[i] || 0, now, RAMP));
  g.gain.gain.setTargetAtTime(Math.max(0, s.boost) / 100, now, RAMP);
  g.balance.pan.setTargetAtTime(Math.max(-1, Math.min(1, (s.balance || 0) / 100)), now, RAMP);
  g.mono.channelCount = s.mono ? 1 : 2;
  g.mono.channelCountMode = s.mono ? 'explicit' : 'max';

  const limited = !!s.limiter;
  if (g.limited !== limited) {
    g.gain.disconnect();
    g.limiter.disconnect();
    if (limited) {
      g.gain.connect(g.limiter);
      g.limiter.connect(getContext().destination);
    } else {
      g.gain.connect(getContext().destination);
    }
    g.limited = limited;
  }
}

function stop(tabId) {
  const g = graphs.get(tabId);
  if (!g) return;
  graphs.delete(tabId);
  g.stream.getTracks().forEach((track) => track.stop());
  for (const node of [g.source, g.mono, ...g.filters, g.balance, g.gain, g.limiter]) node.disconnect();
  if (!graphs.size && ctx) {
    ctx.close();
    ctx = null;
  }
}

async function start(tabId, streamId, state) {
  if (graphs.has(tabId)) {
    apply(graphs.get(tabId), state);
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });
  const g = build(stream);
  graphs.set(tabId, g);
  apply(g, state);
  if (ctx.state === 'suspended') await ctx.resume();
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
    apply(g, state);
  },
  stop({ tabId }) {
    stop(tabId);
    return { remaining: graphs.size };
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || !ops[msg.op]) return false;
  Promise.resolve()
    .then(() => ops[msg.op](msg))
    .then((res) => sendResponse(res ?? { ok: true }), (err) => sendResponse({ error: err?.message || String(err) }));
  return true;
});
