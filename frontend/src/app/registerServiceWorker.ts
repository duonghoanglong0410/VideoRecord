/**
 * Registers the PackingProof Web App Shell Service Worker (/sw.js) in production secure contexts.
 * Note: The Service Worker caches ONLY static App Shell assets (HTML/CSS/JS/icons) for quick launch
 * from the mobile Home Screen; it strictly bypasses /api/*, /health/*, Range streams, and tus uploads,
 * and makes no claim of background recording or offline upload guarantees.
 */
export function registerAppShellServiceWorker(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return;
  }

  if (!import.meta.env.PROD) {
    return;
  }

  if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    return;
  }

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch(() => {
        // Non-blocking: App operates identically as a standard web app if SW registration is blocked
      });
  });
}
