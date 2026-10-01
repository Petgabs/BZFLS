// Register offline support without inline script. Keeping this first-party
// module external allows the page's Content-Security-Policy to forbid inline
// JavaScript while preserving the service-worker update flow.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    let refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshed) return;
      refreshed = true;
      window.location.reload();
    });
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .catch(error => console.warn('Offline support is unavailable.', error));
  });
}
