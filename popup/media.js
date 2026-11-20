import { h, setIcon, toast, fmtTime, throttle, send } from './ui.js';
import { t } from '../shared/i18n.js';
import { listMedia, runOp, captureFrame, bestSource, toggleTab, pickPrimary } from '../shared/tab.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const POLL_MS = 1000;

export function paintRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${pct}%`);
}

const ERRORS = {
  gone: 'errGone',
  protected: 'errProtected',
  offscreen: 'errOffscreen',
  noFrame: 'errNoFrame',
  noVideo: 'errNoVideo',
  NotAllowedError: 'errGesture',
  SecurityError: 'errProtected'
};

export function errorText(err) {
  const msg = err?.message || String(err);
  const key = ERRORS[msg] || ERRORS[err?.name] || Object.entries(ERRORS).find(([k]) => msg.includes(k))?.[1];
  return key ? t(key) : `${t('errGeneric')} ${msg}`;
}

async function copyImage(dataUrl) {
  let blob = await (await fetch(dataUrl)).blob();
  if (blob.type !== 'image/png') {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    blob = await canvas.convertToBlob({ type: 'image/png' });
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

export function initMedia(tab, settings) {
  const listEl = document.getElementById('media-list');
  const othersEl = document.getElementById('others');
  const otherList = document.getElementById('other-list');
  const cards = new Map();
  let tick = 0;
  let wantThumbs = true;
  let emptyShown = null;

  function showEmpty(kind) {
    if (emptyShown === kind) return;
    emptyShown = kind;
    for (const card of cards.values()) card.el.remove();
    cards.clear();
    listEl.replaceChildren(
      h('div', { class: 'empty' },
        h('span', { icon: 'empty', iconSize: 34 }),
        h('strong', {}, t(kind === 'restricted' ? 'restricted' : 'noMedia')),
        h('span', { class: 'small' }, t(kind === 'restricted' ? 'restrictedHint' : 'noMediaHint')))
    );
  }

  async function refresh() {
    let items;
    try {
      items = await listMedia(tab.id, { deep: tick % 5 === 0, thumbs: wantThumbs });
    } catch {
      showEmpty('restricted');
      return;
    }
    tick++;
    if (!items.length) {
      showEmpty('none');
      return;
    }
    if (emptyShown) {
      listEl.replaceChildren();
      emptyShown = null;
    }

    const isFirst = cards.size === 0;
    const primary = pickPrimary(items);
    const ordered = isFirst ? [primary, ...items.filter((m) => m !== primary)] : items;
    const seen = new Set();
    wantThumbs = false;

    for (const m of ordered) {
      seen.add(m.key);
      let card = cards.get(m.key);
      if (!card) {
        card = createCard(m);
        cards.set(m.key, card);
        listEl.append(card.el);
        if (isFirst && m === primary) card.el.classList.add('open');
      }
      card.update(m);
      if (m.kind === 'video' && !card.hasThumb) wantThumbs = true;
    }
    for (const [key, card] of cards) {
      if (!seen.has(key)) {
        card.el.remove();
        cards.delete(key);
      }
    }
  }

  function createCard(initial) {
    let cur = initial;
    let seeking = false;
    let abStart = null;
    const card = { el: null, hasThumb: false, update };

    const thumb = h('div', { class: 'thumb', icon: initial.kind === 'audio' ? 'music' : 'video', iconSize: 20 },
      h('span', { class: 'eq-bars' }, h('i'), h('i'), h('i')));
    const title = h('div', { class: 'm-title' });
    const meta = h('div', { class: 'm-meta muted small' });
    const head = h('div', {
      class: 'm-head',
      onclick: () => card.el.classList.toggle('open')
    }, thumb, h('div', { class: 'm-info' }, title, meta),
    h('span', { class: 'icon-btn ghost chevron', icon: 'chevron' }));

    async function op(name, arg) {
      try {
        const info = await runOp(tab.id, cur.frameId, cur.id, name, arg);
        if (info?.id) update({ ...cur, ...info, thumb: undefined });
        return info;
      } catch (err) {
        toast(errorText(err), 'error');
        return null;
      }
    }

    // Transport
    const playBtn = h('button', { class: 'icon-btn round', title: t('playPause'), onclick: () => op('toggle') });
    const seek = h('input', { type: 'range', class: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': t('position') });
    const timeEl = h('span', { class: 'time small muted' });
    seek.addEventListener('pointerdown', () => { seeking = true; });
    seek.addEventListener('input', () => {
      paintRange(seek);
      if (cur.duration > 0) timeEl.textContent = `${fmtTime((seek.value / 1000) * cur.duration)} / ${fmtTime(cur.duration)}`;
    });
    seek.addEventListener('change', async () => {
      if (cur.duration > 0) await op('seek', (seek.value / 1000) * cur.duration);
      seeking = false;
    });

    // Volume, speed, loop
    const muteBtn = h('button', { class: 'icon-btn ghost', title: t('mute'), onclick: () => op('mute', !cur.muted) });
    const sendVolume = throttle((v) => op('volume', v), 80);
    const volume = h('input', { type: 'range', class: 'range', min: 0, max: 100, step: 1, 'aria-label': t('volume') });
    volume.addEventListener('input', () => {
      paintRange(volume);
      sendVolume(volume.value / 100);
    });
    const speed = h('select', { class: 'select compact', title: t('speed'), onchange: () => op('rate', Number(speed.value)) },
      SPEEDS.map((s) => h('option', { value: String(s) }, `${s}×`)));
    const loopBtn = h('button', { class: 'icon-btn', icon: 'loop', title: t('loop'), onclick: () => op('loop', !cur.loop) });
    const abBtn = h('button', { class: 'icon-btn text-btn', title: t('abLoop'), onclick: toggleAB });

    async function toggleAB() {
      if (cur.ab) {
        abStart = null;
        await op('ab', null);
        toast(t('abCleared'));
      } else if (abStart == null) {
        abStart = cur.time;
        toast(t('abSetA', fmtTime(abStart)));
        renderAB();
      } else {
        const range = { a: Math.min(abStart, cur.time), b: Math.max(abStart, cur.time) };
        abStart = null;
        if (range.b - range.a < 0.5) return toast(t('abTooShort'), 'error');
        await op('ab', range);
        toast(t('abSet', [fmtTime(range.a), fmtTime(range.b)]));
      }
    }

    function renderAB() {
      abBtn.textContent = cur.ab ? 'A-B' : abStart != null ? 'A…' : 'A-B';
      abBtn.classList.toggle('on', !!cur.ab || abStart != null);
    }

    // Actions
    const sheet = h('div', { class: 'sheet', hidden: true });
    const action = (icon, label, fn) => {
      const btn = h('button', { class: 'icon-btn', icon, title: t(label), 'aria-label': t(label) });
      btn.addEventListener('click', async () => {
        btn.classList.add('busy');
        try {
          await fn();
        } catch (err) {
          toast(errorText(err), 'error');
        } finally {
          btn.classList.remove('busy');
        }
      });
      return btn;
    };

    const downloadBtn = action('download', 'download', async () => {
      const res = await send({ type: 'media:download', tabId: tab.id, frameId: cur.frameId, id: cur.id });
      if (res.mse) showStreams(res, true);
      else toast(t('downloadStarted'));
    });

    const shotBtn = action('camera', 'screenshot', async () => {
      const shot = await captureFrame(tab, cur, settings.shotFormat);
      if (settings.shotAction !== 'download') await copyImage(shot.dataUrl);
      if (settings.shotAction !== 'copy') {
        await send({ type: 'shot:download', dataUrl: shot.dataUrl, format: settings.shotFormat, title: shot.title, time: shot.time, tabId: tab.id });
      }
      toast(t(settings.shotAction === 'copy' ? 'shotCopied' : 'shotSaved', `${shot.width}×${shot.height}`));
    });

    const sourceBtn = action('external', 'openSource', async () => {
      const resolved = await runOp(tab.id, cur.frameId, cur.id, 'resolve');
      if (resolved.type !== 'url' && (resolved.streams?.length || 0) > 1) return showStreams(resolved, false);
      const url = bestSource(resolved);
      if (!url) return toast(t('noSource'), 'error');
      await chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
    });

    const pipBtn = action('pip', 'pip', () => op('pip'));

    const recBtn = action('record', 'record', async () => {
      if (cur.recording) {
        await op('record', { stop: true });
        toast(t('recordSaved'));
      } else {
        const info = await op('record', {});
        if (info) toast(t('recordStarted'));
      }
    });

    const focusBtn = action('focus', 'showOnPage', () => op('focus'));

    function showStreams(resolved, fromDownload) {
      const streams = resolved.streams || [];
      const rows = streams.slice(0, 8).map((s) =>
        h('div', { class: 'stream' },
          h('span', { class: 'stream-kind' }, s.kind === 'manifest' ? (s.url.includes('.mpd') ? 'MPD' : 'M3U8') : s.kind === 'audio' ? 'AUDIO' : 'VIDEO'),
          h('span', { class: 'stream-url', title: s.url }, s.url.replace(/^https?:\/\//, '')),
          h('button', {
            class: 'icon-btn', icon: 'external', title: t('open'),
            onclick: () => chrome.tabs.create({ url: s.url, index: tab.index + 1, openerTabId: tab.id })
          }),
          s.kind !== 'manifest' && h('button', {
            class: 'icon-btn', icon: 'download', title: t('download'),
            onclick: async () => {
              const res = await send({ type: 'download', url: s.url, kind: s.kind, title: resolved.title, tabId: tab.id, pageUrl: tab.url })
                .catch((err) => ({ error: err.message }));
              toast(res.error ? errorText(new Error(res.error)) : t('downloadStarted'), res.error ? 'error' : 'info');
            }
          })));

      sheet.replaceChildren(
        h('p', { class: 'small muted' }, t(fromDownload ? 'mseDownload' : 'mseSource')),
        h('div', { class: 'row' },
          h('button', {
            class: 'button primary', icon: 'record', iconSize: 14,
            onclick: async () => {
              sheet.hidden = true;
              if (await op('record', { fromStart: true })) toast(t('recordStarted'));
            }
          }, t('recordFromStart')),
          h('button', {
            class: 'button', icon: 'record', iconSize: 14,
            onclick: async () => {
              sheet.hidden = true;
              if (await op('record', {})) toast(t('recordStarted'));
            }
          }, t('recordNow')),
          h('button', { class: 'icon-btn ghost', icon: 'close', title: t('close'), onclick: () => { sheet.hidden = true; } })),
        streams.length
          ? h('div', {}, h('div', { class: 'section-title' }, t('detectedStreams')), rows)
          : h('p', { class: 'small muted' }, t('noStreams'))
      );
      sheet.hidden = false;
      card.el.classList.add('open');
    }

    const body = h('div', { class: 'm-body' },
      h('div', { class: 'm-row' }, playBtn, seek, timeEl),
      h('div', { class: 'm-row' }, muteBtn, volume, speed, loopBtn, abBtn),
      h('div', { class: 'm-actions' }, downloadBtn, shotBtn, sourceBtn, pipBtn, recBtn, focusBtn),
      sheet);

    card.el = h('article', { class: 'media' }, head, body);

    function update(m) {
      cur = { ...cur, ...m, thumb: m.thumb ?? cur.thumb };
      card.el.classList.toggle('playing', !cur.paused);
      title.textContent = cur.title;
      title.title = cur.title;

      const parts = [t(cur.kind === 'audio' ? 'kindAudio' : 'kindVideo')];
      if (cur.width) parts.push(`${cur.width}×${cur.height}`);
      if (cur.host) parts.push(cur.host);
      meta.replaceChildren();
      if (cur.recording) meta.append(h('span', { class: 'rec-dot' }, `● REC ${fmtTime((Date.now() - cur.recording.since) / 1000)} · `));
      meta.append(parts.join(' · '));

      if (cur.thumb && !card.hasThumb) {
        thumb.style.backgroundImage = `url("${cur.thumb.replace(/"/g, '%22')}")`;
        thumb.classList.add('has-img');
        card.hasThumb = cur.thumb.startsWith('data:') || cur.kind !== 'video';
      }

      setIcon(playBtn, cur.paused || cur.ended ? 'play' : 'pause', 16);
      const hasDuration = cur.duration > 0;
      seek.disabled = !hasDuration;
      if (!seeking) {
        seek.value = hasDuration ? Math.round((cur.time / cur.duration) * 1000) : 0;
        paintRange(seek);
        timeEl.textContent = cur.duration < 0 ? 'LIVE' : `${fmtTime(cur.time)} / ${fmtTime(cur.duration)}`;
      }

      setIcon(muteBtn, cur.muted || cur.volume === 0 ? 'volumeOff' : 'volume', 18);
      if (document.activeElement !== volume) {
        volume.value = Math.round(cur.volume * 100);
        paintRange(volume);
      }

      const rate = String(cur.rate);
      if (![...speed.options].some((o) => o.value === rate)) speed.append(h('option', { value: rate }, `${cur.rate}×`));
      if (document.activeElement !== speed) speed.value = rate;

      loopBtn.classList.toggle('on', cur.loop);
      renderAB();
      pipBtn.classList.toggle('on', cur.pip);
      const isVideo = cur.kind === 'video';
      pipBtn.disabled = !isVideo;
      shotBtn.disabled = !isVideo;
      recBtn.classList.toggle('rec', !!cur.recording);
      setIcon(recBtn, cur.recording ? 'stop' : 'record', 18);
      recBtn.title = t(cur.recording ? 'recordStop' : 'record');
    }

    return card;
  }

  // ---- Other tabs playing sound ----

  async function refreshOthers() {
    const tabs = (await chrome.tabs.query({})).filter((x) => x.id !== tab.id && (x.audible || x.mutedInfo?.muted));
    othersEl.hidden = !tabs.length;
    otherList.replaceChildren(...tabs.map((x) => {
      let host = '';
      try { host = new URL(x.url).hostname.replace(/^www\./, ''); } catch { /* no url access */ }
      const muted = !!x.mutedInfo?.muted;
      return h('div', { class: 'other' },
        x.favIconUrl && /^(https?|data):/.test(x.favIconUrl)
          ? h('img', { src: x.favIconUrl, alt: '' })
          : h('span', { class: 'muted', icon: 'music', iconSize: 18 }),
        h('div', { class: 'other-info' },
          h('div', { class: 'other-title', title: x.title }, x.title || host),
          h('div', { class: 'small muted' }, host)),
        h('button', {
          class: 'icon-btn ghost', icon: x.audible ? 'pause' : 'play', iconSize: 15, title: t('playPause'),
          onclick: async () => {
            try {
              await toggleTab(x.id);
              setTimeout(refreshOthers, 300);
            } catch {
              toast(t('restricted'), 'error');
            }
          }
        }),
        h('button', {
          class: ['icon-btn', muted ? 'on' : 'ghost'], icon: muted ? 'volumeOff' : 'volume', iconSize: 16, title: t('muteTab'),
          onclick: async () => {
            await chrome.tabs.update(x.id, { muted: !muted });
            refreshOthers();
          }
        }),
        h('button', {
          class: 'icon-btn ghost', icon: 'goto', iconSize: 16, title: t('goToTab'),
          onclick: async () => {
            await chrome.tabs.update(x.id, { active: true });
            await chrome.windows.update(x.windowId, { focused: true });
          }
        }));
    }));
  }

  document.getElementById('mute-others').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ audible: true });
    await Promise.all(tabs.filter((x) => x.id !== tab.id).map((x) => chrome.tabs.update(x.id, { muted: true })));
    refreshOthers();
  });

  let timer = null;
  const loop = async () => {
    await refresh();
    if (tick % 2 === 1) await refreshOthers().catch(() => {});
    timer = setTimeout(loop, POLL_MS);
  };

  refreshOthers().catch(() => {});
  loop();
  addEventListener('pagehide', () => clearTimeout(timer));
}

