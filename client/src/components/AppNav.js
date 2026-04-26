import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';

const CATEGORIES = {
  dashboard: {
    label: 'Dashboard',
    icon: '📊',
    shortLabel: 'Home',
    tools: [
      { id: 'crypto-trader', label: 'Upbit Bot', icon: '🤖', path: '/trader' },
    ],
  },
  language: {
    label: 'Language',
    icon: '🌐',
    shortLabel: 'Language',
    tools: [
      { id: 'transcription',  label: 'Video Transcribe', icon: '🎬', path: '/video-transcribe' },
      { id: 'audio',          label: 'Audio Transcribe', icon: '🎵', path: '/audio-transcribe' },
      { id: 'translator',     label: 'Live Translate',   icon: '🌐', path: '/translate' },
      { id: 'image-to-text',  label: 'Image to Text',    icon: '📷', path: '/image-to-text' },
      { id: 'rewriter',       label: 'Rewriter',         icon: '✉️', path: '/rewriter' },
      { id: 'tts',            label: 'Text to Speech',   icon: '📖', path: '/tts' },
    ],
  },
  files: {
    label: 'Files',
    icon: '📁',
    shortLabel: 'Files',
    tools: [
      { id: 'converter',    label: 'Image Convert', icon: '🖼️', path: '/image-convert' },
      { id: 'markdown-csv', label: 'Markdown/CSV',  icon: '📊', path: '/markdown-csv' },
      { id: 'zigzag',       label: 'Zigzag PDF',    icon: '📄', path: '/zigzag' },
      { id: 'metadata',     label: 'Metadata',      icon: '🛡️', path: '/metadata' },
    ],
  },
};

const FLAT_TOOLS = Object.values(CATEGORIES).flatMap((c) =>
  c.tools.map((t) => ({ ...t, category: c.label }))
);

function getCategoryForPath(pathname) {
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (cat.tools.some((t) => t.path === pathname)) return key;
  }
  return 'dashboard';
}

export default function AppNav({ activeCategory, setActiveCategory }) {
  const category = CATEGORIES[activeCategory];
  const { pathname } = useLocation();

  return (
    <>
      {/* Sticky submenu band — only the tool strip lives here now */}
      <div className="nav-wrap">
        <div className="nav-wrap-inner">
          <div className="nav-submenu-panel">
            <div className="nav-submenu" role="tablist" aria-label="Tools">
              {category.tools.map((tool) => {
                const isActive = pathname === tool.path;
                return (
                  <NavLink
                    key={tool.id}
                    to={tool.path}
                    role="tab"
                    aria-selected={isActive}
                    className={`nav-tool-btn ${isActive ? 'active' : ''}`}
                  >
                    <span aria-hidden>{tool.icon}</span>
                    <span className="nav-tool-btn__label">{tool.label}</span>
                  </NavLink>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Mobile-only bottom bar — categories (UI filter, does not navigate) */}
      <nav className="nav-bottom" aria-label="Category shortcuts">
        {Object.entries(CATEGORIES).map(([key, cat]) => (
          <button
            key={key}
            type="button"
            className={`nav-bottom-btn ${activeCategory === key ? 'active' : ''}`}
            onClick={() => setActiveCategory(key)}
          >
            <span className="nav-bottom-btn__icon" aria-hidden>{cat.icon}</span>
            <span className="nav-bottom-btn__label">{cat.shortLabel}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

export { CATEGORIES, FLAT_TOOLS, getCategoryForPath };
