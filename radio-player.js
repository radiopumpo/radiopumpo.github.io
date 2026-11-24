/**
 * RADIO PUMPO — SHARED CLOCK PLAYER v1.3
 *
 * INTEGRATION: one line in index.html before </body>:
 *   <script src="radio-player.js"></script>
 *
 * HOW IT WORKS
 * Every listener shares the same UTC clock. The manifest defines a 24-hour
 * sequence; on "Tune In" the player works out which item is playing right now
 * and at what position, then seeks to it.
 *
 * v1.2 CHANGES
 * - A file that fails to load (404, corrupt, unsupported) is skipped instead of
 *   leaving dead air. It is left out of the sequence for 10 minutes, then given
 *   another chance (so a brief connection drop or a file you upload later
 *   heals itself). If too many files fail in a row the radio hands back to the
 *   on-demand player rather than looping.
 * - Show handover (06:00 / 12:00 / 19:00 UTC) rewritten as one small state
 *   machine. v1.1 had a race where the generic "track ended" handler overwrote
 *   the outro/intro a split second after it started, so they were cut off.
 *
 * v1.3: volume control (slider + mute) in the bar. One volume is shared by radio mode and
 *       the on-demand player and remembered between visits. iOS Safari does not let web
 *       pages set the volume (the hardware buttons do), so there you get a mute button only.
 *
 * OPTION 1 UPGRADE: set STREAM_URL to your Icecast mount URL.
 */

(function () {

  // ── CONFIG ────────────────────────────────────────────────────────────────
  const MANIFEST_URL = '/radio-manifest.json';
  const STREAM_URL   = null;   // set to an Icecast URL when upgrading to Option 1
  const MAX_FAILS    = 6;      // consecutive unplayable files before giving up
  const OUTRO_FOR    = { afternoons: 'breakfast', latenight: 'afternoons', breakfast: 'latenight' };

  // ── STATE ─────────────────────────────────────────────────────────────────
  let manifest = null, radioAudio = null, isRadioMode = false, sequence = null;
  let syncTimer = null, transitionTimer = null, playTimer = null;

  let activeDaypart     = null;   // daypart the current sequence was built for
  let pendingTransition = null;   // daypart waiting for the current item to finish
  let transitionSteps   = [];     // remaining outro/intro items
  let inTransition      = false;  // true while an outro/intro is playing

  let currentItem = null, attempt = 0, failedAttempt = -1, failStreak = 0;
  // Files that failed to load, with the time they may be tried again. Temporary on
  // purpose: a dropped connection makes GOOD files fail too, and must not ban them for good.
  const BAD_FILE_TTL_MS = 10 * 60 * 1000;
  const badFiles = new Map();
  function isBad(file) {
    const until = badFiles.get(file);
    if (until === undefined) return false;
    if (Date.now() > until) { badFiles.delete(file); return false; }
    return true;
  }

  // ── MANIFEST ──────────────────────────────────────────────────────────────
  async function loadManifest() {
    try {
      const r = await fetch(MANIFEST_URL);
      manifest = await r.json();
      return true;
    } catch (e) {
      console.error('[Radio Pumpo] manifest load failed', e);
      return false;
    }
  }

  // ── CLOCK ─────────────────────────────────────────────────────────────────
  function getUTCSecondOfDay() {
    const n = new Date();
    return n.getUTCHours() * 3600 + n.getUTCMinutes() * 60 + n.getUTCSeconds();
  }

  function getCurrentDaypart() {
    const h = new Date().getUTCHours();
    if (h >= 6  && h < 12) return 'breakfast';
    if (h >= 12 && h < 19) return 'afternoons';
    return 'latenight';
  }

  function getDateSeed() {
    const d = new Date();
    return parseInt(
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
    );
  }

  // ── SEEDED SHUFFLE ────────────────────────────────────────────────────────
  function seededShuffle(arr, seed) {
    const a = [...arr];
    let s = seed >>> 0;
    const rand = () => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ── SEQUENCE BUILDER ──────────────────────────────────────────────────────
  // Returns null if there is nothing playable. Files in badFiles are left out.
  function buildSequence() {
    const dp   = getCurrentDaypart();
    activeDaypart = dp;
    const ok   = x => x && !isBad(x.file);
    const sf   = manifest.scheduling.segment_frequency;
    const sidf = manifest.scheduling.station_id_frequency;
    const wrap = manifest.segments.show_wrappers;

    const pool = manifest.tracks.filter(t => t.dayparts.includes(dp) && ok(t));
    if (!pool.length) return null;
    const segs = (manifest.segments[dp] || []).filter(ok);
    const sids = (manifest.segments.station_ids || []).filter(ok);
    const shuffled = seededShuffle(pool, getDateSeed());

    const seq = [];
    let total = 0, ti = 0, segi = 0, sidi = 0, tc = 0;

    const intro = wrap[`${dp}_intro`];
    if (ok(intro)) {
      seq.push({ type: 'segment', subtype: 'intro', ...intro, label: manifest.dayparts[dp].label });
      total += intro.duration;
    }

    while (total < 86400) {
      const track = shuffled[ti % shuffled.length];
      seq.push({ type: 'track', ...track });
      total += track.duration;
      ti++; tc++;

      if (segs.length && tc % sf === 0) {
        const seg = segs[segi % segs.length];
        seq.push({ type: 'segment', subtype: 'host', ...seg, label: manifest.station.host });
        total += seg.duration;
        segi++;
      }
      if (sids.length && tc % sidf === 0 && tc % sf !== 0) {
        const sid = sids[sidi % sids.length];
        seq.push({ type: 'segment', subtype: 'station_id', ...sid, label: 'Radio Pumpo' });
        total += sid.duration;
        sidi++;
      }
    }
    return seq;
  }

  // ── POSITION CALC ─────────────────────────────────────────────────────────
  function getCurrentPosition(seq) {
    const s = getUTCSecondOfDay();
    let elapsed = 0;
    for (let i = 0; i < seq.length; i++) {
      if (elapsed + seq[i].duration > s) return { item: seq[i], pos: s - elapsed, idx: i };
      elapsed += seq[i].duration;
    }
    return { item: seq[0], pos: 0, idx: 0 };
  }

  // ── PLAYBACK ──────────────────────────────────────────────────────────────
  function startRadio() {
    if (!manifest) return;

    if (STREAM_URL) {
      radioAudio.src = STREAM_URL;
      radioAudio.play().catch(() => {});
      updateRadioDisplay({ title: 'Radio Pumpo', label: manifest.dayparts[getCurrentDaypart()].label });
      return;
    }

    failStreak = 0;
    sequence = buildSequence();
    if (!sequence) { giveUp('no playable tracks'); return; }
    playFromPosition();
    startSyncTimer();
    scheduleDaypartTransition();
  }

  // Play whatever the shared clock says should be playing right now.
  function playFromPosition() {
    if (!sequence || !isRadioMode) return;
    const { item, pos } = getCurrentPosition(sequence);
    const gap = pos === 0 ? (manifest.scheduling.segment_gap_ms || 600) : 0;
    clearTimeout(playTimer);
    playTimer = setTimeout(() => { if (isRadioMode) playItem(item, pos); }, gap);
  }

  // The ONLY place audio is started. Handles load failures.
  function playItem(item, pos) {
    const my = ++attempt;
    currentItem = item;
    radioAudio.src = item.file;
    radioAudio.currentTime = pos || 0;
    updateRadioDisplay(item);

    const p = radioAudio.play();
    if (p && p.catch) {
      p.catch(err => {
        if (my !== attempt || !isRadioMode) return;      // superseded or stopped
        const name = err && err.name;
        if (name === 'AbortError') return;               // src changed under us
        if (name === 'NotAllowedError') { needsTap(); return; }   // autoplay blocked
        failItem(item, my);                              // 404 / corrupt / unsupported
      });
    }
  }

  function needsTap() {
    setRadioBtn('TAP TO START');
    document.addEventListener('click', function handler() {
      document.removeEventListener('click', handler);
      if (isRadioMode) { radioAudio.play().catch(() => {}); setRadioBtn('■ TUNED IN'); }
    });
  }

  // A file could not be played: remember it, skip it, carry on with the clock.
  function failItem(item, my) {
    if (failedAttempt === my) return;      // 'error' event and play() rejection both fire — act once
    failedAttempt = my;
    console.warn('[Radio Pumpo] could not play', item && item.file, '— skipping it');
    if (item && item.file) badFiles.set(item.file, Date.now() + BAD_FILE_TTL_MS);

    if (++failStreak >= MAX_FAILS) { giveUp('too many unplayable files in a row'); return; }
    if (inTransition) { advanceTransition(); return; }      // a missing outro/intro is simply skipped

    const s = buildSequence();
    if (!s) { giveUp('no playable tracks left'); return; }
    sequence = s;
    playFromPosition();
  }

  // Radio can't carry on: hand back to the on-demand player instead of looping.
  function giveUp(reason) {
    console.warn('[Radio Pumpo] giving up:', reason);
    stopRadio();
    setRadioBtn('📻 TUNE IN');
    const m = document.getElementById('pumpo-mode-label');
    if (m) m.textContent = 'ON DEMAND';
    if (typeof window.pumpoShowToast === 'function') window.pumpoShowToast('Radio hiccup — switched to on-demand');
  }

  // Single handler for "current item finished".
  function onEnded() {
    if (!isRadioMode) return;
    if (inTransition)      { advanceTransition(); return; }
    if (pendingTransition) { beginTransition(pendingTransition); return; }
    playFromPosition();
  }

  // ── SYNC TIMER — drift correction only ────────────────────────────────────
  function startSyncTimer() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(() => {
      if (!isRadioMode || !sequence || STREAM_URL) return;
      if (inTransition || pendingTransition) return;         // never fight a show handover
      const { item, pos } = getCurrentPosition(sequence);
      const currentSrc   = radioAudio.src || '';
      const expectedFile = item.file.split('/').pop();
      const drift        = Math.abs((radioAudio.currentTime || 0) - pos);
      if (!currentSrc.endsWith(expectedFile)) playFromPosition();
      else if (drift > 8) radioAudio.currentTime = pos;
    }, 15000);
  }

  // ── SHOW HANDOVER (06:00 / 12:00 / 19:00 UTC) ─────────────────────────────
  // One timer per boundary. The current item always finishes first, then:
  // outgoing outro -> incoming intro -> rebuild sequence for the new show.
  function scheduleDaypartTransition() {
    if (transitionTimer) clearTimeout(transitionTimer);

    const now = new Date();
    const boundaries = [6, 12, 19];
    const h = now.getUTCHours(), m = now.getUTCMinutes(), s = now.getUTCSeconds();
    const nextHour = boundaries.find(b => b > h) ?? boundaries[0];

    let msUntil;
    if (nextHour > h) {
      msUntil = ((nextHour - h) * 3600 - m * 60 - s) * 1000;
    } else {
      msUntil = (((24 - h) * 3600 - m * 60 - s) + nextHour * 3600) * 1000;
    }
    console.log(`[Radio Pumpo] Next daypart transition in ${Math.round(msUntil / 1000)}s`);

    transitionTimer = setTimeout(() => {
      if (!isRadioMode) return;
      const nd = getCurrentDaypart();
      if (nd !== activeDaypart) {
        const idle = !radioAudio.src || radioAudio.paused || radioAudio.ended;
        if (idle) beginTransition(nd);
        else pendingTransition = nd;          // wait for the current item to end
      }
      scheduleDaypartTransition();
    }, msUntil);
  }

  function beginTransition(newDaypart) {
    pendingTransition = null;
    inTransition = true;
    const wrap = manifest.segments.show_wrappers;
    const outgoing = OUTRO_FOR[newDaypart];
    const outro = wrap[`${outgoing}_outro`];
    const intro = wrap[`${newDaypart}_intro`];
    transitionSteps = [];
    if (outro && !isBad(outro.file))
      transitionSteps.push({ ...outro, type: 'segment', title: manifest.dayparts[outgoing].label, label: 'signing off' });
    if (intro && !isBad(intro.file))
      transitionSteps.push({ ...intro, type: 'segment', title: manifest.dayparts[newDaypart].label, label: 'starting now' });
    advanceTransition();
  }

  function advanceTransition() {
    const step = transitionSteps.shift();
    if (step) { playItem(step, 0); return; }
    // outro + intro done (or skipped): rejoin the clock with the new show's sequence
    inTransition = false;
    const s = buildSequence();
    if (!s) { giveUp('no playable tracks for the new show'); return; }
    sequence = s;
    playFromPosition();
  }

  // ── STOP ──────────────────────────────────────────────────────────────────
  function stopRadio() {
    isRadioMode = false;          // first: ignores any error/ended events triggered below
    currentItem = null;
    attempt++;
    pendingTransition = null; transitionSteps = []; inTransition = false;
    clearTimeout(playTimer);
    if (syncTimer)       { clearInterval(syncTimer);      syncTimer = null; }
    if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }
    if (radioAudio) { radioAudio.pause(); radioAudio.src = ''; }
    restoreOnDemandControls();
  }

  // ── DISPLAY ───────────────────────────────────────────────────────────────
  function updateRadioDisplay(item) {
    const marquee = document.getElementById('pumpo-song-marquee');
    const dpLabel = manifest.dayparts[getCurrentDaypart()].label;
    if (marquee && item) {
      const name = item.title || item.label || 'Radio Pumpo';
      marquee.textContent = `${dpLabel.toUpperCase()} — ${name}`;
      marquee.style.animation = 'none';
      requestAnimationFrame(() => { marquee.style.animation = ''; });
    }
  }

  function setRadioBtn(text) {
    const btn = document.getElementById('pumpo-radio-toggle');
    if (btn) btn.textContent = text;
  }

  // ── VOLUME ────────────────────────────────────────────────────────────────
  const VOL_KEY = 'pumpo_volume', MUTE_KEY = 'pumpo_muted';
  let volume = 0.8, lastVolume = 0.8, muted = false, canSetVolume = true;

  // iOS Safari ignores audio.volume (always reads back 1), so test it instead of guessing.
  function detectVolumeSupport() {
    try { const a = new Audio(); a.volume = 0.5; return a.volume === 0.5; } catch (e) { return false; }
  }

  function loadVolume() {
    try {
      const v = parseFloat(localStorage.getItem(VOL_KEY));
      if (!isNaN(v)) volume = Math.min(1, Math.max(0, v));
      muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch (e) {}
    if (volume > 0) lastVolume = volume;
  }

  function saveVolume() {
    try {
      localStorage.setItem(VOL_KEY, String(lastVolume));
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch (e) {}
  }

  // Push the shared volume to the radio audio AND the on-demand player.
  function applyVolume() {
    [radioAudio, document.getElementById('pumpo-audio-el')].filter(Boolean).forEach(a => {
      if (canSetVolume && a.volume !== volume) a.volume = volume;
      if (a.muted !== muted) a.muted = muted;
    });
    renderVolumeUI();
    saveVolume();
  }

  function renderVolumeUI() {
    const btn = document.getElementById('rp-vol-btn');
    const sl  = document.getElementById('rp-vol');
    const eff = muted ? 0 : volume;
    if (btn) {
      btn.textContent = eff === 0 ? '🔇' : eff < 0.34 ? '🔈' : eff < 0.67 ? '🔉' : '🔊';
      btn.title = muted ? 'Unmute' : 'Mute';
      btn.setAttribute('aria-pressed', String(muted));
    }
    if (sl && Number(sl.value) !== Math.round(eff * 100)) sl.value = String(Math.round(eff * 100));
  }

  function toggleMute() {
    muted = !muted;
    if (!muted && canSetVolume && volume === 0) volume = lastVolume || 0.5;
    applyVolume();
  }

  function onVolumeInput(e) {
    const v = Number(e.target.value) / 100;
    volume = v;
    muted = v === 0;
    if (v > 0) lastVolume = v;
    applyVolume();
  }

  // The on-demand player has its own native volume control on desktop: mirror it.
  function onNativeVolumeChange(e) {
    const a = e.target;
    if (Math.abs((a.volume ?? volume) - volume) < 0.001 && a.muted === muted) return;
    if (canSetVolume) { volume = a.volume; if (volume > 0) lastVolume = volume; }
    muted = a.muted;
    applyVolume();
  }

  function bindVolumeSync() {
    const od = document.getElementById('pumpo-audio-el');
    if (od) od.addEventListener('volumechange', onNativeVolumeChange);
  }

  function buildVolumeUI() {
    if (!document.getElementById('rp-vol-style')) {
      const st = document.createElement('style');
      st.id = 'rp-vol-style';
      st.textContent = '#rp-vol{width:84px;accent-color:#ff0080;cursor:pointer;vertical-align:middle}' +
                       '@media(max-width:400px){#rp-vol{width:64px}}';
      document.head.appendChild(st);
    }
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const btn = document.createElement('button');
    btn.id = 'rp-vol-btn';
    btn.type = 'button';
    btn.className = 'pumpo-bar-btn';
    btn.style.cssText = 'font-size:.8rem;padding:4px 8px;';
    btn.onclick = toggleMute;
    wrap.appendChild(btn);

    if (canSetVolume) {                       // no slider on iOS: the OS owns the volume there
      const sl = document.createElement('input');
      sl.type = 'range'; sl.id = 'rp-vol';
      sl.min = '0'; sl.max = '100'; sl.step = '1';
      sl.value = String(Math.round((muted ? 0 : volume) * 100));
      sl.setAttribute('aria-label', 'Volume');
      sl.addEventListener('input', onVolumeInput);
      wrap.appendChild(sl);
    }
    return wrap;
  }

  // ── UI INJECTION ──────────────────────────────────────────────────────────
  function injectRadioUI() {
    const bar = document.getElementById('pumpoBar');
    if (!bar) return;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px 10px;margin-bottom:2px;';

    const tuneBtn = document.createElement('button');
    tuneBtn.id = 'pumpo-radio-toggle';
    tuneBtn.className = 'pumpo-bar-btn';
    tuneBtn.style.cssText = 'font-size:0.72rem;letter-spacing:1px;padding:5px 12px;border-color:var(--pink);color:var(--pink);';
    tuneBtn.textContent = '📻 TUNE IN';
    tuneBtn.onclick = toggleRadio;

    const modeLabel = document.createElement('span');
    modeLabel.id = 'pumpo-mode-label';
    modeLabel.style.cssText = 'font-size:0.68rem;color:#555;letter-spacing:1px;font-family:Rajdhani,sans-serif;font-weight:700;';
    modeLabel.textContent = 'ON DEMAND';

    row.appendChild(tuneBtn);
    row.appendChild(modeLabel);
    row.appendChild(buildVolumeUI());
    bar.insertBefore(row, bar.firstChild);
  }

  // ── RESTORE ON-DEMAND CONTROLS ────────────────────────────────────────────
  function restoreOnDemandControls() {
    const prev = document.getElementById('pumpoPrevBtn');
    const next = document.getElementById('pumpoNextBtn');
    if (prev) { prev.style.opacity = ''; prev.style.pointerEvents = ''; }
    if (next) { next.style.opacity = ''; next.style.pointerEvents = ''; }
    const existingAudio = document.getElementById('pumpo-audio-el');
    if (existingAudio) existingAudio.style.display = '';
  }

  // ── TOGGLE ────────────────────────────────────────────────────────────────
  async function toggleRadio() {
    if (!manifest) {
      setRadioBtn('Loading...');
      const ok = await loadManifest();
      if (!ok) { setRadioBtn('📻 TUNE IN'); return; }
    }

    if (isRadioMode) {
      stopRadio();
      setRadioBtn('📻 TUNE IN');
      const modeLabel = document.getElementById('pumpo-mode-label');
      if (modeLabel) modeLabel.textContent = 'ON DEMAND';
    } else {
      isRadioMode = true;

      const existingAudio = document.getElementById('pumpo-audio-el');
      if (existingAudio) { existingAudio.pause(); existingAudio.style.display = 'none'; }

      const prev = document.getElementById('pumpoPrevBtn');
      const next = document.getElementById('pumpoNextBtn');
      if (prev) { prev.style.opacity = '0.25'; prev.style.pointerEvents = 'none'; }
      if (next) { next.style.opacity = '0.25'; next.style.pointerEvents = 'none'; }

      setRadioBtn('■ TUNED IN');
      const modeLabel = document.getElementById('pumpo-mode-label');
      if (modeLabel) modeLabel.textContent = 'LIVE 24/7 ●';

      startRadio();
    }
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    radioAudio = new Audio();
    radioAudio.preload = 'auto';

    radioAudio.addEventListener('ended',   onEnded);
    radioAudio.addEventListener('playing', () => { failStreak = 0; });
    radioAudio.addEventListener('error',   () => {
      if (!isRadioMode || !currentItem) return;     // ignore the error browsers raise when src is cleared
      failItem(currentItem, attempt);
    });

    canSetVolume = detectVolumeSupport();
    loadVolume();
    injectRadioUI();
    bindVolumeSync();
    applyVolume();

    loadManifest().then(() => {
      console.log('[Radio Pumpo] Manifest loaded. Ready to tune in.');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.PumpoRadio = { toggle: toggleRadio, isOn: () => isRadioMode };

})();
