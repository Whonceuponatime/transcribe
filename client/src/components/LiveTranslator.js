import React, { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';
import './LiveTranslator.css';

const LiveTranslator = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState('en'); // 'en' or 'vi'
  const [targetLanguage, setTargetLanguage] = useState('vi'); // 'en' or 'vi'
  const [transcription, setTranscription] = useState('');
  const [translation, setTranslation] = useState('');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [translationHistory, setTranslationHistory] = useState([]);

  const mediaStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const socketRef = useRef(null);
  const recordingStartTimeRef = useRef(null);

  useEffect(() => {
    // Initialize socket connection - use current host instead of hardcoded localhost
    const serverUrl = window.location.origin.replace(/:\d+$/, ':3000');
    socketRef.current = io(serverUrl, {
      transports: ['websocket', 'polling']
    });

    socketRef.current.on('connect', () => {
      console.log('Connected to server');
      setError('');
    });

    socketRef.current.on('disconnect', () => {
      console.log('Disconnected from server');
    });

    socketRef.current.on('transcription', (data) => {
      if (data.text) {
        setTranscription(prev => {
          const newText = prev ? `${prev} ${data.text}` : data.text;
          return newText;
        });
        setIsProcessing(false);
      }
    });

    socketRef.current.on('translation', (data) => {
      if (data.text) {
        setTranslation(prev => {
          const newText = prev ? `${prev} ${data.text}` : data.text;
          return newText;
        });
      }
    });

    socketRef.current.on('error', (error) => {
      setError(error.message || 'An error occurred');
      setIsProcessing(false);
      setIsRecording(false);
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
      stopRecording();
    };
  }, []);

  const startRecording = async () => {
    try {
      setError('');
      setTranscription('');
      setTranslation('');
      setIsProcessing(false);

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });

      mediaStreamRef.current = stream;

      // Create audio context
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000
      });
      audioContextRef.current = audioContext;

      // Create media stream source
      const source = audioContext.createMediaStreamSource(stream);
      
      // Create script processor for audio chunks
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!isRecording) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const buffer = new Int16Array(inputData.length);

        // Convert float32 to int16
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Send audio chunk to server
        if (socketRef.current && socketRef.current.connected) {
          socketRef.current.emit('audio-chunk', {
            audio: Array.from(buffer),
            sourceLanguage: sourceLanguage,
            targetLanguage: targetLanguage
          });
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      setIsRecording(true);
      recordingStartTimeRef.current = Date.now();
      setIsProcessing(true);

      // Notify server that recording started
      socketRef.current.emit('start-recording', {
        sourceLanguage,
        targetLanguage
      });

    } catch (err) {
      console.error('Error accessing microphone:', err);
      setError(`Microphone access denied: ${err.message}`);
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('stop-recording');
    }

    setIsRecording(false);
    setIsProcessing(false);

    // Save to history if there's content
    if (transcription.trim() || translation.trim()) {
      setTranslationHistory(prev => [...prev, {
        id: Date.now(),
        source: transcription,
        translation: translation,
        sourceLang: sourceLanguage,
        targetLang: targetLanguage,
        timestamp: new Date().toLocaleString()
      }]);
    }
  };

  const clearText = () => {
    setTranscription('');
    setTranslation('');
    setError('');
  };

  const swapLanguages = () => {
    const temp = sourceLanguage;
    setSourceLanguage(targetLanguage);
    setTargetLanguage(temp);
    clearText();
  };

  const copyToClipboard = (text) => {
    if (text) {
      navigator.clipboard.writeText(text);
    }
  };

  const formatTime = (milliseconds) => {
    const seconds = Math.floor(milliseconds / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const recordingDuration = isRecording && recordingStartTimeRef.current
    ? Date.now() - recordingStartTimeRef.current
    : 0;

  return (
    <div className="live-translator">
      <div className="translator-header">
        <h3>🌐 Live Translator</h3>
        <p className="subtitle">Real-time audio translation using Whisper</p>
      </div>

      {/* Language Selection */}
      <div className="language-selection">
        <div className="language-group">
          <label>From:</label>
          <select
            value={sourceLanguage}
            onChange={(e) => setSourceLanguage(e.target.value)}
            disabled={isRecording}
          >
            <option value="en">English</option>
            <option value="vi">Vietnamese (Tiếng Việt)</option>
          </select>
        </div>

        <button
          className="swap-btn"
          onClick={swapLanguages}
          disabled={isRecording}
          title="Swap languages"
        >
          ⇄
        </button>

        <div className="language-group">
          <label>To:</label>
          <select
            value={targetLanguage}
            onChange={(e) => setTargetLanguage(e.target.value)}
            disabled={isRecording}
          >
            <option value="en">English</option>
            <option value="vi">Vietnamese (Tiếng Việt)</option>
          </select>
        </div>
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

      {/* Recording Controls */}
      <div className="recording-controls">
        {!isRecording ? (
          <button
            className="start-btn"
            onClick={startRecording}
            disabled={isProcessing}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="10"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            Start Recording
          </button>
        ) : (
          <div className="recording-status">
            <div className="recording-indicator">
              <span className="pulse-dot"></span>
              <span>Recording... {formatTime(recordingDuration)}</span>
            </div>
            <button
              className="stop-btn"
              onClick={stopRecording}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
              </svg>
              Stop Recording
            </button>
          </div>
        )}

        <button
          className="clear-btn"
          onClick={clearText}
          disabled={isRecording || (!transcription && !translation)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 6h18"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          Clear
        </button>
      </div>

      {/* Processing indicator */}
      {isProcessing && (
        <div className="processing-indicator">
          <div className="spinner"></div>
          <span>Processing audio...</span>
        </div>
      )}

      {/* Transcription and Translation Display */}
      <div className="translation-display">
        <div className="text-panel">
          <div className="panel-header">
            <h4>
              {sourceLanguage === 'en' ? 'English' : 'Tiếng Việt'} 
              <span className="lang-badge">Original</span>
            </h4>
            {transcription && (
              <button
                className="copy-icon-btn"
                onClick={() => copyToClipboard(transcription)}
                title="Copy"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>
            )}
          </div>
          <textarea
            value={transcription}
            readOnly
            placeholder="Original transcription will appear here..."
            className="translation-textarea original"
          />
        </div>

        <div className="text-panel">
          <div className="panel-header">
            <h4>
              {targetLanguage === 'en' ? 'English' : 'Tiếng Việt'}
              <span className="lang-badge">Translated</span>
            </h4>
            {translation && (
              <button
                className="copy-icon-btn"
                onClick={() => copyToClipboard(translation)}
                title="Copy"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>
            )}
          </div>
          <textarea
            value={translation}
            readOnly
            placeholder="Translation will appear here..."
            className="translation-textarea translated"
          />
        </div>
      </div>

      {/* Translation History */}
      {translationHistory.length > 0 && (
        <div className="translation-history">
          <h4>History</h4>
          <div className="history-list">
            {translationHistory.slice().reverse().map((item) => (
              <div key={item.id} className="history-item">
                <div className="history-header">
                  <span className="history-time">{item.timestamp}</span>
                  <button
                    className="delete-history-btn"
                    onClick={() => {
                      setTranslationHistory(prev => prev.filter(i => i.id !== item.id));
                    }}
                  >
                    ×
                  </button>
                </div>
                <div className="history-content">
                  <div className="history-original">
                    <strong>{item.sourceLang === 'en' ? 'EN' : 'VI'}:</strong> {item.source}
                  </div>
                  <div className="history-translation">
                    <strong>{item.targetLang === 'en' ? 'EN' : 'VI'}:</strong> {item.translation}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default LiveTranslator;



