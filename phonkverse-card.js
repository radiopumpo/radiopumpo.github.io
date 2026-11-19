/* PHONKVERSE preview card for radiopumpo.github.io
   Sits directly under the "New drop" video card (same top-right spot, same scroll-away / pin-at-end behaviour).
   Usage: put phonkverse-card.js and phonkverse-preview.jpg next to index.html, then add ONE line
   before <script src="radio-player.js">:   <script src="phonkverse-card.js"></script>
   If the New drop card is hidden or removed, this card simply moves up to the top-right slot. */
(function () {
  const CARD = {
    url:   'https://radiopumpo.github.io/phonkverse/',
    image: 'phonkverse-preview.jpg',
    tag:   '● New world',
    title: 'PHONKVERSE',
    cta:   'Enter the universe'
  };

  const style = document.createElement('style');
  style.textContent = `
  .pv-card{position:absolute;top:64px;right:20px;z-index:449;display:flex;align-items:center;gap:10px;max-width:min(calc(100vw - 40px),250px);padding:6px 12px 6px 6px;border-radius:12px;border:1px solid rgba(202,255,59,.34);background:rgba(4,2,10,.82);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:0 6px 24px rgba(0,0,0,.55),0 0 18px rgba(202,255,59,.12);text-decoration:none;color:var(--text,#f0ede6);font-family:var(--sans,'Rajdhani',sans-serif);opacity:0;transform:translateY(-8px);transition:opacity .6s ease,transform .6s ease,border-color .2s,background .2s;-webkit-tap-highlight-color:transparent;}
  .pv-card.show{opacity:1;transform:none;}
  .pv-card.pinned{position:fixed;}
  .pv-card:hover,.pv-card:focus-visible{border-color:#caff3b;background:rgba(202,255,59,.1);outline:none;}
  .pv-thumb{position:relative;width:72px;aspect-ratio:16/9;border-radius:7px;overflow:hidden;flex-shrink:0;background:linear-gradient(135deg,#1a0a10,#101a0a);}
  .pv-thumb img{width:100%;height:100%;object-fit:cover;display:block;}
  .pv-go{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.25);font-size:.85rem;color:#fff;transition:.2s;}
  .pv-card:hover .pv-go{background:rgba(202,255,59,.3);}
  .pv-text{display:flex;flex-direction:column;gap:1px;min-width:0;}
  .pv-tag{font-family:var(--mono,'Space Mono',monospace);font-size:.48rem;letter-spacing:.2em;color:#caff3b;text-transform:uppercase;}
  .pv-title{font-family:var(--display,'Black Ops One',cursive);font-size:.8rem;letter-spacing:.5px;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pv-cta{font-family:var(--mono,'Space Mono',monospace);font-size:.5rem;letter-spacing:.1em;color:rgba(240,237,230,.45);text-transform:uppercase;}
  @media(max-width:480px){.pv-cta{display:none;}.pv-thumb{width:60px;}}`;
  document.head.appendChild(style);

  const a = document.createElement('a');
  a.className = 'pv-card';
  a.href = CARD.url;
  a.target = '_blank';            // new tab: the radio keeps playing while people explore
  a.rel = 'noopener';
  a.setAttribute('aria-label', CARD.title + ' — ' + CARD.cta);
  a.innerHTML = '<span class="pv-thumb"><img alt="" loading="lazy"><span class="pv-go">↗</span></span>' +
    '<span class="pv-text"><span class="pv-tag"></span><span class="pv-title"></span><span class="pv-cta"></span></span>';
  a.querySelector('img').src = CARD.image;
  a.querySelector('.pv-tag').textContent = CARD.tag;
  a.querySelector('.pv-title').textContent = CARD.title;
  a.querySelector('.pv-cta').textContent = CARD.cta;
  a.querySelector('img').onerror = function () { this.style.display = 'none'; };
  document.body.appendChild(a);

  const nd = document.getElementById('newDrop');
  let tick = false;
  function place() {
    tick = false;
    const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 140;
    const shown = nd && !nd.hidden && getComputedStyle(nd).display !== 'none';
    const r = shown ? nd.getBoundingClientRect() : null;
    a.classList.toggle('pinned', atEnd);
    a.style.top = (atEnd ? (r ? r.bottom + 8 : 64) : (r ? r.bottom + window.scrollY + 8 : 64)) + 'px';
  }
  const schedule = () => { if (!tick) { tick = true; requestAnimationFrame(place); } };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  if (nd) new MutationObserver(schedule).observe(nd, { attributes: true, attributeFilter: ['class', 'hidden'] });
  place();
  setTimeout(() => { place(); a.classList.add('show'); }, 900);   // after the New drop card's entrance
  setTimeout(place, 1500);                                         // re-measure once its transition has settled
})();
