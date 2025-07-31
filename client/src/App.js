import React, { useState, useCallback } from 'react';
import './App.css';
import VideoUpload from './components/VideoUpload';
import TranscriptionPanel from './components/TranscriptionPanel';
import VideoPlayer from './components/VideoPlayer';
import TextToSpeech from './components/TextToSpeech';
import FileAnalysis from './components/FileAnalysis';

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
    <div className="App">
      <header className="App-header">
        <h1>All in One - Sam</h1>
        <p>Upload videos to transcribe or convert text to speech for learning</p>
      </header>

      <div className="tab-container">
        <button 
          className={`tab-button ${activeTab === 'transcription' ? 'active' : ''}`}
          onClick={() => setActiveTab('transcription')}
        >
          🎬 Video Transcription
        </button>
        <button 
          className={`tab-button ${activeTab === 'tts' ? 'active' : ''}`}
          onClick={() => setActiveTab('tts')}
        >
          📖 Text to Speech
        </button>
        <button 
          className={`tab-button ${activeTab === 'analysis' ? 'active' : ''}`}
          onClick={() => setActiveTab('analysis')}
        >
          📄 File Analysis
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
        ) : activeTab === 'tts' ? (
          <TextToSpeech />
        ) : (
          <FileAnalysis />
        )}
      </main>
    </div>
  );
}

export default App; 