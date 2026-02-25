import React, { useState, useCallback } from 'react';
import './App.css';
import { useAuth } from './contexts/AuthContext';
import AuthStatus from './components/AuthStatus';
import AppNav from './components/AppNav';
import SignInGate from './components/SignInGate';
import VideoUpload from './components/VideoUpload';
import TranscriptionPanel from './components/TranscriptionPanel';
import AudioTranscriptionPanel from './components/AudioTranscriptionPanel';
import VideoPlayer from './components/VideoPlayer';
import TextToSpeech from './components/TextToSpeech';
import MetadataPanel from './components/MetadataPanel';
import ImageConverter from './components/ImageConverter';
import ZigzagMerger from './components/ZigzagMerger';
import LiveTranslator from './components/LiveTranslator';
import MarkdownCSVConverter from './components/MarkdownCSVConverter';
import Rewriter from './components/Rewriter';
import ImageToText from './components/ImageToText';
import EthernetExtractor from './components/EthernetExtractor';

function App() {
  const { isAuthenticated, loading, supabaseConfigured } = useAuth();
  const [activeTab, setActiveTab] = useState('transcription');
  const [uploadedVideo, setUploadedVideo] = useState(null);
  const [transcription, setTranscription] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionHistory, setTranscriptionHistory] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);

  const handleTimeUpdate = useCallback((currentTime, duration) => {
    setCurrentTime(currentTime);
    setVideoDuration(duration);
  }, []);

  const handleVideoUpload = (videoFile) => {
    setUploadedVideo(videoFile);
    setTranscription('');
    setCurrentTime(0);
    setVideoDuration(0);
  };

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

  const canUseApp = supabaseConfigured && isAuthenticated;

  if (loading) {
    return (
      <div className="App App--loading">
        <div className="App-loading">Loading…</div>
      </div>
    );
  }

  if (!canUseApp) {
    return <SignInGate />;
  }

  return (
    <div className="App">
      <header className="App-header">
        <div className="App-header__brand">
          <h1>🃏 Jack of clubs</h1>
          <p className="App-header__tagline">Transcription, conversion &amp; utilities</p>
        </div>
        <AuthStatus />
      </header>

      <AppNav activeTab={activeTab} onSelectTab={setActiveTab} />

      <main className="App-main">
        {activeTab === 'transcription' ? (
          <div className="app-container">
            <div className="left-panel card">
              <VideoUpload onVideoUpload={handleVideoUpload} />
              {uploadedVideo && (
                <VideoPlayer 
                  video={uploadedVideo}
                  onTimeUpdate={handleTimeUpdate}
                  isTranscribing={isTranscribing}
                />
              )}
            </div>

            <div className="right-panel card">
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
        ) : activeTab === 'rewriter' ? (
          <Rewriter />
        ) : activeTab === 'image-to-text' ? (
          <ImageToText />
        ) : activeTab === 'metadata' ? (
          <MetadataPanel />
        ) : activeTab === 'zigzag' ? (
          <ZigzagMerger />
        ) : activeTab === 'translator' ? (
          <LiveTranslator />
        ) : activeTab === 'ethernet' ? (
          <EthernetExtractor />
        ) : activeTab === 'markdown-csv' ? (
          <MarkdownCSVConverter />
        ) : (
          <ImageConverter />
        )}
      </main>
    </div>
  );
}

export default App; 