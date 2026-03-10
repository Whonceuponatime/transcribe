import React, { useState, useEffect } from 'react';

export default function InstallAppBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showBanner, setShowBanner] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  useEffect(() => {
    if (isStandalone() || dismissed) return;

    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowBanner(true);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [dismissed]);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setShowBanner(false);
    setDeferredPrompt(null);
  };

  if (!showBanner || !deferredPrompt) return null;

  return (
    <div className="install-app-banner" role="banner">
      <span className="install-app-banner__text">
        Add Jack of clubs to your home screen to use it like an app.
      </span>
      <div className="install-app-banner__actions">
        <button type="button" className="install-app-banner__install" onClick={handleInstall}>
          Install
        </button>
        <button
          type="button"
          className="install-app-banner__dismiss"
          onClick={() => {
            setShowBanner(false);
            setDismissed(true);
          }}
          aria-label="Dismiss"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
