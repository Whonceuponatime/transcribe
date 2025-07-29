import React, { useState, useRef } from 'react';
import './TextToSpeech.css';

const TextToSpeech = () => {
  const [text, setText] = useState('');
  const [isConverting, setIsConverting] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [savedTexts, setSavedTexts] = useState([]);
  const [selectedVoice, setSelectedVoice] = useState('jOEnNSVLOHUgmrNwfqQE');
  const [selectedProvider, setSelectedProvider] = useState('elevenlabs');
  const [currentTextName, setCurrentTextName] = useState('');
  const audioRef = useRef(null);
  const fileInputRef = useRef(null);

  const elevenlabsVoices = [
    { value: 'jOEnNSVLOHUgmrNwfqQE', label: 'Custom Voice (ElevenLabs)' }
  ];

  const openaiVoices = [
    { value: 'alloy', label: 'Alloy (OpenAI)' },
    { value: 'echo', label: 'Echo (OpenAI)' },
    { value: 'fable', label: 'Fable (OpenAI)' },
    { value: 'onyx', label: 'Onyx (OpenAI)' },
    { value: 'nova', label: 'Nova (OpenAI)' },
    { value: 'shimmer', label: 'Shimmer (OpenAI)' }
  ];

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setText(e.target.result);
        setCurrentTextName(file.name.replace(/\.[^/.]+$/, ''));
      };
      reader.readAsText(file);
    }
  };

  const handleTextToSpeech = async () => {
    if (!text.trim()) {
      alert('Please enter some text to convert to speech');
      return;
    }

    setIsConverting(true);
    try {
      const response = await fetch('/api/text-to-speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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
      
      // Save to history
      const newText = {
        id: Date.now(),
        name: currentTextName || `Text ${savedTexts.length + 1}`,
        text: text,
        voice: selectedVoice,
        provider: selectedProvider,
        timestamp: new Date().toLocaleString(),
        audioUrl: url
      };
      setSavedTexts(prev => [newText, ...prev]);
      
    } catch (error) {
      console.error('Error converting text to speech:', error);
      alert('Failed to convert text to speech. Please try again.');
    } finally {
      setIsConverting(false);
    }
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
    setSelectedProvider(savedText.provider || 'elevenlabs');
    setCurrentTextName(savedText.name);
    setAudioUrl(savedText.audioUrl);
  };

  const deleteSavedText = (id) => {
    setSavedTexts(prev => prev.filter(item => item.id !== id));
  };

  const clearText = () => {
    setText('');
    setAudioUrl(null);
    setCurrentTextName('');
    setIsPlaying(false);
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
              <label>
                <input
                  type="radio"
                  value="elevenlabs"
                  checked={selectedProvider === 'elevenlabs'}
                  onChange={(e) => {
                    setSelectedProvider(e.target.value);
                    setSelectedVoice('jOEnNSVLOHUgmrNwfqQE');
                  }}
                />
                ElevenLabs (Higher Quality)
              </label>
              <label>
                <input
                  type="radio"
                  value="openai"
                  checked={selectedProvider === 'openai'}
                  onChange={(e) => {
                    setSelectedProvider(e.target.value);
                    setSelectedVoice('alloy');
                  }}
                />
                OpenAI (Faster)
              </label>
            </div>
            <select 
              value={selectedVoice} 
              onChange={(e) => setSelectedVoice(e.target.value)}
              className="voice-select"
            >
              {selectedProvider === 'elevenlabs' ? (
                elevenlabsVoices.map(voice => (
                  <option key={voice.value} value={voice.value}>
                    {voice.label}
                  </option>
                ))
              ) : (
                openaiVoices.map(voice => (
                  <option key={voice.value} value={voice.value}>
                    {voice.label}
                  </option>
                ))
              )}
            </select>
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
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste or type your text here... (max 4000 characters)"
              className="text-input"
              maxLength={4000}
            />
            <div className="text-counter">
              {text.length}/4000 characters
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
              </div>
              <div className="audio-info">
                <p>Voice: {(selectedProvider === 'elevenlabs' ? elevenlabsVoices : openaiVoices).find(v => v.value === selectedVoice)?.label}</p>
                <p>Provider: {selectedProvider === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'}</p>
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
                      <p>Voice: {(savedText.provider === 'elevenlabs' ? elevenlabsVoices : openaiVoices).find(v => v.value === savedText.voice)?.label}</p>
                      <p>Provider: {savedText.provider === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'}</p>
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
        </div>
      </div>
    </div>
  );
};

export default TextToSpeech; 