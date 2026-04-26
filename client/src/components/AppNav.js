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
      {/* Sticky band under the header.
          Desktop: tools sub-strip (.nav-submenu-panel).
          Mobile:  category chips (.nav-categories--mobile).
          Both render in the DOM; CSS media queries pick which is visible. */}
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

          <div className="nav-categories nav-categories--mobile" role="tablist" aria-label="Categories">
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
        </div>
      </div>

      {/* Mobile-only fixed bottom bar — tools of the active category as
          NavLinks. Tap navigates; .active tracks the URL via NavLink + the
          isActive computation below (kept in parallel for aria-selected). */}
      <nav className="nav-bottom" aria-label="Tools">
        {category.tools.map((tool) => {
          const isActive = pathname === tool.path;
          return (
            <NavLink
              key={tool.id}
              to={tool.path}
              aria-current={isActive ? 'page' : undefined}
              className={`nav-bottom-btn nav-bottom-btn--tool ${isActive ? 'active' : ''}`}
            >
              <span className="nav-bottom-btn__icon" aria-hidden>{tool.icon}</span>
              <span className="nav-bottom-btn__label">{tool.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </>
  );
}

export { CATEGORIES, FLAT_TOOLS, getCategoryForPath };
