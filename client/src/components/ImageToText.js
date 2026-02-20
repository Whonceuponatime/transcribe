import React, { useState, useCallback, useRef } from 'react';
import './ImageToText.css';

const FORMATS = [
  { value: 'plain', label: 'Plain text' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'structured', label: 'Structured (tables/lists as Markdown)' },
];

const MAX_IMAGE_SIZE_MB = 20;
const MAX_IMAGE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('File must be an image (JPEG, PNG, WebP, GIF).'));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`Image must be under ${MAX_IMAGE_SIZE_MB} MB.`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

export default function ImageToText() {
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [imageName, setImageName] = useState('');
  const [format, setFormat] = useState('plain');
  const [instructions, setInstructions] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const setImageFromFile = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return;
    setError(null);
    fileToDataUrl(file)
      .then((dataUrl) => {
        setImageDataUrl(dataUrl);
        setImageName(file.name || 'Pasted image');
      })
      .catch((e) => setError(e.message));
  }, []);

  const handlePaste = useCallback(
    (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) setImageFromFile(file);
          return;
        }
      }
    },
    [setImageFromFile]
  );

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer?.files?.[0];
      if (file) setImageFromFile(file);
    },
    [setImageFromFile]
  );

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleFileSelect = (e) => {
    const file = e.target?.files?.[0];
    if (file) setImageFromFile(file);
    e.target.value = '';
  };

  const handleTranscribe = async () => {
    if (!imageDataUrl) {
      setError('Paste or upload an image first.');
      return;
    }
    setError(null);
    setLoading(true);
    setResult('');
    try {
      const res = await fetch('/api/image-to-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageDataUrl,
          format,
          instructions: instructions.trim() || undefined,
        }),
      });
      const contentType = res.headers.get('content-type');
      const text = await res.text();
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error(text || `Server error (${res.status})`);
      }
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(data.error || data.details || 'Transcription failed');
      setResult(data.text ?? '');
    } catch (e) {
      setError(e.message || 'Transcription failed');
      setResult('');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!result) return;
    navigator.clipboard.writeText(result);
  };

  const handleClear = () => {
    setImageDataUrl(null);
    setImageName('');
    setResult('');
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const hasImage = !!imageDataUrl;

  return (
    <div className="image-to-text" onPaste={handlePaste}>
      <div className="image-to-text-options">
        <div className="image-to-text-option">
          <label>Output format</label>
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="image-to-text-panes">
        <div className="image-to-text-pane image-to-text-pane--input">
          <label className="image-to-text-pane-label">Image</label>
          <div
            className={`image-to-text-dropzone ${hasImage ? 'has-image' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          >
            {hasImage ? (
              <div className="image-to-text-preview-wrap">
                <img src={imageDataUrl} alt="Preview" className="image-to-text-preview" />
                <p className="image-to-text-filename">{imageName}</p>
                <button type="button" className="btn-ghost image-to-text-remove" onClick={handleClear}>
                  Remove image
                </button>
              </div>
            ) : (
              <>
                <p className="image-to-text-dropzone-hint">Paste (Ctrl+V) or drop an image here</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileSelect}
                  className="image-to-text-file-input"
                  aria-label="Upload image"
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose file
                </button>
              </>
            )}
          </div>
          <div className="image-to-text-option image-to-text-instructions">
            <label>Optional instructions (e.g. “extract only the table”, “transcribe handwritten notes”)</label>
            <textarea
              className="image-to-text-instructions-input"
              placeholder="Leave blank for general transcription..."
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <div className="image-to-text-pane image-to-text-pane--output">
          <label className="image-to-text-pane-label">Transcribed text</label>
          <div className="image-to-text-output">
            {loading && <div className="image-to-text-loading">Transcribing…</div>}
            {error && <div className="image-to-text-error">{error}</div>}
            {!loading && result && (
              <pre className="image-to-text-plain">{result}</pre>
            )}
            {!loading && !result && !error && (
              <span className="image-to-text-placeholder">Result will appear here.</span>
            )}
          </div>
        </div>
      </div>

      <div className="image-to-text-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={!hasImage || loading}
          onClick={handleTranscribe}
        >
          Transcribe image
        </button>
        {result && (
          <button type="button" className="btn-secondary" onClick={handleCopy}>
            Copy result
          </button>
        )}
        <button type="button" className="btn-ghost" onClick={handleClear}>
          Clear
        </button>
      </div>
    </div>
  );
}
