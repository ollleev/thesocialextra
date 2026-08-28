/** Optional browser installation, never an automatic modal or an account flow. */
export function setupInstall({ button, status, window: win = globalThis.window, navigator: nav = globalThis.navigator } = {}) {
  let deferred = null, busy = false, installed = false, destroyed = false;
  const say = message => { if (status && !destroyed) status.textContent = message; };
  const standalone = () => Boolean(nav?.standalone || win?.matchMedia?.('(display-mode: standalone)').matches);
  const render = () => {
    if (!button) return;
    button.hidden = destroyed || installed || standalone() || !deferred;
    button.disabled = busy;
  };
  render();
  if (!win?.isSecureContext || !nav?.serviceWorker) return { ready: Promise.resolve(false), destroy() { destroyed = true; render(); } };

  const beforeInstall = event => {
    if (!button || destroyed || installed || standalone() || typeof event.prompt !== 'function') return;
    event.preventDefault();
    deferred = event;
    render();
  };
  const appInstalled = () => {
    installed = true; deferred = null;
    render(); say('Application installée.');
  };
  const click = async () => {
    if (!deferred || busy || installed || destroyed || standalone()) return;
    const prompt = deferred;
    deferred = null; busy = true; render();
    try {
      // Called synchronously in the click handler to retain user activation.
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (!installed) say(choice.outcome === 'accepted' ? 'Demande d’installation acceptée.' : 'Installation annulée.');
    } catch {
      if (!installed) say('Installation indisponible. Vous pouvez continuer dans le navigateur.');
    } finally { busy = false; render(); }
  };
  win.addEventListener('beforeinstallprompt', beforeInstall);
  win.addEventListener('appinstalled', appInstalled);
  button?.addEventListener('click', click);

  // Register only our origin-root script. No URL query, account data, push
  // subscription, background sync, telemetry or forced page reload is involved.
  const ready = (async () => {
    try {
      await nav.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' });
      return true;
    } catch {
      // Normal browsing is unaffected if service workers are unavailable.
      return false;
    }
  })();
  return { ready, destroy() {
    destroyed = true; deferred = null;
    win.removeEventListener('beforeinstallprompt', beforeInstall);
    win.removeEventListener('appinstalled', appInstalled);
    button?.removeEventListener('click', click);
    render();
  } };
}

// A single module script in index.html is the complete runtime integration.
if (globalThis.document) setupInstall({
  button: document.getElementById('install-app'),
  status: document.getElementById('install-status'),
});
