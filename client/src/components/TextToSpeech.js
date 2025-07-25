import React, { useState, useRef, useEffect } from 'react';
import { supabase } from '../supabase';
import './TextToSpeech.css';

const TextToSpeech = () => {
  const [text, setText] = useState('');
  const [isConverting, setIsConverting] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [savedTexts, setSavedTexts] = useState([]);
  const [selectedVoice, setSelectedVoice] = useState('nova');
  const [currentTextName, setCurrentTextName] = useState('');
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [showCleanedText, setShowCleanedText] = useState(false);
  const [originalText, setOriginalText] = useState('');
  const [downloadedFiles, setDownloadedFiles] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('openai');
  const [availableVoices, setAvailableVoices] = useState({
    openai: [],
    elevenlabs: []
  });
  const [isLoadingVoices, setIsLoadingVoices] = useState(false);
  const audioRef = useRef(null);
  const fileInputRef = useRef(null);

  // Load saved texts and downloaded files from localStorage on component mount
  useEffect(() => {
    const savedTextsFromStorage = localStorage.getItem('savedTexts');
    const downloadedFilesFromStorage = localStorage.getItem('downloadedFiles');
    
    if (savedTextsFromStorage) {
      setSavedTexts(JSON.parse(savedTextsFromStorage));
    }
    
    if (downloadedFilesFromStorage) {
      setDownloadedFiles(JSON.parse(downloadedFilesFromStorage));
    }
  }, []);

  // Fetch available voices on component mount
  useEffect(() => {
    fetchAvailableVoices();
  }, []);

  const fetchAvailableVoices = async () => {
    try {
      setIsLoadingVoices(true);
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      
      if (!token) {
        console.error('No authentication token available');
        return;
      }
      
      const response = await fetch('/api/voices', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.ok) {
        const voices = await response.json();
        setAvailableVoices(voices);
        
        // Set default voice based on provider
        if (voices.openai.length > 0) {
          setSelectedVoice(voices.openai[0].value);
        }
      }
    } catch (error) {
      console.error('Error fetching voices:', error);
    } finally {
      setIsLoadingVoices(false);
    }
  };

  // Save to localStorage whenever savedTexts or downloadedFiles change
  useEffect(() => {
    localStorage.setItem('savedTexts', JSON.stringify(savedTexts));
  }, [savedTexts]);

  useEffect(() => {
    localStorage.setItem('downloadedFiles', JSON.stringify(downloadedFiles));
  }, [downloadedFiles]);

  const defaultVoices = [
    { value: 'alloy', label: 'Alloy (Neutral)' },
    { value: 'echo', label: 'Echo (Warm)' },
    { value: 'fable', label: 'Fable (Storytelling)' },
    { value: 'onyx', label: 'Onyx (Deep)' },
    { value: 'nova', label: 'Nova (Bright & Energetic)' },
    { value: 'shimmer', label: 'Shimmer (Soft & Gentle)' }
  ];

  // Get current voices based on selected provider
  const getCurrentVoices = () => {
    if (selectedProvider === 'openai') {
      return availableVoices.openai.length > 0 ? availableVoices.openai : defaultVoices;
    } else {
      return availableVoices.elevenlabs;
    }
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        let content = e.target.result;
        
        // Store original text
        setOriginalText(e.target.result);
        
        // Clean markdown formatting for better speech
        content = cleanMarkdownForSpeech(content);
        
        setText(content);
        setCurrentTextName(file.name.replace(/\.[^/.]+$/, ''));
      };
      reader.readAsText(file);
    }
  };

  const cleanMarkdownForSpeech = (text) => {
    return text
      // Remove markdown links: [text](url) -> text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      
      // Remove inline code: `code` -> code
      .replace(/`([^`]+)`/g, '$1')
      
      // Remove code blocks: ```code``` -> code
      .replace(/```[\s\S]*?```/g, '')
      
      // Remove headers: # Header -> Header
      .replace(/^#{1,6}\s+/gm, '')
      
      // Remove bold/italic: **text** or *text* -> text
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      
      // Clean up table formatting
      .replace(/\|/g, ' ')
      .replace(/-{3,}/g, '')
      
      // Remove HTML tags if any
      .replace(/<[^>]*>/g, '')
      
      // Clean up extra whitespace
      .replace(/\n\s*\n/g, '\n\n')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const handleTextToSpeech = async () => {
    if (!text.trim()) {
      alert('Please enter some text to convert to speech');
      return;
    }

    setIsConverting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      
      if (!token) {
        throw new Error('No authentication token available');
      }
      
      const response = await fetch('/api/text-to-speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          text: text,
          voice: selectedVoice,
          provider: selectedProvider
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to convert text to speech');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      
      // Save to history with download info
      const fileName = `${currentTextName || 'speech'}_${selectedVoice}_${Date.now()}.mp3`;
      const newText = {
        id: Date.now(),
        name: currentTextName || `Text ${savedTexts.length + 1}`,
        text: text,
        voice: selectedVoice,
        provider: selectedProvider,
        timestamp: new Date().toLocaleString(),
        audioUrl: url,
        fileName: fileName,
        blob: blob
      };
      setSavedTexts(prev => [newText, ...prev]);
      
      // Add to downloaded files
      const downloadedFile = {
        id: Date.now(),
        name: currentTextName || `Speech ${downloadedFiles.length + 1}`,
        fileName: fileName,
        voice: selectedVoice,
        provider: selectedProvider,
        timestamp: new Date().toLocaleString(),
        size: (blob.size / 1024).toFixed(2) + ' KB'
      };
      setDownloadedFiles(prev => [downloadedFile, ...prev]);
      
    } catch (error) {
      console.error('Error converting text to speech:', error);
      
      // Try to get detailed error message
      let errorMessage = 'Failed to convert text to speech. Please try again.';
      if (error.message) {
        errorMessage = error.message;
      }
      
      alert(errorMessage);
    } finally {
      setIsConverting(false);
    }
  };

  const downloadAudio = (savedText) => {
    const link = document.createElement('a');
    link.href = savedText.audioUrl;
    link.download = savedText.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const playAudio = () => {
    if (audioRef.current) {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const pauseAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  };

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
    }
  };

  const loadSavedText = (savedText) => {
    setText(savedText.text);
    setSelectedVoice(savedText.voice);
    setSelectedProvider(savedText.provider || 'openai');
    setCurrentTextName(savedText.name);
    setAudioUrl(savedText.audioUrl);
  };

  const deleteSavedText = (id) => {
    setSavedTexts(prev => prev.filter(item => item.id !== id));
  };

  const deleteDownloadedFile = (id) => {
    setDownloadedFiles(prev => prev.filter(item => item.id !== id));
  };

  const clearText = () => {
    setText('');
    setAudioUrl(null);
    setCurrentTextName('');
    setIsPlaying(false);
  };

  const previewVoice = async () => {
    const sampleText = "Hello! This is a preview of how this voice sounds. Perfect for learning and studying.";
    
    setIsPreviewing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      
      if (!token) {
        throw new Error('No authentication token available');
      }
      
      const response = await fetch('/api/text-to-speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          text: sampleText,
          voice: selectedVoice,
          provider: selectedProvider
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to preview voice');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      
    } catch (error) {
      console.error('Error previewing voice:', error);
      alert('Failed to preview voice. Please try again.');
    } finally {
      setIsPreviewing(false);
    }
  };

  return (
    <div className="text-to-speech">
      <div className="tts-header">
        <h2>📖 Text to Speech</h2>
        <p>Convert text to audio for learning on the go</p>
      </div>

      <div className="tts-container">
        <div className="tts-input-section">
          <div className="file-upload-section">
            <h3>Upload Text File</h3>
            <input
              type="file"
              ref={fileInputRef}
              accept=".txt,.md,.doc,.docx"
              onChange={handleFileUpload}
              style={{ display: 'none' }}
            />
            <button 
              className="upload-btn"
              onClick={() => fileInputRef.current.click()}
            >
              📁 Choose File
            </button>
            <span className="file-hint">Supports .txt, .md, .doc, .docx files</span>
          </div>

          <div className="voice-selection">
            <h3>Select Provider & Voice</h3>
            
            <div className="provider-selection">
              <label className="provider-label">
                <input
                  type="radio"
                  name="provider"
                  value="openai"
                  checked={selectedProvider === 'openai'}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                />
                <span className="provider-text">OpenAI TTS</span>
              </label>
              <label className="provider-label">
                <input
                  type="radio"
                  name="provider"
                  value="elevenlabs"
                  checked={selectedProvider === 'elevenlabs'}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                />
                <span className="provider-text">ElevenLabs</span>
              </label>
            </div>

            <div className="voice-controls">
              <select 
                value={selectedVoice} 
                onChange={(e) => setSelectedVoice(e.target.value)}
                className="voice-select"
                disabled={isLoadingVoices}
              >
                {isLoadingVoices ? (
                  <option>Loading voices...</option>
                ) : (
                  getCurrentVoices().map(voice => (
                    <option key={voice.value} value={voice.value}>
                      {voice.label}
                    </option>
                  ))
                )}
              </select>
              <button 
                onClick={previewVoice}
                disabled={isPreviewing || isLoadingVoices}
                className="preview-btn"
              >
                {isPreviewing ? '🔄 Previewing...' : '🎵 Preview Voice'}
              </button>
            </div>
            
            <p className="voice-hint">
              {selectedProvider === 'openai' 
                ? 'Try "Nova" for a bright, energetic voice or "Shimmer" for a soft, gentle voice'
                : 'ElevenLabs offers 100+ voices with various accents and styles'
              }
            </p>
          </div>

          <div className="text-input-section">
            <h3>Text Content</h3>
            <input
              type="text"
              placeholder="Enter a name for this text (optional)"
              value={currentTextName}
              onChange={(e) => setCurrentTextName(e.target.value)}
              className="text-name-input"
            />
            
            {originalText && (
              <div className="text-toggle">
                <button 
                  onClick={() => setShowCleanedText(!showCleanedText)}
                  className="toggle-btn"
                >
                  {showCleanedText ? '📄 Show Original' : '🎵 Show Cleaned for Speech'}
                </button>
                <span className="toggle-hint">
                  {showCleanedText ? 'Showing cleaned text (what will be spoken)' : 'Showing original markdown'}
                </span>
              </div>
            )}
            
            <textarea
              value={showCleanedText ? text : (originalText || text)}
              onChange={(e) => {
                if (showCleanedText) {
                  setText(e.target.value);
                } else {
                  setOriginalText(e.target.value);
                  setText(cleanMarkdownForSpeech(e.target.value));
                }
              }}
              placeholder="Paste or type your text here... (no character limit)"
              className="text-input"
            />
            <div className="text-counter">
              {text.length} characters (will be spoken)
            </div>
          </div>

          <div className="tts-controls">
            <button 
              onClick={handleTextToSpeech}
              disabled={isConverting || !text.trim()}
              className="convert-btn"
            >
              {isConverting ? '🔄 Converting...' : '🎵 Convert to Speech'}
            </button>
            <button onClick={clearText} className="clear-btn">
              🗑️ Clear
            </button>
          </div>
        </div>

        <div className="tts-output-section">
          <h3>Audio Player</h3>
          {audioUrl && (
            <div className="audio-player">
              <audio
                ref={audioRef}
                src={audioUrl}
                onEnded={() => setIsPlaying(false)}
                onPause={() => setIsPlaying(false)}
                onPlay={() => setIsPlaying(true)}
              />
              <div className="audio-controls">
                <button onClick={playAudio} disabled={isPlaying} className="play-btn">
                  ▶️ Play
                </button>
                <button onClick={pauseAudio} disabled={!isPlaying} className="pause-btn">
                  ⏸️ Pause
                </button>
                <button onClick={stopAudio} className="stop-btn">
                  ⏹️ Stop
                </button>
                <button 
                  onClick={() => downloadAudio(savedTexts[0])}
                  className="download-btn"
                >
                  💾 Download
                </button>
              </div>
              <div className="audio-info">
                <p>Voice: {getCurrentVoices().find(v => v.value === selectedVoice)?.label}</p>
                <p>Text length: {text.length} characters</p>
              </div>
            </div>
          )}

          <div className="saved-texts">
            <h3>Saved Texts</h3>
            {savedTexts.length === 0 ? (
              <p className="no-saved-texts">No saved texts yet. Convert some text to speech to see them here!</p>
            ) : (
              <div className="saved-texts-list">
                {savedTexts.map((savedText) => (
                  <div key={savedText.id} className="saved-text-item">
                    <div className="saved-text-info">
                      <h4>{savedText.name}</h4>
                      <p>Voice: {getCurrentVoices().find(v => v.value === savedText.voice)?.label || savedText.voice}</p>
                      <p>Provider: {savedText.provider || 'OpenAI'}</p>
                      <p>Length: {savedText.text.length} characters</p>
                      <p>Created: {savedText.timestamp}</p>
                    </div>
                    <div className="saved-text-actions">
                      <button 
                        onClick={() => loadSavedText(savedText)}
                        className="load-btn"
                      >
                        📂 Load
                      </button>
                      <button 
                        onClick={() => downloadAudio(savedText)}
                        className="download-btn"
                      >
                        💾 Download
                      </button>
                      <button 
                        onClick={() => deleteSavedText(savedText.id)}
                        className="delete-btn"
                      >
                        🗑️ Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="downloaded-files">
            <h3>Downloaded Files</h3>
            {downloadedFiles.length === 0 ? (
              <p className="no-downloaded-files">No downloaded files yet. Download some audio files to see them here!</p>
            ) : (
              <div className="downloaded-files-list">
                {downloadedFiles.map((file) => (
                  <div key={file.id} className="downloaded-file-item">
                    <div className="downloaded-file-info">
                      <h4>{file.name}</h4>
                      <p>Voice: {getCurrentVoices().find(v => v.value === file.voice)?.label || file.voice}</p>
                      <p>Provider: {file.provider || 'OpenAI'}</p>
                      <p>File: {file.fileName}</p>
                      <p>Size: {file.size}</p>
                      <p>Downloaded: {file.timestamp}</p>
                    </div>
                    <div className="downloaded-file-actions">
                      <button 
                        onClick={() => deleteDownloadedFile(file.id)}
                        className="delete-btn"
                      >
                        🗑️ Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TextToSpeech; 