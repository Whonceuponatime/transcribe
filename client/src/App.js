import React, { useState, useCallback } from 'react';
import './App.css';
import VideoUpload from './components/VideoUpload';
import TranscriptionPanel from './components/TranscriptionPanel';
import AudioTranscriptionPanel from './components/AudioTranscriptionPanel';
import VideoPlayer from './components/VideoPlayer';
import TextToSpeech from './components/TextToSpeech';
import MetadataPanel from './components/MetadataPanel';
import ImageConverter from './components/ImageConverter';

function App() {
  const [activeTab, setActiveTab] = useState('transcription');
  const [uploadedVideo, setUploadedVideo] = useState(null);
  const [transcription, setTranscription] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionHistory, setTranscriptionHistory] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);

  const handleVideoUpload = (videoFile) => {
    setUploadedVideo(videoFile);
    setTranscription('');
    setCurrentTime(0);
    setVideoDuration(0);
  };

  const handleTimeUpdate = useCallback((currentTime, duration) => {
    setCurrentTime(currentTime);
    setVideoDuration(duration);
  }, []);

  const startTranscription = () => {
    setIsTranscribing(true);
    setTranscription('');
  };

  const stopTranscription = () => {
    setIsTranscribing(false);
    if (transcription.trim()) {
      setTranscriptionHistory(prev => [...prev, {
        id: Date.now(),
        text: transcription,
        timestamp: new Date().toLocaleString(),
        videoTime: currentTime
      }]);
    }
  };

  const clearTranscription = () => {
    setTranscription('');
    setTranscriptionHistory([]);
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="App" style={{backgroundColor: '#0a0a0a', color: '#00ff00', fontFamily: 'Source Code Pro, monospace'}}>
      <header className="App-header" style={{backgroundColor: 'rgba(0, 0, 0, 0.9)', border: '1px solid #00ff00'}}>
        <h1 style={{color: '#00ff00', textShadow: '0 0 10px #00ff00'}}>🃏 Jack of clubs</h1>
        <p style={{color: '#00cc00'}}>Comprehensive media processing suite - transcription, metadata removal, and image conversion</p>
      </header>

      <div className="tab-container">
        <button 
          className={`tab-button ${activeTab === 'transcription' ? 'active' : ''}`}
          onClick={() => setActiveTab('transcription')}
          style={{backgroundColor: 'rgba(0, 0, 0, 0.8)', border: '2px solid #00ff00', color: '#00ff00', fontFamily: 'Source Code Pro, monospace'}}
        >
          🎬 Video Transcription
        </button>
        <button 
          className={`tab-button ${activeTab === 'audio' ? 'active' : ''}`}
          onClick={() => setActiveTab('audio')}
          style={{backgroundColor: 'rgba(0, 0, 0, 0.8)', border: '2px solid #00ff00', color: '#00ff00', fontFamily: 'Source Code Pro, monospace'}}
        >
          🎵 Audio Transcription
        </button>
        <button 
          className={`tab-button ${activeTab === 'tts' ? 'active' : ''}`}
          onClick={() => setActiveTab('tts')}
          style={{backgroundColor: 'rgba(0, 0, 0, 0.8)', border: '2px solid #00ff00', color: '#00ff00', fontFamily: 'Source Code Pro, monospace'}}
        >
          📖 Text to Speech
        </button>
        <button 
          className={`tab-button ${activeTab === 'metadata' ? 'active' : ''}`}
          onClick={() => setActiveTab('metadata')}
          style={{backgroundColor: 'rgba(0, 0, 0, 0.8)', border: '2px solid #00ff00', color: '#00ff00', fontFamily: 'Source Code Pro, monospace'}}
        >
          🛡️ Metadata Tools
        </button>
        <button 
          className={`tab-button ${activeTab === 'converter' ? 'active' : ''}`}
          onClick={() => setActiveTab('converter')}
          style={{backgroundColor: 'rgba(0, 0, 0, 0.8)', border: '2px solid #00ff00', color: '#00ff00', fontFamily: 'Source Code Pro, monospace'}}
        >
          🖼️ Image Converter
        </button>
      </div>

      <main className="App-main">
        {activeTab === 'transcription' ? (
          <div className="app-container">
            <div className="left-panel">
              <VideoUpload onVideoUpload={handleVideoUpload} />
              {uploadedVideo && (
                <VideoPlayer 
                  video={uploadedVideo}
                  onTimeUpdate={handleTimeUpdate}
                  isTranscribing={isTranscribing}
                />
              )}
            </div>

            <div className="right-panel">
              <TranscriptionPanel
                transcription={transcription}
                setTranscription={setTranscription}
                isTranscribing={isTranscribing}
                onStartTranscription={startTranscription}
                onStopTranscription={stopTranscription}
                onClearTranscription={clearTranscription}
                transcriptionHistory={transcriptionHistory}
                currentTime={currentTime}
                videoDuration={videoDuration}
                formatTime={formatTime}
                videoFile={uploadedVideo}
              />
            </div>
          </div>
        ) : activeTab === 'audio' ? (
          <AudioTranscriptionPanel />
        ) : activeTab === 'tts' ? (
          <TextToSpeech />
        ) : activeTab === 'metadata' ? (
          <MetadataPanel />
        ) : (
          <ImageConverter />
        )}
      </main>
    </div>
  );
}

export default App; 