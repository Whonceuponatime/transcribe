import React, { useState } from 'react';
import './Rewriter.css';

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'ko', label: 'Korean' },
];

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'messenger', label: 'Messenger' },
];

const FORMALITY = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'professional', label: 'Professional' },
  { value: 'very formal', label: 'Very formal' },
];

const STRENGTH = [
  { value: 'light', label: 'Light' },
  { value: 'standard', label: 'Standard' },
  { value: 'strong', label: 'Strong' },
];

export default function Rewriter() {
  const [draft, setDraft] = useState('');
  const [rewritten, setRewritten] = useState('');
  const [language, setLanguage] = useState('en');
  const [channel, setChannel] = useState('email');
  const [formality, setFormality] = useState('neutral');
  const [strength, setStrength] = useState('light');
  const [preserveLineBreaks, setPreserveLineBreaks] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleRewrite = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;

    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft: trimmed,
          language,
          channel,
          formality,
          strength,
          preserveLineBreaks,
        }),
      });
      const contentType = res.headers.get('content-type');
      const text = await res.text();
      if (!contentType || !contentType.includes('application/json')) {
        if (res.status === 405) {
          throw new Error('Rewrite request not allowed (405). Run the backend server and, if using React dev server, set proxy in client/package.json to the backend (e.g. http://localhost:3001).');
        }
        throw new Error(text || `Server error (${res.status})`);
      }
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(data.error || data.details || 'Rewrite failed');
      setRewritten(data.rewritten ?? '');
    } catch (e) {
      setError(e.message || 'Rewrite failed');
      setRewritten('');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!rewritten) return;
    navigator.clipboard.writeText(rewritten);
  };

  const handleClear = () => {
    setDraft('');
    setRewritten('');
    setError(null);
  };

  const draftEmpty = !draft.trim();

  return (
    <div className="rewriter">
      <div className="rewriter-options">
        <div className="rewriter-option">
          <label>Language</label>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="rewriter-option">
          <label>Channel</label>
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CHANNELS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="rewriter-option">
          <label>Formality</label>
          <select value={formality} onChange={(e) => setFormality(e.target.value)}>
            {FORMALITY.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="rewriter-option">
          <label>Strength</label>
          <select value={strength} onChange={(e) => setStrength(e.target.value)}>
            {STRENGTH.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="rewriter-option rewriter-option--toggle">
          <label>
            <input
              type="checkbox"
              checked={preserveLineBreaks}
              onChange={(e) => setPreserveLineBreaks(e.target.checked)}
            />
            Preserve line breaks
          </label>
        </div>
      </div>

      <div className="rewriter-panes">
        <div className="rewriter-pane rewriter-pane--draft">
          <label className="rewriter-pane-label">Draft</label>
          <textarea
            className="rewriter-textarea"
            placeholder="Paste or type your email or announcement draft…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={12}
          />
        </div>
        <div className="rewriter-pane rewriter-pane--output">
          <label className="rewriter-pane-label">Rewritten</label>
          <div className="rewriter-output">
            {loading ? (
              <div className="rewriter-loading">Rewriting…</div>
            ) : error ? (
              <div className="rewriter-error">{error}</div>
            ) : rewritten ? (
              <pre className="rewriter-plain">{rewritten}</pre>
            ) : (
              <span className="rewriter-placeholder">Result will appear here (plain text only).</span>
            )}
          </div>
        </div>
      </div>

      <div className="rewriter-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={handleRewrite}
          disabled={draftEmpty || loading}
        >
          Rewrite
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleCopy}
          disabled={!rewritten}
        >
          Copy result
        </button>
        <button type="button" className="btn-ghost" onClick={handleClear}>
          Clear
        </button>
      </div>
    </div>
  );
}
