/* Radio Pumpo — compatibility shim.
   The radio now lives in the shared player (/player/player.js). Pages that still include this old file
   (vip.html, planet.html …) keep working unchanged: this loads the player with no visible bar ("hidden" mode)
   and window.PumpoRadio.toggle()/isOn() behave as before. Pages can opt in to the bar with data-mode="full" | "compact". */
(function () {
  if (window.PumpoPlayer) return;
  var me = document.currentScript;
  var s = document.createElement('script');
  s.src = '/player/player.js?v=1';
  s.setAttribute('data-mode', (me && me.getAttribute('data-mode')) || 'hidden');
  document.head.appendChild(s);
})();
