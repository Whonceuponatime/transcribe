import React, { useState, useCallback, useRef } from 'react';
import './ImageToText.css';

const FORMATS = [
  { value: 'plain', label: 'Plain text' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'structured', label: 'Structured (tables/lists as Markdown)' },
];

const MAX_IMAGE_SIZE_MB = 20;
const MAX_IMAGE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;
const MAX_IMAGES = 20;

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
  const [images, setImages] = useState([]);
  const [format, setFormat] = useState('plain');
  const [instructions, setInstructions] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const addImages = useCallback((files) => {
    const list = Array.from(files || []).filter(f => f.type?.startsWith('image/'));
    if (!list.length) return;
    setError(null);
    const toAdd = list.slice(0, MAX_IMAGES);
    Promise.all(toAdd.map(f => fileToDataUrl(f)))
      .then(dataUrls => {
        setImages(prev => {
          const space = MAX_IMAGES - prev.length;
          if (space <= 0) return prev;
          const adding = dataUrls.slice(0, space);
          return [...prev, ...adding.map((url, i) => ({
            id: Date.now() + i,
            url,
            name: toAdd[i]?.name || `Image ${prev.length + i + 1}`
          }))].slice(0, MAX_IMAGES);
        });
      })
      .catch(e => setError(e.message));
  }, []);

  const removeImage = useCallback((id) => {
    setImages(prev => prev.filter(img => img.id !== id));
  }, []);

  const moveImage = useCallback((id, dir) => {
    setImages(prev => {
      const i = prev.findIndex(img => img.id === id);
      if (i === -1 || (dir < 0 && i === 0) || (dir > 0 && i === prev.length - 1)) return prev;
      const next = [...prev];
      [next[i], next[i + dir]] = [next[i + dir], next[i]];
      return next;
    });
  }, []);

  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addImages([file]);
        return;
      }
    }
  }, [addImages]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer?.files;
    if (files?.length) addImages(files);
  }, [addImages]);

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleFileSelect = (e) => {
    const files = e.target?.files;
    if (files?.length) addImages(files);
    e.target.value = '';
  };

  const handleTranscribe = async () => {
    if (!images.length) {
      setError('Add at least one image.');
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
          images: images.map(img => img.url),
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
    setImages([]);
    setResult('');
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const hasImages = images.length > 0;

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
          <label className="image-to-text-pane-label">Images (order preserved)</label>
          <div
            className={`image-to-text-dropzone ${hasImages ? 'has-images' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          >
            {hasImages ? (
              <div className="image-to-text-preview-list">
                {images.map((img, idx) => (
                  <div key={img.id} className="image-to-text-preview-item">
                    <span className="image-to-text-preview-num">{idx + 1}</span>
                    <img src={img.url} alt="" className="image-to-text-preview-thumb" />
                    <span className="image-to-text-preview-name" title={img.name}>
                      {img.name.length > 20 ? img.name.slice(0, 17) + '…' : img.name}
                    </span>
                    <div className="image-to-text-preview-actions">
                      <button
                        type="button"
                        className="btn-ghost image-to-text-btn-sm"
                        onClick={() => moveImage(img.id, -1)}
                        disabled={idx === 0}
                        title="Move up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn-ghost image-to-text-btn-sm"
                        onClick={() => moveImage(img.id, 1)}
                        disabled={idx === images.length - 1}
                        title="Move down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="btn-ghost image-to-text-btn-sm"
                        onClick={() => removeImage(img.id)}
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
                {images.length < MAX_IMAGES && (
                  <label className="image-to-text-add-more">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleFileSelect}
                      className="image-to-text-file-input"
                    />
                    <span className="image-to-text-add-more-btn">+ Add more</span>
                  </label>
                )}
              </div>
            ) : (
              <>
                <p className="image-to-text-dropzone-hint">Paste (Ctrl+V), drop, or select images</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFileSelect}
                  className="image-to-text-file-input"
                  aria-label="Upload images"
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose files
                </button>
              </>
            )}
          </div>
          <div className="image-to-text-option image-to-text-instructions">
            <label>Optional instructions (e.g. “extract only the table”, “transcribe in order”)</label>
            <textarea
              className="image-to-text-instructions-input"
              placeholder="Leave blank for general transcription. Images are transcribed in the order shown above."
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <div className="image-to-text-pane image-to-text-pane--output">
          <label className="image-to-text-pane-label">Transcribed text</label>
          <div className="image-to-text-output">
            {loading && (
              <div className="image-to-text-loading">
                Transcribing {images.length} image{images.length !== 1 ? 's' : ''}…
              </div>
            )}
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
          disabled={!hasImages || loading}
          onClick={handleTranscribe}
        >
          Transcribe {images.length > 0 ? `(${images.length})` : ''} image{images.length !== 1 ? 's' : ''}
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
