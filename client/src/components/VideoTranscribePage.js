import React, { useState, useCallback } from 'react';
import VideoUpload from './VideoUpload';
import VideoPlayer from './VideoPlayer';
import TranscriptionPanel from './TranscriptionPanel';

export default function VideoTranscribePage() {
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

  return (
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
  );
}
