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
  formatTime
}) => {
  const [recognition, setRecognition] = useState(null);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState('');
  const [debugInfo, setDebugInfo] = useState('');
  const [browserInfo, setBrowserInfo] = useState('');
  const [isRecognitionActive, setIsRecognitionActive] = useState(false);
  const [micPermission, setMicPermission] = useState('unknown');
  const [hasError, setHasError] = useState(false);
  const [restartAttempts, setRestartAttempts] = useState(0);
  const [lastError, setLastError] = useState('');
  const [shouldRestart, setShouldRestart] = useState(false);
  const textareaRef = useRef(null);
  const recognitionRef = useRef(null);

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
      setError('Speech recognition requires HTTPS in production. Please use a secure connection.');
      return;
    }

    // Check microphone permission
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'microphone' }).then(result => {
        setMicPermission(result.state);
        setDebugInfo(`Microphone permission: ${result.state}`);
      });
    }
  }, []);

  // Initialize speech recognition only once
  useEffect(() => {
    if (recognitionRef.current) return; // Already initialized

    // Check if Web Speech API is supported
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      
      try {
        const recognitionInstance = new SpeechRecognition();
        
        recognitionInstance.continuous = true;
        recognitionInstance.interimResults = true;
        recognitionInstance.lang = 'en-US';
        recognitionInstance.maxAlternatives = 1;

        recognitionInstance.onstart = () => {
          console.log('Speech recognition started');
          setIsRecognitionActive(true);
          setHasError(false);
          setLastError('');
          setShouldRestart(false);
          setDebugInfo('Speech recognition started successfully');
          setError('');
        };

        recognitionInstance.onresult = (event) => {
          let finalTranscript = '';

          for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              finalTranscript += transcript;
            }
          }

          if (finalTranscript) {
            setTranscription(prev => prev + ' ' + finalTranscript);
            setDebugInfo(`Transcribed: "${finalTranscript}"`);
          }
        };

        recognitionInstance.onerror = (event) => {
          console.error('Speech recognition error:', event.error);
          setIsRecognitionActive(false);
          setHasError(true);
          setLastError(event.error);
          
          let errorMessage = `Speech recognition error: ${event.error}`;
          
          // Provide specific guidance for common errors
          switch(event.error) {
            case 'aborted':
              errorMessage = 'Speech recognition was aborted. This usually happens when the browser stops the recognition. Try refreshing the page and ensure you\'re using Chrome or Edge.';
              // Don't restart on aborted errors
              setShouldRestart(false);
              break;
            case 'audio-capture':
              errorMessage = 'Audio capture failed. Please check your microphone permissions and ensure your microphone is working.';
              setShouldRestart(false);
              break;
            case 'bad-grammar':
              errorMessage = 'Bad grammar error. This is usually a browser issue. Try refreshing the page.';
              setShouldRestart(false);
              break;
            case 'language-not-supported':
              errorMessage = 'Language not supported. The app is configured for English (US).';
              setShouldRestart(false);
              break;
            case 'network':
              errorMessage = 'Network error. Please check your internet connection.';
              setShouldRestart(true);
              break;
            case 'no-speech':
              errorMessage = 'No speech detected. Please speak clearly into your microphone.';
              setShouldRestart(true);
              break;
            case 'not-allowed':
              errorMessage = 'Microphone access denied. Please allow microphone access in your browser settings.';
              setShouldRestart(false);
              break;
            case 'service-not-allowed':
              errorMessage = 'Speech recognition service not allowed. Please check your browser settings.';
              setShouldRestart(false);
              break;
            default:
              errorMessage = `Speech recognition error: ${event.error}. Please try refreshing the page.`;
              setShouldRestart(false);
          }
          
          setError(errorMessage);
          setDebugInfo(`Error occurred: ${event.error}`);
          
          // Stop transcription on critical errors
          if (event.error === 'aborted' || event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            onStopTranscription();
          }
        };

        recognitionInstance.onend = () => {
          console.log('Speech recognition ended');
          setIsRecognitionActive(false);
          setDebugInfo('Speech recognition ended');
          
          // Only restart if we're still supposed to be transcribing AND no critical errors occurred
          if (isTranscribing && shouldRestart && restartAttempts < 2 && lastError !== 'aborted') {
            setTimeout(() => {
              try {
                if (isTranscribing && !isRecognitionActive && shouldRestart && restartAttempts < 2) {
                  setRestartAttempts(prev => prev + 1);
                  recognitionInstance.start();
                  setDebugInfo(`Restarting speech recognition... (attempt ${restartAttempts + 1})`);
                }
              } catch (error) {
                console.error('Error restarting recognition:', error);
                setError('Failed to restart speech recognition. Please try again.');
                onStopTranscription();
              }
            }, 3000); // Increased delay to prevent rapid restarts
          } else if (restartAttempts >= 2 || lastError === 'aborted') {
            setError('Speech recognition failed to start after multiple attempts. Please refresh the page and try again.');
            onStopTranscription();
          }
        };

        recognitionRef.current = recognitionInstance;
        setRecognition(recognitionInstance);
        setIsSupported(true);
        setDebugInfo('Speech recognition initialized successfully');
      } catch (error) {
        console.error('Error creating speech recognition:', error);
        setError('Failed to initialize speech recognition. Please ensure you\'re using Chrome or Edge browser.');
        setIsSupported(false);
      }
    } else {
      setIsSupported(false);
      setError('Speech recognition is not supported in this browser. Please use Chrome or Edge.');
    }

    // Cleanup function
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (error) {
          console.error('Error stopping recognition during cleanup:', error);
        }
        recognitionRef.current = null;
      }
    };
  }, []); // Empty dependency array - only run once

  // Handle transcription start/stop
  useEffect(() => {
    if (!recognitionRef.current) return;

    if (isTranscribing && !isRecognitionActive && !hasError) {
      try {
        setHasError(false);
        setRestartAttempts(0);
        setLastError('');
        setShouldRestart(false);
        recognitionRef.current.start();
        setDebugInfo('Starting speech recognition...');
      } catch (error) {
        console.error('Error starting recognition:', error);
        setError('Failed to start speech recognition. Please try refreshing the page.');
        setDebugInfo(`Start error: ${error.message}`);
      }
    } else if (!isTranscribing && isRecognitionActive) {
      try {
        recognitionRef.current.stop();
        setDebugInfo('Stopping speech recognition...');
      } catch (error) {
        console.error('Error stopping recognition:', error);
        setDebugInfo(`Stop error: ${error.message}`);
      }
    }
  }, [isTranscribing, isRecognitionActive, hasError]);

  const handleStartTranscription = async () => {
    setError('');
    setHasError(false);
    setRestartAttempts(0);
    setLastError('');
    setShouldRestart(false);
    setDebugInfo('User requested to start transcription');
    
    // Check microphone permission first
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop()); // Stop the stream immediately
      setMicPermission('granted');
      setDebugInfo('Microphone permission granted');
      onStartTranscription();
    } catch (error) {
      console.error('Microphone permission error:', error);
      setError('Microphone access denied. Please allow microphone access and try again.');
      setMicPermission('denied');
      setDebugInfo('Microphone permission denied');
    }
  };

  const handleStopTranscription = () => {
    setDebugInfo('User requested to stop transcription');
    setHasError(false);
    setRestartAttempts(0);
    setLastError('');
    setShouldRestart(false);
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
      '2. Allow microphone access when prompted',
      '3. Check that your microphone is working',
      '4. Try refreshing the page',
      '5. Disable any browser extensions that might interfere',
      '6. Check your browser\'s privacy settings'
    ];
    return steps.join('\n');
  };

  return (
    <div className="transcription-panel">
      <div className="panel-header">
        <h3>🎤 Transcription</h3>
        <div className="transcription-controls">
          {!isTranscribing ? (
            <button
              className="start-btn"
              onClick={handleStartTranscription}
              disabled={!isSupported}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="10"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              Start
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
          Browser: {browserInfo} | Mic Permission: {micPermission}
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
          {error.includes('aborted') && (
            <div style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>
              <strong>Troubleshooting steps:</strong>
              <pre style={{ fontSize: '0.8rem', marginTop: '0.25rem', whiteSpace: 'pre-line' }}>
                {getTroubleshootingSteps()}
              </pre>
            </div>
          )}
        </div>
      )}

      {!isSupported && (
        <div className="warning-message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          Speech recognition requires Chrome or Edge browser
        </div>
      )}

      {/* Debug info for troubleshooting */}
      {process.env.NODE_ENV === 'development' && debugInfo && (
        <div className="debug-info" style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.5rem' }}>
          Debug: {debugInfo} | Active: {isRecognitionActive ? 'Yes' : 'No'} | Supported: {isSupported ? 'Yes' : 'No'} | Errors: {hasError ? 'Yes' : 'No'} | Restarts: {restartAttempts} | LastError: {lastError} | ShouldRestart: {shouldRestart ? 'Yes' : 'No'}
        </div>
      )}

      <div className="transcription-content">
        <div className="transcription-textarea">
          <textarea
            ref={textareaRef}
            value={transcription}
            onChange={(e) => setTranscription(e.target.value)}
            placeholder={isTranscribing ? "Listening..." : "Transcription will appear here..."}
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