import React, { useState, useCallback, useEffect } from 'react';
import './App.css';
import VideoUpload from './components/VideoUpload';
import TranscriptionPanel from './components/TranscriptionPanel';
import VideoPlayer from './components/VideoPlayer';
import TextToSpeech from './components/TextToSpeech';
import Auth from './components/Auth';
import { supabase } from './supabase';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('transcription');
  const [uploadedVideo, setUploadedVideo] = useState(null);
  const [transcription, setTranscription] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionHistory, setTranscriptionHistory] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);

  useEffect(() => {
    // Check for existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleAuthChange = (user) => {
    setUser(user);
  };

  const handleSignOut = async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      setUser(null);
    } catch (error) {
      console.error('Error signing out:', error.message);
    }
  };

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

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <Auth onAuthChange={handleAuthChange} />;
  }

  return (
    <div className="App">
      <header className="App-header">
        <div className="header-content">
          <div className="header-left">
            <h1>🎬 Video Transcription & Text-to-Speech App</h1>
            <p>Upload videos to transcribe or convert text to speech for learning</p>
          </div>
          <div className="user-info">
            <span>Welcome, {user.email}</span>
            <button onClick={handleSignOut} className="sign-out-button">
              Sign Out
            </button>
          </div>
        </div>
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
        ) : (
          <TextToSpeech />
        )}
      </main>
    </div>
  );
}

export default App; 