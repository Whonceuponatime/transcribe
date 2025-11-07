import React, { useState, useRef } from 'react';
import './AudioTranscriptionPanel.css';
import { authenticatedFetch } from '../lib/api';

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
      const formData = new FormData();
      formData.append('audio', selectedFile);
      
      // Add language preference if not auto
      if (selectedLanguage !== 'auto') {
        formData.append('language', selectedLanguage);
      }

      setProgress(20);
      
      const response = await authenticatedFetch('/api/transcribe-audio', {
        method: 'POST',
        body: formData
      });

      setProgress(80);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Transcription failed');
      }

      const result = await response.json();
      
      if (result.success && result.transcription) {
        setTranscription(result.transcription);
        setProgress(100);
      } else {
        throw new Error('No transcription result received');
      }

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
