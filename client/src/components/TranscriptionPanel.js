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

  const [copySuccess, setCopySuccess] = useState(false);
  const copyWithFeedback = () => {
    if (!transcription.trim()) return;
    navigator.clipboard.writeText(transcription).then(() => {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="transcription-panel card">
      <h3 className="card-title">Video transcription</h3>

      {/* Step flow */}
      <div className="transcription-steps">
        <span className={videoFile ? 'step-done' : 'step-pending'}>1. Upload file</span>
        <span className="step-done">2. Language</span>
        <span className={transcription.trim() ? 'step-done' : isProcessing ? 'step-active' : 'step-pending'}>3. Transcribe</span>
        <span className={transcription.trim() ? 'step-done' : 'step-pending'}>4. Copy / Download</span>
      </div>

      {/* Checklist */}
      <div className="transcription-checklist">
        <span className={videoFile ? 'check-item check-done' : 'check-item'}>
          {videoFile ? '✓' : '○'} File selected
        </span>
      </div>

      {/* Toolbar: Language + actions */}
      <div className="transcription-toolbar">
        <label htmlFor="language-select" className="toolbar-label">Language</label>
        <select
          id="language-select"
          value={selectedLanguage}
          onChange={(e) => setSelectedLanguage(e.target.value)}
          className="toolbar-select"
        >
          <option value="auto">Auto-detect</option>
          <option value="ko">Korean</option>
          <option value="en">English</option>
          <option value="ja">Japanese</option>
          <option value="zh">Chinese</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="it">Italian</option>
          <option value="pt">Portuguese</option>
          <option value="ru">Russian</option>
        </select>
        <div className="transcription-controls">
          {!isTranscribing ? (
            <button
              type="button"
              className="btn-primary start-btn"
              onClick={handleStartTranscription}
              disabled={!isSupported || !videoFile}
            >
              {isProcessing ? 'Transcribing…' : 'Transcribe Video'}
            </button>
          ) : (
            <button type="button" className="btn-secondary stop-btn" onClick={handleStopTranscription}>
              Stop
            </button>
          )}
          <button
            type="button"
            className="btn-ghost clear-btn"
            onClick={handleClearTranscription}
            disabled={!transcription.trim()}
          >
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
            <button type="button" className="btn-secondary copy-btn" onClick={copyWithFeedback}>
              {copySuccess ? '✓ Copied!' : 'Copy'}
            </button>
            <button type="button" className="btn-secondary download-btn" onClick={downloadTranscription}>
              Download TXT
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