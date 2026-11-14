/* Runs synchronously in <head>, before the stylesheet and application bundle,
   so a reload with image dark mode on never flashes the bright image first.
   The app UI itself follows the system light/dark setting through CSS alone. */
(() => {
  try {
    if (JSON.parse(sessionStorage.getItem('imgv.darkOn')) === true) {
      document.documentElement.setAttribute('data-dark-image', 'on');
    }
  } catch { /* storage blocked: start with dark mode off */ }
})();
