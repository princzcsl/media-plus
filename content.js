// Media+ agent: runs idle in every frame and only does work when the popup,
// a shortcut or the context menu asks for it through chrome.scripting.
(() => {
  'use strict';
  if (globalThis.__mediaPlus) return;

  const STREAM_RE = /\.(m3u8|mpd|mp4|m4v|m4s|m4a|webm|mov|mkv|ts|mp3|aac|ogg|oga|opus|flac|wav)(?:[?#]|$)|videoplayback|[?&]mime=(?:video|audio)/i;
  const MANIFEST_RE = /\.(m3u8|mpd)(?:[?#]|$)/i;
  const AUDIO_RE = /\.(m4a|mp3|aac|ogg|oga|opus|flac|wav)(?:[?#]|$)|[?&]mime=audio/i;
  const SKIP_INITIATORS = new Set(['script', 'link', 'css', 'img', 'image', 'iframe', 'navigation', 'beacon', 'icon']);
  const RANGE_PARAMS = ['range', 'rn', 'rbuf', 'bytestart', 'byteend'];
  const MAX_STREAMS = 30;

  // Media requests seen in this frame (CDN URLs behind blob:/MSE players).
  const streams = new Map();

  function cleanUrl(raw) {
    try {
      const url = new URL(raw);
      for (const p of RANGE_PARAMS) url.searchParams.delete(p);
      return url.href;
    } catch {
      return raw;
    }
  }

  function noteResource(entry) {
    if (SKIP_INITIATORS.has(entry.initiatorType)) return;
    const url = entry.name;
    if (!url.startsWith('http') || !STREAM_RE.test(url)) return;
    const clean = cleanUrl(url);
    streams.delete(clean);
    streams.set(clean, {
      url: clean,
      kind: MANIFEST_RE.test(clean) ? 'manifest' : AUDIO_RE.test(clean) ? 'audio' : 'video'
    });
    if (streams.size > MAX_STREAMS) streams.delete(streams.keys().next().value);
  }

  try {
    new PerformanceObserver((list) => list.getEntries().forEach(noteResource))
      .observe({ type: 'resource', buffered: true });
  } catch { /* not available in this frame */ }

  const listStreams = () => [...streams.values()].reverse();

  // Stable ids for media elements, without keeping removed ones alive.
  let nextId = 1;
  const ids = new WeakMap();
  const refs = new Map();

  function idOf(el) {
    let id = ids.get(el);
    if (!id) {
      id = nextId++;
      ids.set(el, id);
      refs.set(id, new WeakRef(el));
    }
    return id;
  }

  function byId(id) {
    const el = refs.get(id)?.deref();
    if (!el) {
      refs.delete(id);
      throw new Error('gone');
    }
    return el;
  }

  let shadowRoots = [];

  function collectShadowRoots(root, out) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.shadowRoot) {
        out.push(node.shadowRoot);
        collectShadowRoots(node.shadowRoot, out);
      }
    }
  }

  function findMedia(deep) {
    const found = new Set(document.querySelectorAll('video, audio'));
    if (deep) {
      shadowRoots = [];
      if (document.documentElement) collectShadowRoots(document.documentElement, shadowRoots);
    } else {
      shadowRoots = shadowRoots.filter((root) => root.host.isConnected);
    }
    for (const root of shadowRoots) root.querySelectorAll('video, audio').forEach((el) => found.add(el));
    // Elements we met before that left the DOM but still play (new Audio(), detached players).
    for (const ref of refs.values()) {
      const el = ref.deref();
      if (el && !el.isConnected && !el.paused) found.add(el);
    }
    return [...found].filter((el) => (el.currentSrc || el.src || el.srcObject) && relevant(el));
  }

  const audible = (el) => !el.paused && !el.muted && el.volume > 0;

  // Skips players the site keeps hidden (hover previews, preloaded next videos…)
  // unless they actually make sound.
  function relevant(el) {
    if (audible(el)) return true;
    if (el.tagName === 'AUDIO') return !el.paused || el.currentTime > 0 || el.controls;
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  }

  const kindOf = (el) => (el.tagName === 'AUDIO' || (el.readyState > 0 && !el.videoWidth) ? 'audio' : 'video');

  function titleOf(el) {
    try {
      // The page's media session describes what is playing, not every player on the page.
      const meta = navigator.mediaSession?.metadata;
      if (meta?.title && (!el.paused || el.currentTime > 0)) return meta.artist ? `${meta.artist} - ${meta.title}` : meta.title;
    } catch { /* ignore */ }
    return el.getAttribute('aria-label') || el.title || document.title || location.hostname;
  }

  const thumbs = new WeakMap();

  // Artwork the site gives for what is playing (YouTube, Spotify…), as big as a card needs.
  function artwork(el) {
    try {
      if (el.paused && !el.currentTime) return '';
      const list = navigator.mediaSession?.metadata?.artwork || [];
      const size = (a) => Number(String(a.sizes || '').split('x')[0]) || 0;
      const pick = [...list].sort((a, b) => size(a) - size(b)).find((a) => size(a) >= 160) || list[list.length - 1];
      return pick?.src || '';
    } catch {
      return '';
    }
  }

  // Thumbnail: the site's artwork, else the poster, else a frame of the video.
  // Cached per source so a playlist moving to the next video gets a new one.
  function thumbOf(el) {
    const art = artwork(el);
    if (art) return art;
    if (el.poster) return el.poster;
    const key = el.currentSrc || el.src;
    const cached = thumbs.get(el);
    if (cached && cached.key === key) return cached.thumb;
    if (el.tagName !== 'VIDEO' || !el.videoWidth || el.readyState < 2) return '';
    let thumb = '';
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = Math.max(1, Math.round((160 * el.videoHeight) / el.videoWidth));
      canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
      thumb = canvas.toDataURL('image/jpeg', 0.7);
    } catch { /* cross-origin video */ }
    thumbs.set(el, { key, thumb });
    return thumb;
  }

  const abLoops = new WeakMap();
  const recorders = new Map();

  function describe(el, withThumb = false) {
    const rect = el.getBoundingClientRect();
    const d = el.duration;
    const ab = abLoops.get(el);
    const rec = recorders.get(el);
    return {
      id: idOf(el),
      kind: kindOf(el),
      src: el.srcObject ? 'stream' : el.currentSrc || el.src || '',
      paused: el.paused,
      ended: el.ended,
      time: el.currentTime || 0,
      duration: Number.isFinite(d) ? d : d === Infinity ? -1 : 0,
      volume: el.volume,
      muted: el.muted,
      loop: el.loop,
      rate: el.playbackRate,
      pitch: el.preservesPitch !== false,
      width: el.videoWidth || 0,
      height: el.videoHeight || 0,
      area: Math.round(rect.width * rect.height),
      pip: document.pictureInPictureElement === el,
      ab: ab ? { a: ab.a, b: ab.b } : null,
      recording: rec ? { since: rec.since } : null,
      title: titleOf(el),
      host: location.hostname,
      page: location.href,
      thumb: withThumb ? thumbOf(el) : undefined
    };
  }

  // Area of the frame that actually shows the video (object-fit aware), in viewport px.
  function videoBox(el) {
    const r = el.getBoundingClientRect();
    const fit = getComputedStyle(el).objectFit;
    let w = r.width;
    let h = r.height;
    if (el.videoWidth && el.videoHeight && fit !== 'fill') {
      const ratio = el.videoWidth / el.videoHeight;
      const scale = fit === 'cover'
        ? Math.max(r.width / el.videoWidth, r.height / el.videoHeight)
        : Math.min(r.width / el.videoWidth, r.height / el.videoHeight);
      w = Math.min(r.width, el.videoHeight * scale * ratio);
      h = Math.min(r.height, el.videoHeight * scale);
    }
    const x = Math.max(0, r.left + (r.width - w) / 2);
    const y = Math.max(0, r.top + (r.height - h) / 2);
    return {
      x,
      y,
      w: Math.min(w, innerWidth - x),
      h: Math.min(h, innerHeight - y)
    };
  }

  function shot(el, { format = 'png', quality = 0.92 } = {}) {
    if (el.tagName !== 'VIDEO' || !el.videoWidth) throw new Error('noFrame');
    const canvas = document.createElement('canvas');
    canvas.width = el.videoWidth;
    canvas.height = el.videoHeight;
    canvas.getContext('2d').drawImage(el, 0, 0);
    const base = { time: el.currentTime, title: titleOf(el) };
    try {
      return { ...base, dataUrl: canvas.toDataURL(`image/${format}`, quality), width: canvas.width, height: canvas.height };
    } catch {
      // Cross-origin video without CORS: the popup crops a capture of the visible tab instead.
      if (window !== window.top) throw new Error('protected');
      const box = videoBox(el);
      if (box.w < 2 || box.h < 2) throw new Error('offscreen');
      return { ...base, tainted: true, rect: box, viewport: innerWidth };
    }
  }

  async function resolve(el) {
    const kind = kindOf(el);
    const title = titleOf(el);
    const page = location.href;
    if (el.srcObject) return { type: 'stream', kind, title, page, streams: listStreams() };
    const src = el.currentSrc || el.src || '';
    if (/^(https?|data):/i.test(src)) return { type: 'url', url: src, kind, title, page };
    if (src.startsWith('blob:')) {
      try {
        const res = await fetch(src);
        const mime = res.headers.get('content-type');
        res.body?.cancel();
        return { type: 'url', url: src, blob: true, mime, kind, title, page };
      } catch {
        // MediaSource blob: the file only exists as segments fetched from the CDN.
        return { type: 'mse', kind, title, page, streams: listStreams() };
      }
    }
    return { type: 'none', kind, title, page, streams: listStreams() };
  }

  function setAB(el, range) {
    const prev = abLoops.get(el);
    if (prev) el.removeEventListener('timeupdate', prev.fn);
    abLoops.delete(el);
    if (!range || !(range.b > range.a)) return;
    const fn = () => {
      if (el.currentTime >= range.b) el.currentTime = range.a;
    };
    abLoops.set(el, { ...range, fn });
    el.addEventListener('timeupdate', fn);
    if (el.currentTime < range.a || el.currentTime > range.b) el.currentTime = range.a;
  }

  async function pip(el) {
    if (el.tagName !== 'VIDEO') throw new Error('noVideo');
    if (document.pictureInPictureElement === el) return document.exitPictureInPicture();
    el.disablePictureInPicture = false;
    await el.requestPictureInPicture();
  }

  const MP4_TYPES = {
    video: ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'],
    audio: ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
  };

  // Tracks of a captured element show up once it plays; wait for them before recording.
  async function waitForTracks(stream, kind, el) {
    const hasAudio = () => stream.getAudioTracks().length > 0;
    const ready = () => (kind === 'audio' ? hasAudio() : stream.getVideoTracks().length > 0 && hasAudio());
    for (let i = 0; i < 20 && !ready(); i++) await new Promise((r) => setTimeout(r, 50));
  }

  const tc = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;

  // Records the media while it plays: the whole of it, from now, or a start-end extract.
  async function startRecording(el, { fromStart = false, start = null, end = null, audioOnly = false } = {}) {
    if (recorders.has(el)) return;
    const kind = audioOnly ? 'audio' : kindOf(el);
    const section = start != null && end > start;
    if (section) el.currentTime = start;
    else if (fromStart || el.ended) el.currentTime = 0;
    if (el.paused) await el.play().catch(() => {});
    // Capture after playback restarted: tracks of an ended element are already dead.
    const stream = el.captureStream();
    await waitForTracks(stream, kind, el);
    const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getTracks();
    if (!tracks.length) throw new Error('noTracks');

    const entry = { recorder: null, since: Date.now(), onEnded: () => stopRecording(el), onTime: null };
    el.addEventListener('ended', entry.onEnded);
    if (section) {
      entry.onTime = () => { if (el.currentTime >= end) stopRecording(el); };
      el.addEventListener('timeupdate', entry.onTime);
    }
    recorders.set(el, entry);
    const detach = () => {
      el.removeEventListener('ended', entry.onEnded);
      if (entry.onTime) el.removeEventListener('timeupdate', entry.onTime);
      recorders.delete(el);
    };

    // Some sources reject a given encoder setup (e.g. H.264 profile): fall back to the next type.
    const launch = (types) => {
      const mimeType = types[0];
      if (!mimeType) {
        detach();
        return;
      }
      const recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType,
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 192_000
      });
      const chunks = [];
      const started = Date.now();
      entry.recorder = recorder;
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        // Stopped on its own right after starting: the encoder refused this setup
        // (it may have flushed one frame first, and doesn't always fire "error").
        if (!entry.stopping && Date.now() - started < 3000 && recorders.get(el) === entry) {
          launch(types.slice(1));
          return;
        }
        detach();
        if (section && !el.paused) el.pause();
        const type = mimeType.split(';')[0];
        const blob = new Blob(chunks, { type });
        if (!blob.size) return;
        const ext = { 'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'audio/webm': 'weba' }[type] || 'webm';
        const suffix = section ? `${tc(start)}-${tc(end)}` : '';
        const url = URL.createObjectURL(blob);
        setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
        chrome.runtime.sendMessage({ type: 'download', url, mime: type, ext, suffix, kind, title: titleOf(el), blob: true })
          .then((res) => res?.error && saveWithAnchor(url, `${titleOf(el)}.${ext}`))
          .catch(() => saveWithAnchor(url, `recording.${ext}`));
      };
      recorder.start(1000);
    };
    launch(MP4_TYPES[kind].filter((type) => MediaRecorder.isTypeSupported(type)));
  }

  function stopRecording(el) {
    const entry = recorders.get(el);
    if (!entry) return;
    entry.stopping = true;
    if (entry.recorder?.state !== 'inactive') entry.recorder?.stop();
  }

  function saveWithAnchor(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).append(a);
    a.click();
    a.remove();
  }

  const ops = {
    toggle: (el) => (el.paused || el.ended ? el.play() : el.pause()),
    seek: (el, t) => { el.currentTime = t; },
    volume: (el, v) => {
      el.volume = Math.min(1, Math.max(0, v));
      if (v > 0) el.muted = false;
    },
    mute: (el, m) => { el.muted = !!m; },
    loop: (el, v) => { el.loop = !!v; },
    rate: (el, r) => { el.playbackRate = r; },
    pitch: (el, p) => { el.preservesPitch = !!p; },
    ab: setAB,
    pip,
    record: (el, arg) => (arg?.stop ? stopRecording(el) : startRecording(el, arg || {})),
    shot: (el, arg) => shot(el, arg || {}),
    resolve
  };

  // Pausing a whole tab from the "other tabs" list, then resuming the same media.
  const pausedByUs = new Set();

  function toggleAll() {
    const media = findMedia(false);
    const playing = media.filter((el) => !el.paused);
    if (playing.length) {
      playing.forEach((el) => { el.pause(); pausedByUs.add(new WeakRef(el)); });
      return 'paused';
    }
    for (const ref of pausedByUs) ref.deref()?.play().catch(() => {});
    pausedByUs.clear();
    return 'playing';
  }

  // Default speed / pitch for media the page starts itself.
  const prefs = { defaultSpeed: 1, preservePitch: true };
  const tuned = new WeakSet();
  try {
    chrome.storage.sync.get(['defaultSpeed', 'preservePitch']).then((s) => Object.assign(prefs, s)).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const key of Object.keys(prefs)) if (key in changes) prefs[key] = changes[key].newValue ?? (key === 'defaultSpeed' ? 1 : true);
    });
  } catch { /* extension reloaded */ }

  document.addEventListener('play', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLMediaElement) || tuned.has(el)) return;
    tuned.add(el);
    idOf(el);
    if (prefs.defaultSpeed && prefs.defaultSpeed !== 1) el.playbackRate = prefs.defaultSpeed;
    if (prefs.preservePitch === false) el.preservesPitch = false;
  }, true);

  globalThis.__mediaPlus = {
    list({ deep = false, thumbs: withThumbs = false } = {}) {
      return { media: findMedia(deep).map((el) => describe(el, withThumbs)) };
    },
    async run(id, op, arg) {
      try {
        const el = byId(id);
        if (!ops[op]) throw new Error('unknownOp');
        const out = await ops[op](el, arg);
        return out === undefined ? describe(el) : out;
      } catch (err) {
        return { error: err?.message || String(err) };
      }
    },
    findBySrc(src) {
      const el = findMedia(true).find((m) => m.currentSrc === src || m.src === src);
      return el ? idOf(el) : null;
    },
    toggleAll,
    save: saveWithAnchor
  };
})();
