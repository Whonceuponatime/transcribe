import React from 'react';
import { Link } from 'react-router-dom';
import { CATEGORIES } from './AppNav';

const TOOL_DESCRIPTIONS = {
  '/video-transcribe': 'Transcribe a video file with speaker timing.',
  '/audio-transcribe': 'Transcribe audio files to plain text.',
  '/translate':        'Live mic translation between EN and VI.',
  '/image-to-text':    'OCR text out of images, in any layout.',
  '/rewriter':         'Rewrite drafts into emails or messages.',
  '/tts':              'Convert text to speech, save audio.',
  '/image-convert':    'Convert and resize PNG, JPG, or WebP.',
  '/markdown-csv':     'Convert Markdown tables to CSV/TSV.',
  '/zigzag':           'Merge two PDFs page by page in zigzag order.',
  '/metadata':         'Strip EXIF and personal metadata from files.',
};

// Dashboard category is intentionally omitted — the trader has its own
// at-a-glance card above the grid.
const SECTION_KEYS = ['language', 'files'];

export default function ToolGrid() {
  return (
    <div className="home-grid">
      {SECTION_KEYS.map((key) => {
        const cat = CATEGORIES[key];
        if (!cat) return null;
        return (
          <section key={key} className="home-section" aria-label={cat.label}>
            <h2 className="home-section__title">{cat.label}</h2>
            <div className="home-section__cards">
              {cat.tools.map((tool) => (
                <Link key={tool.id} to={tool.path} className="home-card">
                  <span className="home-card__icon" aria-hidden>{tool.icon}</span>
                  <span className="home-card__title">{tool.label}</span>
                  <span className="home-card__desc">
                    {TOOL_DESCRIPTIONS[tool.path] || ''}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
