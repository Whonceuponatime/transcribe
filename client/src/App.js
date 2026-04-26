import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import './App.css';
import { useAuth } from './contexts/AuthContext';
import AuthStatus from './components/AuthStatus';
import AppNav, { CATEGORIES, getCategoryForPath } from './components/AppNav';
import SignInGate from './components/SignInGate';
import AudioTranscriptionPanel from './components/AudioTranscriptionPanel';
import TextToSpeech from './components/TextToSpeech';
import MetadataPanel from './components/MetadataPanel';
import ImageConverter from './components/ImageConverter';
import ZigzagMerger from './components/ZigzagMerger';
import LiveTranslator from './components/LiveTranslator';
import MarkdownCSVConverter from './components/MarkdownCSVConverter';
import Rewriter from './components/Rewriter';
import ImageToText from './components/ImageToText';
import CryptoTraderDashboard from './components/CryptoTraderDashboard';
import VideoTranscribePage from './components/VideoTranscribePage';
import InstallAppBanner from './components/InstallAppBanner';

function App() {
  const { isAuthenticated, loading, supabaseConfigured } = useAuth();
  const location = useLocation();

  // activeCategory drives the sub-strip filter and category highlight only.
  // URL is the source of truth — pathname changes resync activeCategory below.
  // Manual category clicks (segmented control / bottom-nav) override locally
  // until the next navigation.
  const [activeCategory, setActiveCategory] = useState(
    () => getCategoryForPath(location.pathname)
  );

  useEffect(() => {
    setActiveCategory(getCategoryForPath(location.pathname));
  }, [location.pathname]);

  const canUseApp = supabaseConfigured && isAuthenticated;

  if (loading) {
    return (
      <div className="App App--loading">
        <div className="App-loading">Loading…</div>
      </div>
    );
  }

  if (!canUseApp) {
    return <SignInGate />;
  }

  return (
    <div className="App">
      <InstallAppBanner />
      <header className="App-header">
        <div className="App-header__inner">
          <div className="App-header__brand">
            <h1 className="App-header__title">
              <img src="/logo.png" alt="" className="App-header__logo" />
              <span>Sad Dagger</span>
            </h1>
            <p className="App-header__tagline">Transcription, conversion &amp; utilities</p>
          </div>

          {/* Category segmented control — center column on desktop */}
          <div className="nav-categories" role="tablist" aria-label="Categories">
            {Object.entries(CATEGORIES).map(([key, cat]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={activeCategory === key}
                className={`nav-category-btn ${activeCategory === key ? 'active' : ''}`}
                onClick={() => setActiveCategory(key)}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div className="App-header__auth">
            <AuthStatus />
          </div>
        </div>
      </header>

      <AppNav
        activeCategory={activeCategory}
        setActiveCategory={setActiveCategory}
      />

      <main className="App-main">
        <Routes>
          <Route path="/" element={<Navigate to="/trader" replace />} />
          <Route path="/trader" element={<CryptoTraderDashboard />} />
          <Route path="/video-transcribe" element={<VideoTranscribePage />} />
          <Route path="/audio-transcribe" element={<AudioTranscriptionPanel />} />
          <Route path="/translate" element={<LiveTranslator />} />
          <Route path="/image-to-text" element={<ImageToText />} />
          <Route path="/rewriter" element={<Rewriter />} />
          <Route path="/tts" element={<TextToSpeech />} />
          <Route path="/image-convert" element={<ImageConverter />} />
          <Route path="/markdown-csv" element={<MarkdownCSVConverter />} />
          <Route path="/zigzag" element={<ZigzagMerger />} />
          <Route path="/metadata" element={<MetadataPanel />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
