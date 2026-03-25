import React from 'react';

const CATEGORIES = {
  dashboard: {
    label: 'Dashboard',
    icon: '📊',
    shortLabel: 'Home',
    tools: [
      { id: 'crypto-trader', label: 'Upbit Bot', icon: '🤖' },
    ],
  },
  language: {
    label: 'Language',
    icon: '🌐',
    shortLabel: 'Language',
    tools: [
      { id: 'transcription', label: 'Video Transcribe', icon: '🎬' },
      { id: 'audio', label: 'Audio Transcribe', icon: '🎵' },
      { id: 'translator', label: 'Live Translate', icon: '🌐' },
      { id: 'image-to-text', label: 'Image to Text', icon: '📷' },
      { id: 'rewriter', label: 'Rewriter', icon: '✉️' },
      { id: 'tts', label: 'Text to Speech', icon: '📖' },
    ],
  },
  files: {
    label: 'Files',
    icon: '📁',
    shortLabel: 'Files',
    tools: [
      { id: 'converter', label: 'Image Convert', icon: '🖼️' },
      { id: 'markdown-csv', label: 'Markdown/CSV', icon: '📊' },
      { id: 'zigzag', label: 'Zigzag PDF', icon: '📄' },
      { id: 'metadata', label: 'Metadata', icon: '🛡️' },
    ],
  },
};

const FLAT_TOOLS = Object.values(CATEGORIES).flatMap((c) =>
  c.tools.map((t) => ({ ...t, category: c.label }))
);

function getCategoryForTab(tabId) {
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (cat.tools.some((t) => t.id === tabId)) return key;
  }
  return 'transcription';
}

export default function AppNav({ activeTab, onSelectTab, activeCategory, setActiveCategory }) {
  const category = CATEGORIES[activeCategory];

  return (
    <>
      {/* Sticky submenu band — only the tool strip lives here now */}
      <div className="nav-wrap">
        <div className="nav-wrap-inner">
          <div className="nav-submenu-panel">
            <div className="nav-submenu" role="tablist" aria-label="Tools">
              {category.tools.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tool.id}
                  className={`nav-tool-btn ${activeTab === tool.id ? 'active' : ''}`}
                  onClick={() => onSelectTab(tool.id)}
                >
                  <span aria-hidden>{tool.icon}</span>
                  <span className="nav-tool-btn__label">{tool.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Mobile-only bottom bar — categories */}
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

export { CATEGORIES, FLAT_TOOLS, getCategoryForTab };
