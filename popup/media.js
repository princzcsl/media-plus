import { h, setIcon, toast, fmtTime, parseTime, throttle, send, paintRange } from './ui.js';
import { t } from '../shared/i18n.js';
import { HOST_INSTALL_URL } from '../shared/settings.js';
import { listMedia, runOp, captureFrame, bestSource, toggleTab, pickPrimary } from '../shared/tab.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const POLL_MS = 1000;

const ERRORS = {
  gone: 'errGone',
  protected: 'errProtected',
  offscreen: 'errOffscreen',
  noFrame: 'errNoFrame',
  noVideo: 'errNoVideo',
  noTracks: 'errNoTracks',
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

const segmented = (options, value, onChange) => {
  const el = h('div', { class: 'segmented', role: 'radiogroup' });
  const render = (v) => {
    el.replaceChildren(...options.map(([key, label]) =>
      h('button', { class: v === key ? 'on' : '', role: 'radio', 'aria-checked': String(v === key), onclick: () => { render(key); onChange(key); } }, label)));
  };
  render(value);
  return el;
};

export function initMedia(tab, settings, mixer, host) {
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
      items = await listMedia(tab.id, { deep: tick % 5 === 0, thumbs: wantThumbs || tick % 4 === 0 });
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

  mixer.onChange(() => { for (const card of cards.values()) card.update({}); });

  function createCard(initial) {
    let cur = initial;
    let seeking = false;
    let abStart = null;
    const card = { el: null, hasThumb: false, update };

    const thumb = h('div', { class: 'thumb', icon: initial.kind === 'audio' ? 'music' : 'video', iconSize: 20 },
      h('span', { class: 'eq-bars' }, h('i'), h('i'), h('i')));
    const title = h('div', { class: 'm-title' });
    const meta = h('div', { class: 'm-meta muted small' });
    const head = h('div', { class: 'm-head', onclick: () => card.el.classList.toggle('open') },
      thumb, h('div', { class: 'm-info' }, title, meta),
      h('span', { class: 'icon-btn ghost chevron', icon: 'chevron' }));

    async function op(name, arg) {
      try {
        const info = await runOp(tab.id, cur.frameId, cur.id, name, arg);
        if (info?.id) update({ ...info, thumb: undefined });
        return info;
      } catch (err) {
        toast(errorText(err), 'error');
        return null;
      }
    }

    // Transport
    const playBtn = h('button', { class: 'icon-btn round', title: t('playPause'), onclick: () => op('toggle') });
    const seek = h('input', { type: 'range', class: 'range', min: 0, max: 10000, step: 1, value: 0, 'aria-label': t('position') });
    const timeEl = h('span', { class: 'time small muted' });
    seek.addEventListener('pointerdown', () => { seeking = true; });
    seek.addEventListener('input', () => {
      paintRange(seek);
      shownSecond = -1;
      if (cur.duration > 0) timeEl.textContent = `${fmtTime((seek.value / 10000) * cur.duration)} / ${fmtTime(cur.duration)}`;
    });
    seek.addEventListener('change', async () => {
      if (cur.duration > 0) await op('seek', (seek.value / 10000) * cur.duration);
      seeking = false;
    });

    // Volume: 100 % (the middle) is the sound as the site plays it. The left half is the
    // media's own volume, the right half the mixer boost, up to the maximum boost.
    const muteBtn = h('button', { class: 'icon-btn ghost', title: t('mute'), onclick: () => op('mute', !cur.muted) });
    const sendVolume = throttle((v) => op('volume', v), 80);
    const volume = h('input', { type: 'range', class: 'range', min: 0, max: 1000, step: 1, 'aria-label': t('volume'), title: t('volumeHelp') });
    const volValue = h('span', { class: 'vol-value' });
    const toPercent = (pos) => (pos <= 500 ? pos / 5 : 100 + ((pos - 500) / 500) * (settings.maxBoost - 100));
    const toPos = (pct) => (pct <= 100 ? pct * 5 : 500 + ((pct - 100) / (settings.maxBoost - 100)) * 500);
    volume.addEventListener('input', () => {
      let pos = Number(volume.value);
      // Magnet: 100 % catches the thumb from a few percent away, and the thumb snaps to it.
      if (Math.abs(pos - 500) < 12) {
        pos = 500;
        volume.value = '500';
      }
      const pct = Math.round(toPercent(pos));
      if (pct <= 100) {
        sendVolume(pct / 100);
        if (mixer.getBoost() !== 100) mixer.setBoost(100);
      } else {
        if (cur.volume < 1 || cur.muted) sendVolume(1);
        mixer.setBoost(Math.round(pct / 5) * 5);
      }
      renderVolume(pct);
    });
    volume.addEventListener('dblclick', () => {
      sendVolume(1);
      mixer.setBoost(100);
      renderVolume(100);
    });
    volume.addEventListener('change', () => volume.blur());

    function renderVolume(pct) {
      if (document.activeElement !== volume) volume.value = String(Math.round(toPos(pct)));
      paintRange(volume, 500);
      volValue.textContent = `${Math.round(pct)}%`;
      volValue.classList.toggle('over', pct > 100);
    }

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
      abBtn.textContent = abStart != null && !cur.ab ? 'A…' : 'A-B';
      abBtn.classList.toggle('on', !!cur.ab || abStart != null);
    }

    // Sheets (download options, detected streams)
    const sheet = h('div', { class: 'sheet', hidden: true });
    let sheetKind = null;
    const closeSheet = () => {
      sheet.hidden = true;
      sheetKind = null;
      downloadBtn.classList.remove('open');
    };

    const action = (icon, label, fn, extra = {}) => {
      const btn = h('button', { class: ['icon-btn', extra.class], icon, title: t(label), 'aria-label': t(label) }, extra.text);
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
      if (sheetKind === 'download') return closeSheet();
      await openDownload();
    }, { class: 'dl-btn', text: t('download') });

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
      if (resolved.type !== 'url' && (resolved.streams?.length || 0) > 1) return showStreams(resolved);
      const url = bestSource(resolved);
      if (!url) return toast(t('noSource'), 'error');
      await chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
    });

    const pipBtn = action('pip', 'pip', () => op('pip'));

    // Download options: format, whole or extract, and how it will be fetched.
    async function openDownload() {
      const resolved = await runOp(tab.id, cur.frameId, cur.id, 'resolve');
      const opts = {
        format: cur.kind === 'audio' ? 'mp3' : 'mp4',
        part: cur.ab ? 'extract' : 'whole',
        start: cur.ab ? cur.ab.a : Math.max(0, cur.time - 0),
        end: cur.ab ? cur.ab.b : Math.min(cur.duration > 0 ? cur.duration : cur.time + 30, cur.time + 30)
      };

      const via = h('div', { class: 'via small muted' });
      const startInput = h('input', { class: 'input time', value: fmtTime(opts.start), 'aria-label': t('from') });
      const endInput = h('input', { class: 'input time', value: fmtTime(opts.end), 'aria-label': t('to') });
      const readTimes = () => {
        const s = parseTime(startInput.value);
        const e = parseTime(endInput.value);
        if (s != null) opts.start = s;
        if (e != null) opts.end = e;
      };
      startInput.addEventListener('change', readTimes);
      endInput.addEventListener('change', readTimes);
      const here = (input, key) => h('button', {
        class: 'icon-btn ghost', icon: 'focus', iconSize: 14, title: t('currentPosition'),
        onclick: () => { opts[key] = cur.time; input.value = fmtTime(cur.time); }
      });
      const extractRow = h('div', { class: 'range-row', hidden: opts.part !== 'extract' },
        h('span', { class: 'small muted' }, t('from')), startInput, here(startInput, 'start'),
        h('span', { class: 'small muted' }, t('to')), endInput, here(endInput, 'end'));

      const willBrowser = () => resolved.type === 'url' && opts.format === 'mp4' && opts.part === 'whole';
      const willHost = () => !willBrowser() && settings.engine !== 'browser' && host.installed;
      function renderVia() {
        if (willBrowser()) via.replaceChildren(t('viaBrowser'));
        else if (willHost()) via.replaceChildren(t('viaYtdlp'));
        else {
          via.replaceChildren(t(opts.format === 'mp3' ? 'viaRecordAudio' : 'viaRecord'));
          if (!host.installed && settings.engine !== 'browser') {
            via.append(' ', h('a', { href: HOST_INSTALL_URL, target: '_blank' }, t('installYtdlp')));
          }
        }
      }

      sheet.replaceChildren(
        segmented([['mp4', t('formatVideo')], ['mp3', t('formatAudio')]], opts.format, (v) => { opts.format = v; renderVia(); }),
        segmented([['whole', t('partWhole')], ['extract', t('partExtract')]], opts.part, (v) => {
          opts.part = v;
          extractRow.hidden = v !== 'extract';
          renderVia();
        }),
        extractRow,
        via,
        h('button', {
          class: 'button primary wide', icon: 'download', iconSize: 15,
          onclick: async () => {
            readTimes();
            const section = opts.part === 'extract';
            if (section && !(opts.end > opts.start)) return toast(t('abTooShort'), 'error');
            const res = await send({
              type: 'media:download', tabId: tab.id, frameId: cur.frameId, id: cur.id,
              format: opts.format, start: section ? opts.start : null, end: section ? opts.end : null
            }).catch((err) => ({ error: err.message }));
            if (res.error) return toast(errorText(new Error(res.error)), 'error');
            closeSheet();
            toast(t(res.via === 'record' ? 'recordStarted' : res.via === 'ytdlp' ? 'ytdlpStarted' : 'downloadStarted'));
          }
        }, t('download'))
      );
      renderVia();
      sheetKind = 'download';
      sheet.hidden = false;
      downloadBtn.classList.add('open');
      card.el.classList.add('open');
    }

    function showStreams(resolved) {
      const streams = resolved.streams || [];
      sheet.replaceChildren(
        h('div', { class: 'row space' },
          h('span', { class: 'small muted' }, t('mseSource')),
          h('button', { class: 'icon-btn ghost', icon: 'close', iconSize: 14, title: t('close'), onclick: closeSheet })),
        ...(streams.length ? streams.slice(0, 8).map((s) =>
          h('div', { class: 'stream' },
            h('span', { class: 'stream-kind' }, s.kind === 'manifest' ? (s.url.includes('.mpd') ? 'MPD' : 'M3U8') : s.kind === 'audio' ? 'AUDIO' : 'VIDEO'),
            h('span', { class: 'stream-url', title: s.url }, s.url.replace(/^https?:\/\//, '')),
            h('button', {
              class: 'icon-btn', icon: 'external', iconSize: 14, title: t('open'),
              onclick: () => chrome.tabs.create({ url: s.url, index: tab.index + 1, openerTabId: tab.id })
            }))) : [h('p', { class: 'small muted' }, t('noStreams'))])
      );
      sheetKind = 'streams';
      sheet.hidden = false;
      downloadBtn.classList.remove('open');
      card.el.classList.add('open');
    }

    const body = h('div', { class: 'm-body' },
      h('div', { class: 'm-row' }, playBtn, seek, timeEl),
      h('div', { class: 'm-row' }, muteBtn, h('div', { class: 'vol-wrap' }, volume), volValue),
      h('div', { class: 'm-row' }, h('span', { class: 'small muted' }, t('speed')), speed, h('span', { class: 'm-spacer' }), loopBtn, abBtn),
      h('div', { class: 'm-actions' }, downloadBtn, shotBtn, sourceBtn, pipBtn),
      sheet);

    card.el = h('article', { class: 'media' }, head, body);

    // Between two polls the position moves on locally, so the timeline glides.
    // anchor = position at anchorAt (Date.now()); small differences with a new reading
    // are eased in instead of jumping, big ones (seek, buffering) are applied at once.
    let anchor = initial.time || 0;
    let anchorAt = Date.now();
    let shownSecond = -1;
    const position = (now = Date.now()) =>
      cur.paused || cur.ended ? anchor : Math.min(cur.duration > 0 ? cur.duration : Infinity, anchor + ((now - anchorAt) / 1000) * (cur.rate || 1));
    function renderTime(time) {
      seek.value = String(Math.round((time / cur.duration) * 10000));
      paintRange(seek);
      const second = Math.floor(time);
      if (second !== shownSecond) {
        shownSecond = second;
        timeEl.textContent = `${fmtTime(time)} / ${fmtTime(cur.duration)}`;
      }
    }
    card.tick = () => {
      if (seeking || cur.paused || cur.ended || !(cur.duration > 0) || !card.el.classList.contains('open')) return;
      renderTime(position());
    };

    function update(m) {
      if (m.time != null) {
        const now = Date.now();
        const playing = !m.paused && !m.ended;
        const reading = m.time + (playing && m.at ? ((now - m.at) / 1000) * (m.rate || 1) : 0);
        const predicted = position(now);
        const drift = reading - predicted;
        anchor = playing && !cur.paused && Math.abs(drift) < 0.8 ? predicted + drift * (drift < 0 ? 0.04 : 0.25) : reading;
        anchorAt = now;
      }
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

      if (cur.thumb && cur.thumb !== card.thumb) {
        card.thumb = cur.thumb;
        thumb.style.backgroundImage = `url("${cur.thumb.replace(/"/g, '%22')}")`;
        thumb.classList.add('has-img');
      }
      card.hasThumb = !!card.thumb;

      setIcon(playBtn, cur.paused || cur.ended ? 'play' : 'pause', 16);
      const hasDuration = cur.duration > 0;
      seek.disabled = !hasDuration;
      if (!seeking) {
        if (hasDuration) renderTime(position());
        else {
          seek.value = '0';
          paintRange(seek);
          timeEl.textContent = cur.duration < 0 ? 'LIVE' : `${fmtTime(cur.time)}`;
          shownSecond = -1;
        }
      }

      setIcon(muteBtn, cur.muted || cur.volume === 0 ? 'volumeOff' : 'volume', 18);
      if (document.activeElement !== volume) {
        const boost = mixer.getBoost();
        renderVolume(cur.volume >= 0.995 && boost !== 100 ? boost : Math.round(cur.volume * 100));
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
    }

    return card;
  }

  // ---- yt-dlp downloads in progress ----

  const jobsEl = document.getElementById('jobs');

  function renderJobs(jobs = []) {
    jobsEl.hidden = !jobs.length;
    jobsEl.replaceChildren(...jobs.map((job) => {
      let info;
      if (job.status === 'error') info = job.error;
      else if (job.status === 'done') info = t(job.canceled ? 'jobCanceled' : 'jobDone');
      else if (job.status === 'saving') info = t('jobSaving');
      else if (job.stage) info = t('jobProcessing');
      else info = [`${Math.round(job.pct || 0)} %`, job.speed, job.eta && job.eta !== 'NA' ? job.eta : ''].filter(Boolean).join(' · ');

      const buttons = [];
      if (job.status === 'error' && job.tabId === tab.id) {
        buttons.push(h('button', {
          class: 'icon-btn ghost', icon: 'record', iconSize: 14, title: t('recordInstead'),
          onclick: async () => {
            const res = await send({ type: 'media:download', tabId: job.tabId, frameId: job.frameId, id: job.mediaId, format: job.format, start: job.start, end: job.end, forceRecord: true })
              .catch((err) => ({ error: err.message }));
            if (res.error) return toast(errorText(new Error(res.error)), 'error');
            await send({ type: 'job:dismiss', id: job.id });
            toast(t('recordStarted'));
          }
        }));
      }
      buttons.push(h('button', {
        class: 'icon-btn ghost', icon: 'close', iconSize: 14,
        title: t(job.status === 'running' ? 'cancel' : 'close'),
        onclick: () => send({ type: job.status === 'running' || job.status === 'saving' ? 'job:cancel' : 'job:dismiss', id: job.id })
      }));

      return h('div', { class: ['job', job.status] },
        h('div', { class: 'job-head' },
          h('span', { class: 'stream-kind' }, job.format === 'mp3' ? 'MP3' : 'MP4'),
          h('span', { class: 'job-title', title: job.title }, job.title),
          buttons),
        h('div', { class: 'job-bar' }, h('i', { style: `width:${job.status === 'error' ? 100 : Math.max(2, job.pct || 0)}%` })),
        h('div', { class: 'job-info small muted' }, info));
    }));
  }

  chrome.storage.session.get('jobs').then(({ jobs }) => renderJobs(jobs));
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.jobs) renderJobs(changes.jobs.newValue);
  });

  // ---- Other tabs playing sound ----

  async function refreshOthers() {
    const tabs = (await chrome.tabs.query({})).filter((x) => x.id !== tab.id && (x.audible || x.mutedInfo?.muted));
    othersEl.hidden = !tabs.length;
    otherList.replaceChildren(...tabs.map((x) => {
      let siteName = '';
      try { siteName = new URL(x.url).hostname.replace(/^www\./, ''); } catch { /* no url access */ }
      const muted = !!x.mutedInfo?.muted;
      return h('div', { class: 'other' },
        x.favIconUrl && /^(https?|data):/.test(x.favIconUrl)
          ? h('img', { src: x.favIconUrl, alt: '' })
          : h('span', { class: 'muted', icon: 'music', iconSize: 18 }),
        h('div', { class: 'other-info' },
          h('div', { class: 'other-title', title: x.title }, x.title || siteName),
          h('div', { class: 'small muted' }, siteName)),
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

  const frame = (now) => {
    if (document.visibilityState === 'visible' && !document.getElementById('view-media').hidden) {
      for (const card of cards.values()) card.tick?.(now);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
