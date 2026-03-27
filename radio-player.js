/**
 * RADIO PUMPO — SHARED CLOCK PLAYER v1.1
 *
 * INTEGRATION: Add one line to index.html before </body>:
 *   <script src="radio-player.js"></script>
 *
 * HOW IT WORKS:
 * Every listener shares the same UTC clock. The manifest defines a 24-hour
 * sequence. On "Tune In", the player calculates exactly which track is playing
 * right now and at what position, then seeks to it. Everyone who tunes in at
 * the same moment hears the same thing.
 *
 * Daypart transitions (06:00, 12:00, 19:00 UTC) fire exactly once per boundary
 * using setTimeout — no polling. The outgoing show outro plays, then the
 * incoming show intro, then the new sequence begins seamlessly.
 *
 * OPTION 1 UPGRADE: Set STREAM_URL to your Icecast mount URL.
 * Radio mode will use the stream instead of the calculated local file.
 * Nothing else changes.
 */

(function () {

  // ── CONFIG ────────────────────────────────────────────────────────────────
  const MANIFEST_URL = '/radio-manifest.json';
  const STREAM_URL   = null; // Set to Icecast URL when upgrading to Option 1

  // ── STATE ─────────────────────────────────────────────────────────────────
  let manifest        = null;
  let radioAudio      = null;
  let isRadioMode     = false;
  let sequence        = null;
  let syncTimer       = null;
  let transitionTimer = null;

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

  function getUTCHour() {
    return new Date().getUTCHours();
  }

  function getCurrentDaypart() {
    const h = getUTCHour();
    if (h >= 6  && h < 12) return 'breakfast';
    if (h >= 12 && h < 19) return 'afternoons';
    return 'latenight';
  }

  function getDateSeed() {
    const d = new Date();
    return parseInt(
      `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`
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
  function buildSequence() {
    const dp       = getCurrentDaypart();
    const sf       = manifest.scheduling.segment_frequency;
    const sidf     = manifest.scheduling.station_id_frequency;
    const seed     = getDateSeed();
    const wrap     = manifest.segments.show_wrappers;
    const segs     = manifest.segments[dp];
    const sids     = manifest.segments.station_ids;
    const pool     = manifest.tracks.filter(t => t.dayparts.includes(dp));
    const shuffled = seededShuffle(pool, seed);

    const seq = [];
    let total = 0;
    let ti = 0, segi = 0, sidi = 0, tc = 0;

    // Open with show wrapper intro
    const intro = wrap[`${dp}_intro`];
    seq.push({ type: 'segment', subtype: 'intro', ...intro, label: manifest.dayparts[dp].label });
    total += intro.duration;

    while (total < 86400) {
      const track = shuffled[ti % shuffled.length];
      seq.push({ type: 'track', ...track });
      total += track.duration;
      ti++; tc++;

      if (tc % sf === 0) {
        const seg = segs[segi % segs.length];
        seq.push({ type: 'segment', subtype: 'host', ...seg, label: manifest.station.host });
        total += seg.duration;
        segi++;
      }

      if (tc % sidf === 0 && tc % sf !== 0) {
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
      if (elapsed + seq[i].duration > s) {
        return { item: seq[i], pos: s - elapsed, idx: i };
      }
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

    sequence = buildSequence();
    playFromPosition();
    startSyncTimer();
    scheduleDaypartTransition();
  }

  function playFromPosition() {
    const { item, pos } = getCurrentPosition(sequence);
    const gap = pos === 0 ? (manifest.scheduling.segment_gap_ms || 600) : 0;

    setTimeout(() => {
      radioAudio.src = item.file;
      radioAudio.currentTime = pos;
      radioAudio.play().catch(() => {
        setRadioBtn('TAP TO START');
        document.addEventListener('click', function handler() {
          radioAudio.play();
          setRadioBtn('■ TUNED IN');
          document.removeEventListener('click', handler);
        });
      });
      updateRadioDisplay(item);
    }, gap);
  }

  // ── SYNC TIMER — drift correction only, 15s interval ─────────────────────
  function startSyncTimer() {
    if (syncTimer) clearInterval(syncTimer);

    syncTimer = setInterval(() => {
      if (!isRadioMode || !sequence || STREAM_URL) return;

      const { item, pos } = getCurrentPosition(sequence);
      const currentSrc   = radioAudio.src || '';
      const expectedFile = item.file.split('/').pop();
      const drift        = Math.abs((radioAudio.currentTime || 0) - pos);

      if (!currentSrc.endsWith(expectedFile)) {
        playFromPosition();
      } else if (drift > 8) {
        radioAudio.currentTime = pos;
      }
    }, 15000);
  }

  // ── DAYPART TRANSITION — fires exactly once per boundary ──────────────────
  // Boundaries: 06:00, 12:00, 19:00 UTC
  // Uses a single setTimeout calculated to the millisecond — no polling.
  // Self-schedules after each transition so it fires exactly 3 times per day.
  function scheduleDaypartTransition() {
    if (transitionTimer) clearTimeout(transitionTimer);

    const now              = new Date();
    const boundaries       = [6, 12, 19];
    const currentUTCHour   = now.getUTCHours();
    const currentUTCMinute = now.getUTCMinutes();
    const currentUTCSecond = now.getUTCSeconds();

    const nextBoundaryHour = boundaries.find(h => h > currentUTCHour) ?? boundaries[0];

    let msUntil;
    if (nextBoundaryHour > currentUTCHour) {
      msUntil = (
        (nextBoundaryHour - currentUTCHour) * 3600
        - currentUTCMinute * 60
        - currentUTCSecond
      ) * 1000;
    } else {
      // Next boundary is tomorrow at 06:00
      const secondsUntilMidnight = (24 - currentUTCHour) * 3600
        - currentUTCMinute * 60
        - currentUTCSecond;
      msUntil = (secondsUntilMidnight + nextBoundaryHour * 3600) * 1000;
    }

    console.log(`[Radio Pumpo] Next daypart transition in ${Math.round(msUntil / 1000)}s`);

    transitionTimer = setTimeout(() => {
      if (!isRadioMode) return;
      triggerDaypartTransition(getCurrentDaypart());
      scheduleDaypartTransition(); // schedule the next one
    }, msUntil);
  }

  function triggerDaypartTransition(newDaypart) {
    if (!manifest) return;

    const wrap = manifest.segments.show_wrappers;

    const outroMap = {
      'afternoons': 'breakfast',
      'latenight':  'afternoons',
      'breakfast':  'latenight'
    };

    const outgoingDaypart = outroMap[newDaypart];
    const outroData       = wrap[`${outgoingDaypart}_outro`];
    const introData       = wrap[`${newDaypart}_intro`];

    function playTransition() {
      radioAudio.removeEventListener('ended', playTransition);

      // Play outro for outgoing show
      radioAudio.src = outroData.file;
      radioAudio.currentTime = 0;
      radioAudio.play().catch(() => {});
      updateRadioDisplay({
        title: manifest.dayparts[outgoingDaypart]?.label || 'Radio Pumpo',
        label: 'signing off'
      });

      // After outro — play intro for incoming show
      radioAudio.addEventListener('ended', function playIntro() {
        radioAudio.removeEventListener('ended', playIntro);

        radioAudio.src = introData.file;
        radioAudio.currentTime = 0;
        radioAudio.play().catch(() => {});
        updateRadioDisplay({
          title: manifest.dayparts[newDaypart].label,
          label: 'starting now'
        });

        // After intro — rebuild sequence for new daypart and continue
        radioAudio.addEventListener('ended', function resumeStream() {
          radioAudio.removeEventListener('ended', resumeStream);
          sequence = buildSequence();
          playFromPosition();
        }, { once: true });

      }, { once: true });
    }

    // Wait for current track to finish naturally before transitioning
    if (!radioAudio.paused && radioAudio.src) {
      radioAudio.addEventListener('ended', playTransition, { once: true });
    } else {
      playTransition();
    }
  }

  // ── STOP ──────────────────────────────────────────────────────────────────
  function stopRadio() {
    if (radioAudio) {
      radioAudio.pause();
      radioAudio.src = '';
    }
    if (syncTimer)       { clearInterval(syncTimer);      syncTimer = null; }
    if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }
    isRadioMode = false;
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

  // ── UI INJECTION ──────────────────────────────────────────────────────────
  function injectRadioUI() {
    const bar = document.getElementById('pumpoBar');
    if (!bar) return;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:2px;';

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
      if (existingAudio) {
        existingAudio.pause();
        existingAudio.style.display = 'none';
      }

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

    // When a track ends naturally, re-sync to current position for next item
    radioAudio.addEventListener('ended', () => {
      if (isRadioMode && sequence) playFromPosition();
    });

    injectRadioUI();

    // Pre-load manifest silently on page load
    loadManifest().then(() => {
      console.log('[Radio Pumpo] Manifest loaded. Ready to tune in.');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.PumpoRadio = { toggle: toggleRadio };

})();
