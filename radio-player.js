/**
 * RADIO PUMPO — SHARED CLOCK PLAYER v1.0
 *
 * INTEGRATION: Add one line to index.html before </body>:
 *   <script src="radio-player.js"></script>
 *
 * Then replace the existing PUMPO_PLAYLIST array in the inline script with:
 *   const PUMPO_PLAYLIST = window.PUMPO_ON_DEMAND_PLAYLIST;
 *
 * That's it. The radio mode toggle is injected automatically into the
 * existing pumpo bar. All existing on-demand functionality is preserved.
 *
 * HOW IT WORKS:
 * Every listener shares the same UTC clock. The manifest defines a 24-hour
 * sequence. On "Tune In", the player calculates exactly which track is playing
 * right now and at what position, then seeks to it. Everyone who tunes in at
 * the same moment hears the same thing.
 *
 * OPTION 1 UPGRADE: When moving to Liquidsoap/Icecast, change STREAM_URL
 * below to your Icecast mount URL. Radio mode will use the stream instead
 * of the calculated local file. Nothing else changes.
 */

(function () {

  // ── CONFIG ────────────────────────────────────────────────────────────────
  const MANIFEST_URL = '/radio-manifest.json';
  const STREAM_URL   = null; // Set to Icecast URL when upgrading to Option 1

  // ── STATE ─────────────────────────────────────────────────────────────────
  let manifest      = null;
  let radioAudio    = null;
  let segAudio      = null;
  let isRadioMode   = false;
  let sequence      = null;
  let syncTimer     = null;
  let segQueue      = [];
  let playingSegment = false;

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
  // Builds the full 24-hour flat sequence of audio items.
  // Same seed = same sequence for every listener today.
  function buildSequence() {
    const dp      = getCurrentDaypart();
    const sf      = manifest.scheduling.segment_frequency;
    const sidf    = manifest.scheduling.station_id_frequency;
    const seed    = getDateSeed();
    const wrap    = manifest.segments.show_wrappers;
    const segs    = manifest.segments[dp];
    const sids    = manifest.segments.station_ids;
    const pool    = manifest.tracks.filter(t => t.dayparts.includes(dp));
    const shuffled = seededShuffle(pool, seed);

    const seq = [];
    let total = 0;
    let ti = 0, segi = 0, sidi = 0, tc = 0;

    // Open with show wrapper intro
    const intro = wrap[`${dp}_intro`];
    seq.push({ type: 'segment', subtype: 'intro', ...intro, label: manifest.dayparts[dp].label });
    total += intro.duration;

    while (total < 86400) {
      // Track
      const track = shuffled[ti % shuffled.length];
      seq.push({ type: 'track', ...track });
      total += track.duration;
      ti++; tc++;

      // Host segment every N tracks
      if (tc % sf === 0) {
        const seg = segs[segi % segs.length];
        seq.push({ type: 'segment', subtype: 'host', ...seg, label: manifest.station.host });
        total += seg.duration;
        segi++;
      }

      // Station ID every M tracks (when not already inserting a host segment)
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

    // If Option 1 stream URL is set, use it directly
    if (STREAM_URL) {
      radioAudio.src = STREAM_URL;
      radioAudio.play().catch(() => {});
      updateRadioDisplay({ title: 'Radio Pumpo', label: manifest.dayparts[getCurrentDaypart()].label });
      return;
    }

    sequence = buildSequence();
    playFromPosition();
    startSyncTimer();
  }

  function playFromPosition() {
    const { item, pos } = getCurrentPosition(sequence);
    const gap = pos === 0 ? (manifest.scheduling.segment_gap_ms || 600) : 0;

    setTimeout(() => {
      radioAudio.src = item.file;
      radioAudio.currentTime = pos;
      radioAudio.play().catch(() => {
        // Autoplay blocked — surface a tap-to-start message
        setRadioBtn('TAP TO START');
        document.addEventListener('click', function handler() {
          radioAudio.play();
          setRadioBtn('TUNED IN ■');
          document.removeEventListener('click', handler);
        });
      });
      updateRadioDisplay(item);
    }, gap);
  }

  function startSyncTimer() {
    if (syncTimer) clearInterval(syncTimer);
    // Re-check position every 15 seconds; re-sync if drifted > 8s
    syncTimer = setInterval(() => {
      if (!isRadioMode || !sequence || STREAM_URL) return;
      const { item, pos } = getCurrentPosition(sequence);
      const drift = Math.abs((radioAudio.currentTime || 0) - pos);
      if (radioAudio.src !== location.origin + '/' + item.file.replace(/^\//, '') &&
          !radioAudio.src.endsWith(item.file.split('/').pop())) {
        // Wrong track entirely — re-sync
        playFromPosition();
      } else if (drift > 8) {
        radioAudio.currentTime = pos;
      }
    }, 15000);
  }

  function stopRadio() {
    if (radioAudio) {
      radioAudio.pause();
      radioAudio.src = '';
    }
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    isRadioMode = false;
  }

  // ── DISPLAY ───────────────────────────────────────────────────────────────
  function updateRadioDisplay(item) {
    // Update the existing marquee in the pumpo bar
    const marquee = document.getElementById('pumpo-song-marquee');
    const dpLabel = manifest.dayparts[getCurrentDaypart()].label;
    if (marquee && item) {
      const name = item.title || item.label || 'Radio Pumpo';
      marquee.textContent = `${dpLabel.toUpperCase()} — ${name}`;
      // Reset marquee animation
      marquee.style.animation = 'none';
      requestAnimationFrame(() => { marquee.style.animation = ''; });
    }
  }

  function setRadioBtn(text) {
    const btn = document.getElementById('pumpo-radio-toggle');
    if (btn) btn.textContent = text;
  }

  // ── UI INJECTION ──────────────────────────────────────────────────────────
  // Injects the Radio / On Demand toggle into the existing pumpo bar,
  // above the controls row. Does not touch any existing elements.
  function injectRadioUI() {
    const bar = document.getElementById('pumpoBar');
    if (!bar) return;

    // Create radio mode row
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

    // Insert before the marquee (first child of bar)
    bar.insertBefore(row, bar.firstChild);
  }

  // ── TOGGLE ────────────────────────────────────────────────────────────────
  async function toggleRadio() {
    if (!manifest) {
      setRadioBtn('Loading...');
      const ok = await loadManifest();
      if (!ok) { setRadioBtn('📻 TUNE IN'); return; }
    }

    if (isRadioMode) {
      // Switch to on-demand mode
      stopRadio();
      setRadioBtn('📻 TUNE IN');
      const modeLabel = document.getElementById('pumpo-mode-label');
      if (modeLabel) modeLabel.textContent = 'ON DEMAND';

      // Restore existing on-demand player
      const existingAudio = document.getElementById('pumpo-audio-el');
      if (existingAudio) existingAudio.style.display = '';

    } else {
      // Switch to radio mode
      isRadioMode = true;

      // Pause the existing on-demand player
      const existingAudio = document.getElementById('pumpo-audio-el');
      if (existingAudio) {
        existingAudio.pause();
        // Hide native controls — radio mode has no skip/prev
        existingAudio.style.display = 'none';
      }

      // Mute prev/next buttons in radio mode
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

  // Restore on-demand controls when switching back
  function restoreOnDemandControls() {
    const prev = document.getElementById('pumpoPrevBtn');
    const next = document.getElementById('pumpoNextBtn');
    if (prev) { prev.style.opacity = ''; prev.style.pointerEvents = ''; }
    if (next) { next.style.opacity = ''; next.style.pointerEvents = ''; }
    const existingAudio = document.getElementById('pumpo-audio-el');
    if (existingAudio) existingAudio.style.display = '';
  }

  // Override stopRadio to also restore controls
  const _stopRadio = stopRadio;
  stopRadio = function () {
    _stopRadio();
    restoreOnDemandControls();
  };

  // ── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    // Create a separate audio element for radio mode
    // (keeps it fully independent from the existing on-demand audio element)
    radioAudio = new Audio();
    radioAudio.preload = 'auto';

    // When a radio track ends, re-sync to current position
    // (handles the case where the track finishes and we need the next one)
    radioAudio.addEventListener('ended', () => {
      if (isRadioMode) playFromPosition();
    });

    // Inject the UI toggle
    injectRadioUI();

    // Pre-load manifest silently in background
    loadManifest().then(() => {
      console.log('[Radio Pumpo] Manifest loaded. Ready to tune in.');
    });
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose public toggle for any external use
  window.PumpoRadio = { toggle: toggleRadio };

})();
