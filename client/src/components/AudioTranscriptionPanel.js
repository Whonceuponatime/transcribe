import React, { useState, useRef } from 'react';
import './AudioTranscriptionPanel.css';

// Whisper transcribes at 16 kHz mono internally, so downsampling here is
// effectively lossless for transcription and shrinks payload ~10×.
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SECONDS      = 60;
const CHUNK_SAMPLES      = TARGET_SAMPLE_RATE * CHUNK_SECONDS; // ~1.92 MB per WAV chunk

// Decode any browser-supported audio file (MP3/M4A/WAV/OGG/FLAC/WebM/...)
// to a single Float32 PCM buffer at 16 kHz mono.
async function decodeToMono16k(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx    = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('AudioContext is not supported in this browser');
  const ctx       = new AudioCtx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close();
  }

  const numChannels = decoded.numberOfChannels;
  const length      = decoded.length;
  const mono        = new Float32Array(length);
  for (let ch = 0; ch < numChannels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i] / numChannels;
  }

  const srcRate = decoded.sampleRate;
  if (srcRate === TARGET_SAMPLE_RATE) return mono;

  const ratio     = srcRate / TARGET_SAMPLE_RATE;
  const outLength = Math.floor(length / ratio);
  const out       = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const lo     = Math.floor(srcIdx);
    const hi     = Math.min(lo + 1, length - 1);
    const frac   = srcIdx - lo;
    out[i]       = mono[lo] * (1 - frac) + mono[hi] * frac;
  }
  return out;
}

function encodeWav(pcm, sampleRate) {
  const numSamples = pcm.length;
  const dataSize   = numSamples * 2;
  const buffer     = new ArrayBuffer(44 + dataSize);
  const view       = new DataView(buffer);
  const writeStr   = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, 1, true);              // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);              // block align
  view.setUint16(34, 16, true);             // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

const AudioTranscriptionPanel = () => {
  const [selectedFile, setSelectedFile] = useState(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [selectedLanguage, setSelectedLanguage] = useState('auto');
  const fileInputRef = useRef(null);

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file) {
      const fileExtension = file.name.toLowerCase().split('.').pop();
      const supportedFormats = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'wma'];
      
      if (supportedFormats.includes(fileExtension)) {
        setSelectedFile(file);
        setError('');
        setTranscription('');
      } else {
        setError(`Unsupported audio format. Supported formats: ${supportedFormats.join(', ')}`);
        setSelectedFile(null);
      }
    }
  };

  const handleTranscribe = async () => {
    if (!selectedFile) {
      setError('Please select an audio file first');
      return;
    }

    setIsTranscribing(true);
    setError('');
    setProgress(0);
    setTranscription('');

    try {
      // Decode in the browser, then split into 60 s WAV chunks and POST each
      // to the edge function. Vercel caps request bodies at 4.5 MB, so we
      // avoid hitting FUNCTION_PAYLOAD_TOO_LARGE by chunking client-side.
      setProgress(5);
      let pcm;
      try {
        pcm = await decodeToMono16k(selectedFile);
      } catch (decodeErr) {
        throw new Error(`Could not decode audio file (${decodeErr.message || 'unsupported codec'})`);
      }
      if (pcm.length === 0) throw new Error('Decoded audio is empty');
      setProgress(15);

      const numChunks      = Math.ceil(pcm.length / CHUNK_SAMPLES);
      const transcriptions = [];

      for (let i = 0; i < numChunks; i++) {
        const start    = i * CHUNK_SAMPLES;
        const end      = Math.min(start + CHUNK_SAMPLES, pcm.length);
        const chunkPcm = pcm.subarray(start, end);
        const wavBlob  = encodeWav(chunkPcm, TARGET_SAMPLE_RATE);

        const fd = new FormData();
        fd.append('audio', wavBlob, `chunk-${i}.wav`);
        if (selectedLanguage !== 'auto') fd.append('language', selectedLanguage);

        const response = await fetch('/api/transcribe-audio', { method: 'POST', body: fd });
        const rawBody  = await response.text();
        let result;
        try {
          result = rawBody ? JSON.parse(rawBody) : null;
        } catch {
          const snippet = rawBody.slice(0, 200).replace(/\s+/g, ' ').trim();
          throw new Error(
            `Chunk ${i + 1}/${numChunks}: non-JSON response (status ${response.status})` +
            (snippet ? `: ${snippet}` : '')
          );
        }
        if (!response.ok) {
          throw new Error(`Chunk ${i + 1}/${numChunks}: ${result?.error || `status ${response.status}`}`);
        }
        if (!result?.success || typeof result.transcription !== 'string') {
          throw new Error(`Chunk ${i + 1}/${numChunks}: no transcription returned`);
        }

        transcriptions.push(result.transcription.trim());
        setProgress(15 + Math.round(((i + 1) / numChunks) * 85));
      }

      setTranscription(transcriptions.filter(Boolean).join(' '));
      setProgress(100);

    } catch (error) {
      console.error('Transcription error:', error);
      setError(`Transcription failed: ${error.message}`);
    } finally {
      setIsTranscribing(false);
      setProgress(0);
    }
  };

  const handleClear = () => {
    setTranscription('');
    setSelectedFile(null);
    setError('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const copyToClipboard = () => {
    if (transcription) {
      navigator.clipboard.writeText(transcription);
    }
  };

  const downloadTranscription = () => {
    if (transcription) {
      const blob = new Blob([transcription], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `transcription-${selectedFile?.name?.split('.')[0] || 'audio'}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="audio-transcription-panel">
      <div className="panel-header">
        <h3>🎵 Audio Transcription</h3>
        <p className="subtitle">Direct audio-to-text transcription (no video processing)</p>
      </div>

      {/* Language selection */}
      <div className="language-selector">
        <label htmlFor="audio-language-select">Language:</label>
        <select
          id="audio-language-select"
          value={selectedLanguage}
          onChange={(e) => setSelectedLanguage(e.target.value)}
        >
          <option value="auto">Auto-detect (Recommended)</option>
          <option value="ko">Korean (한국어)</option>
          <option value="en">English</option>
          <option value="ja">Japanese (日本語)</option>
          <option value="zh">Chinese (中文)</option>
          <option value="es">Spanish (Español)</option>
          <option value="fr">French (Français)</option>
          <option value="de">German (Deutsch)</option>
          <option value="it">Italian (Italiano)</option>
          <option value="pt">Portuguese (Português)</option>
          <option value="ru">Russian (Русский)</option>
        </select>
      </div>

      {/* File upload */}
      <div className="file-upload">
        <label htmlFor="audio-file-input" className="file-input-label">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14,2 14,8 20,8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10,9 9,9 8,9"/>
          </svg>
          {selectedFile ? selectedFile.name : 'Choose Audio File'}
        </label>
        <input
          ref={fileInputRef}
          id="audio-file-input"
          type="file"
          accept=".mp3,.wav,.m4a,.aac,.ogg,.flac,.wma"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        {selectedFile && (
          <div className="file-info">
            <span>Size: {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB</span>
          </div>
        )}
      </div>

      {/* Supported formats */}
      <div className="supported-formats">
        <p><strong>Supported formats:</strong> MP3, WAV, M4A, AAC, OGG, FLAC, WMA</p>
      </div>

      {/* Error message */}
      {error && (
        <div className="error-message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          {error}
        </div>
      )}

      {/* Progress bar */}
      {isTranscribing && (
        <div className="progress-container">
          <div className="progress-bar">
            <div 
              className="progress-fill" 
              style={{ width: `${progress}%` }}
            ></div>
          </div>
          <div className="progress-text">
            Transcribing: {progress}%
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="controls">
        <button
          className="transcribe-btn"
          onClick={handleTranscribe}
          disabled={!selectedFile || isTranscribing}
        >
          {isTranscribing ? (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="10"/>
                <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
                <line x1="9" y1="9" x2="9.01" y2="9"/>
                <line x1="15" y1="9" x2="15.01" y2="9"/>
              </svg>
              Transcribing...
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
                <line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
              Transcribe Audio
            </>
          )}
        </button>

        <button
          className="clear-btn"
          onClick={handleClear}
          disabled={!selectedFile && !transcription}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 6h18"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          Clear
        </button>
      </div>

      {/* Transcription result */}
      {transcription && (
        <div className="transcription-result">
          <div className="result-header">
            <h4>Transcription Result</h4>
            <div className="result-actions">
              <button className="copy-btn" onClick={copyToClipboard}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                Copy
              </button>
              <button className="download-btn" onClick={downloadTranscription}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7,10 12,15 17,10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Download
              </button>
            </div>
          </div>
          <textarea
            value={transcription}
            onChange={(e) => setTranscription(e.target.value)}
            placeholder="Transcription will appear here..."
            readOnly={false}
            className="transcription-textarea"
          />
        </div>
      )}
    </div>
  );
};

export default AudioTranscriptionPanel;
