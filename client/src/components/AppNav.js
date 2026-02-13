import React, { useState, useEffect } from 'react';

const CATEGORIES = {
  transcription: {
    label: 'Transcription',
    tools: [
      { id: 'transcription', label: 'Video Transcription', icon: '🎬' },
      { id: 'audio', label: 'Audio Transcription', icon: '🎵' },
      { id: 'translator', label: 'Live Translator', icon: '🌐' },
    ],
  },
  conversion: {
    label: 'Conversion',
    tools: [
      { id: 'converter', label: 'Image Converter', icon: '🖼️' },
      { id: 'markdown-csv', label: 'Markdown/CSV', icon: '📊' },
      { id: 'zigzag', label: 'Zigzag', icon: '📄' },
    ],
  },
  utilities: {
    label: 'Utilities',
    tools: [
      { id: 'rewriter', label: 'Email Rewriter', icon: '✉️' },
      { id: 'tts', label: 'Text to Speech', icon: '📖' },
      { id: 'metadata', label: 'Metadata Tools', icon: '🛡️' },
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

export default function AppNav({ activeTab, onSelectTab }) {
  const [activeCategory, setActiveCategory] = useState(() =>
    getCategoryForTab(activeTab)
  );

  useEffect(() => {
    setActiveCategory(getCategoryForTab(activeTab));
  }, [activeTab]);

  const category = CATEGORIES[activeCategory];

  return (
    <div className="nav-wrap">
      <div className="nav-categories">
        {Object.entries(CATEGORIES).map(([key, cat]) => (
          <button
            key={key}
            type="button"
            className={`nav-category-btn ${activeCategory === key ? 'active' : ''}`}
            onClick={() => setActiveCategory(key)}
          >
            {cat.label}
          </button>
        ))}
      </div>
      <div className="nav-submenu">
        {category.tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={`nav-tool-btn ${activeTab === tool.id ? 'active' : ''}`}
            onClick={() => onSelectTab(tool.id)}
          >
            <span aria-hidden>{tool.icon}</span> {tool.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export { FLAT_TOOLS, getCategoryForTab };
