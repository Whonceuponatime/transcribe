import React, { useEffect, useRef, useState } from 'react';
import './TranscriptionPanel.css';

const TranscriptionPanel = ({
  transcription,
  setTranscription,
  isTranscribing,
  onStartTranscription,
  onStopTranscription,
  onClearTranscription,
  transcriptionHistory,
  currentTime,
  videoDuration,
  formatTime,
  videoFile // Add videoFile prop
}) => {
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState('');
  const [debugInfo, setDebugInfo] = useState('');
  const [browserInfo, setBrowserInfo] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [selectedLanguage, setSelectedLanguage] = useState('auto');
  const textareaRef = useRef(null);
  const audioContextRef = useRef(null);
  const mediaRecorderRef = useRef(null);

  // Detect browser and provide specific guidance
  useEffect(() => {
    const userAgent = navigator.userAgent;
    let browser = 'Unknown';
    let version = 'Unknown';
    
    if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) {
      browser = 'Chrome';
      version = userAgent.match(/Chrome\/(\d+)/)?.[1] || 'Unknown';
    } else if (userAgent.includes('Edg')) {
      browser = 'Edge';
      version = userAgent.match(/Edg\/(\d+)/)?.[1] || 'Unknown';
    } else if (userAgent.includes('Firefox')) {
      browser = 'Firefox';
      version = userAgent.match(/Firefox\/(\d+)/)?.[1] || 'Unknown';
    } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
      browser = 'Safari';
      version = userAgent.match(/Version\/(\d+)/)?.[1] || 'Unknown';
    }
    
    setBrowserInfo(`${browser} ${version}`);
    
    // Check for HTTPS in production
    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
      setError('Audio processing requires HTTPS in production. Please use a secure connection.');
      return;
    }

    // Check if Web Audio API is supported
    if (window.AudioContext || window.webkitAudioContext) {
      setIsSupported(true);
      setDebugInfo('Audio processing supported');
    } else {
      setIsSupported(false);
      setError('Audio processing is not supported in this browser. Please use Chrome or Edge.');
    }
  }, []);

  const extractAudioFromVideo = async (videoFile) => {
    try {
      const fileSizeMB = (videoFile.size / (1024 * 1024)).toFixed(2);
      setDebugInfo(`Processing video (${fileSizeMB} MB)...`);
      setIsProcessing(true);
      setProgress(5);

      // For large files, we'll skip client-side audio extraction and send directly to server
      setProgress(20);
      setDebugInfo(`Sending ${fileSizeMB} MB video to server for processing...`);

      // Send to transcription service
      const transcript = await transcribeAudio();
      setProgress(80);

      if (transcript) {
        setTranscription(transcript);
        setDebugInfo(`Transcription completed: ${transcript.length} characters`);
      } else {
        setError('No transcription result received');
      }

      setProgress(100);
      setIsProcessing(false);
    } catch (error) {
      console.error('Audio extraction error:', error);
      setError(`Audio extraction failed: ${error.message}`);
      setIsProcessing(false);
    }
  };

  const convertToWav = async (audioBuffer) => {
    // Convert AudioBuffer to WAV format
    const length = audioBuffer.length;
    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const arrayBuffer = new ArrayBuffer(44 + length * numberOfChannels * 2);
    const view = new DataView(arrayBuffer);

    // WAV header
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length * numberOfChannels * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numberOfChannels * 2, true);
    view.setUint16(32, numberOfChannels * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, length * numberOfChannels * 2, true);

    // Write audio data
    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(channel)[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  };

  const transcribeAudio = async () => {
    try {
      const fileSizeMB = (videoFile.size / (1024 * 1024)).toFixed(2);
      setDebugInfo(`Sending video for transcription (${fileSizeMB} MB)...`);
      
      // Create FormData with the video file
      const formData = new FormData();
      formData.append('video', videoFile);
      
      // Add language preference if not auto
      if (selectedLanguage !== 'auto') {
        formData.append('language', selectedLanguage);
      }
      
      // Send to our transcription API (backend server on port 3000)
      const serverUrl = window.location.origin.replace(/:\d+$/, ':3000');
      const response = await fetch(`${serverUrl}/api/transcribe`, {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) {
        let errorMessage = 'Transcription failed';
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorData.details || 'Transcription failed';
        } catch (parseError) {
          console.error('Failed to parse error response:', parseError);
        }
        throw new Error(errorMessage);
      }
      
      const result = await response.json();
      
      if (result.success && result.transcription) {
        setDebugInfo(`Transcription completed: ${result.transcription.length} characters (${fileSizeMB} MB video)`);
        return result.transcription;
      } else {
        throw new Error('No transcription result received');
      }
    } catch (error) {
      console.error('Transcription error:', error);
      throw new Error(`Transcription failed: ${error.message}`);
    }
  };

  const handleStartTranscription = async () => {
    if (!videoFile) {
      setError('No video file available for transcription');
      return;
    }

    setError('');
    setProgress(0);
    setDebugInfo('Starting video audio transcription...');
    onStartTranscription();
    
    try {
      await extractAudioFromVideo(videoFile);
    } catch (error) {
      console.error('Transcription failed:', error);
      setError(`Transcription failed: ${error.message}`);
      onStopTranscription();
    }
  };

  const handleStopTranscription = () => {
    setDebugInfo('User requested to stop transcription');
    setIsProcessing(false);
    setProgress(0);
    onStopTranscription();
  };

  const handleClearTranscription = () => {
    onClearTranscription();
  };

  const copyToClipboard = () => {
    if (transcription.trim()) {
      navigator.clipboard.writeText(transcription).then(() => {
        // Show a brief success message
        const button = document.querySelector('.copy-btn');
        if (button) {
          const originalText = button.textContent;
          button.textContent = 'Copied!';
          setTimeout(() => {
            button.textContent = originalText;
          }, 2000);
        }
      }).catch(err => {
        console.error('Failed to copy text: ', err);
      });
    }
  };

  const downloadTranscription = () => {
    if (transcription.trim()) {
      const blob = new Blob([transcription], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `transcription-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const getTroubleshootingSteps = () => {
    const steps = [
      '1. Ensure you\'re using Chrome or Edge browser',
      '2. Check that the video file contains audio',
      '3. Try with a different video file',
      '4. Refresh the page and try again',
      '5. Check your browser\'s audio settings'
    ];
    return steps.join('\n');
  };

  return (
    <div className="transcription-panel">
      <div className="panel-header">
        <h3>🎵 Video Audio Transcription</h3>
        
        {/* Language selection */}
        <div className="language-selector" style={{ marginBottom: '1rem' }}>
          <label htmlFor="language-select" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold', fontSize: '0.9rem' }}>
            Language:
          </label>
          <select
            id="language-select"
            value={selectedLanguage}
            onChange={(e) => setSelectedLanguage(e.target.value)}
            style={{
              padding: '0.5rem',
              borderRadius: '4px',
              border: '1px solid #ccc',
              fontSize: '14px',
              width: '100%',
              marginBottom: '1rem'
            }}
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
        
        <div className="transcription-controls">
          {!isTranscribing ? (
            <button
              className="start-btn"
              onClick={handleStartTranscription}
              disabled={!isSupported || !videoFile}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="10"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              Transcribe Video
            </button>
          ) : (
            <button
              className="stop-btn"
              onClick={handleStopTranscription}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12"/>
              </svg>
              Stop
            </button>
          )}
          
          <button
            className="clear-btn"
            onClick={handleClearTranscription}
            disabled={!transcription.trim()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 6h18"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            Clear
          </button>
        </div>
      </div>

      {/* Browser info */}
      {browserInfo && (
        <div className="browser-info" style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.5rem' }}>
          Browser: {browserInfo} | Audio Processing: {isSupported ? 'Supported' : 'Not Supported'}
        </div>
      )}

      {error && (
        <div className="error-message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          {error}
          <div style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>
            <strong>Troubleshooting steps:</strong>
            <pre style={{ fontSize: '0.8rem', marginTop: '0.25rem', whiteSpace: 'pre-line' }}>
              {getTroubleshootingSteps()}
            </pre>
          </div>
        </div>
      )}

      {!isSupported && (
        <div className="warning-message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          Audio processing requires Chrome or Edge browser
        </div>
      )}

      {/* Progress bar */}
      {isProcessing && (
        <div className="progress-container" style={{ marginBottom: '1rem' }}>
          <div className="progress-bar">
            <div 
              className="progress-fill" 
              style={{ width: `${progress}%` }}
            ></div>
          </div>
          <div className="progress-text">
            Processing: {progress}%
          </div>
        </div>
      )}

      {/* Debug info for troubleshooting */}
      {process.env.NODE_ENV === 'development' && debugInfo && (
        <div className="debug-info" style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.5rem' }}>
          Debug: {debugInfo} | Processing: {isProcessing ? 'Yes' : 'No'} | Supported: {isSupported ? 'Yes' : 'No'} | Video: {videoFile ? 'Yes' : 'No'}
        </div>
      )}

      <div className="transcription-content">
        <div className="transcription-textarea">
          <textarea
            ref={textareaRef}
            value={transcription}
            onChange={(e) => setTranscription(e.target.value)}
            placeholder={isTranscribing ? "Processing video audio..." : "Video transcription will appear here..."}
            readOnly={isTranscribing}
            className={isTranscribing ? 'listening' : ''}
          />
        </div>

        {transcription.trim() && (
          <div className="transcription-actions">
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
        )}
      </div>

      {transcriptionHistory.length > 0 && (
        <div className="transcription-history">
          <h4>📝 History</h4>
          <div className="history-list">
            {transcriptionHistory.map((item) => (
              <div key={item.id} className="history-item">
                <div className="history-header">
                  <span className="history-time">{item.timestamp}</span>
                  <span className="video-time">{formatTime(item.videoTime)}</span>
                </div>
                <div className="history-text">{item.text}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {videoDuration > 0 && (
        <div className="video-progress">
          <div className="progress-info">
            <span>Current: {formatTime(currentTime)}</span>
            <span>Duration: {formatTime(videoDuration)}</span>
          </div>
          <div className="progress-bar">
            <div 
              className="progress-fill" 
              style={{ width: `${(currentTime / videoDuration) * 100}%` }}
            ></div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TranscriptionPanel; 