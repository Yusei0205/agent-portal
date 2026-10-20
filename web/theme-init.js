// Runs before the page paints (the Content-Security-Policy only allows scripts from this origin, so it is a file).
// Applies the saved look so there is no flash of the wrong theme. Keep in sync with web/src/lib/theme.js.
(function () {
  var root = document.documentElement;
  var theme = 'hud';
  var fx = 'full';
  try {
    theme = localStorage.getItem('portal-theme') || theme;
    fx = localStorage.getItem('portal-fx') || fx;
  } catch (e) {
    /* storage can be blocked; the defaults are fine */
  }
  root.setAttribute('data-theme', theme === 'standard' ? 'standard' : 'hud');
  root.setAttribute('data-fx', fx === 'reduced' ? 'reduced' : 'full');
})();
