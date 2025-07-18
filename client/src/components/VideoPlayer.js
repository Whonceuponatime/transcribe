import React, { useRef, useEffect, useState } from 'react';
import './VideoPlayer.css';

const VideoPlayer = ({ video, onTimeUpdate, isTranscribing }) => {
  const videoRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [videoError, setVideoError] = useState('');
  const [isVideoLoaded, setIsVideoLoaded] = useState(false);
  const [playAttempts, setPlayAttempts] = useState(0);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (videoElement && video) {
      console.log('Loading video:', video.name, video.type, video.size);
      console.log('Video object reference:', video);
      
      // Create object URL for the video file
      const videoUrl = URL.createObjectURL(video);
      console.log('Created video URL:', videoUrl);
      videoElement.src = videoUrl;
      
      const handleLoadedMetadata = () => {
        console.log('Video metadata loaded, duration:', videoElement.duration);
        setDuration(videoElement.duration);
        // Sync the playing state with the actual video element state
        setIsPlaying(!videoElement.paused);
      };

      const handleLoadedData = () => {
        console.log('Video data loaded');
        setIsVideoLoaded(true);
      };

      const handleCanPlay = () => {
        console.log('Video can start playing');
        setIsVideoLoaded(true);
        // Sync the playing state with the actual video element state
        setIsPlaying(!videoElement.paused);
      };

      const handleTimeUpdate = () => {
        const currentTime = videoElement.currentTime;
        setCurrentTime(currentTime);
        onTimeUpdate(currentTime, videoElement.duration);
      };

      const handlePlay = () => {
        console.log('Video started playing');
        setIsPlaying(true);
        setPlayAttempts(0);
      };

      const handlePause = () => {
        console.log('Video paused');
        setIsPlaying(false);
      };

      const handleEnded = () => {
        console.log('Video ended');
        setIsPlaying(false);
      };

      const handleError = (e) => {
        console.error('Video error:', e);
        setVideoError('Failed to load video. Please try a different file.');
        setIsVideoLoaded(false);
      };

      const handleLoadStart = () => {
        console.log('Video load started');
        setIsVideoLoaded(false);
        setVideoError('');
      };

      // Add event listeners
      videoElement.addEventListener('loadstart', handleLoadStart);
      videoElement.addEventListener('loadedmetadata', handleLoadedMetadata);
      videoElement.addEventListener('loadeddata', handleLoadedData);
      videoElement.addEventListener('canplay', handleCanPlay);
      videoElement.addEventListener('timeupdate', handleTimeUpdate);
      videoElement.addEventListener('play', handlePlay);
      videoElement.addEventListener('pause', handlePause);
      videoElement.addEventListener('ended', handleEnded);
      videoElement.addEventListener('error', handleError);

      return () => {
        console.log('Cleaning up video element');
        // Cleanup
        videoElement.removeEventListener('loadstart', handleLoadStart);
        videoElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
        videoElement.removeEventListener('loadeddata', handleLoadedData);
        videoElement.removeEventListener('canplay', handleCanPlay);
        videoElement.removeEventListener('timeupdate', handleTimeUpdate);
        videoElement.removeEventListener('play', handlePlay);
        videoElement.removeEventListener('pause', handlePause);
        videoElement.removeEventListener('ended', handleEnded);
        videoElement.removeEventListener('error', handleError);
        
        // Clean up object URL
        URL.revokeObjectURL(videoUrl);
      };
    }
  }, [video]); // Removed onTimeUpdate from dependencies

  const togglePlayPause = async () => {
    const videoElement = videoRef.current;
    if (videoElement) {
      try {
        console.log('Toggle play/pause clicked. Current state:', isPlaying);
        console.log('Video element readyState:', videoElement.readyState);
        console.log('Video element paused:', videoElement.paused);
        console.log('Video element currentTime:', videoElement.currentTime);
        
        // Use the actual video element state instead of React state
        if (!videoElement.paused) {
          console.log('Attempting to pause video');
          videoElement.pause();
        } else {
          console.log('Attempting to play video');
          setPlayAttempts(prev => prev + 1);
          
          // Try to play the video with autoplay workaround
          let playPromise;
          
          // First attempt: try with muted (to bypass autoplay restrictions)
          if (playAttempts === 0) {
            console.log('First play attempt - trying with muted video');
            videoElement.muted = true;
            playPromise = videoElement.play();
          } else {
            // Subsequent attempts: try with unmuted
            console.log('Subsequent play attempt - trying with unmuted video');
            videoElement.muted = false;
            playPromise = videoElement.play();
          }
          
          if (playPromise !== undefined) {
            playPromise
              .then(() => {
                console.log('Video play promise resolved successfully');
                // If we started muted, unmute after successful play
                if (videoElement.muted && playAttempts === 0) {
                  setTimeout(() => {
                    videoElement.muted = false;
                    setIsMuted(false);
                  }, 100);
                }
              })
              .catch(error => {
                console.error('Error playing video:', error);
                
                // If first attempt failed with muted, try unmuted
                if (playAttempts === 0 && videoElement.muted) {
                  console.log('Muted play failed, trying unmuted...');
                  videoElement.muted = false;
                  videoElement.play().then(() => {
                    console.log('Unmuted play successful');
                  }).catch(unmutedError => {
                    console.error('Unmuted play also failed:', unmutedError);
                    setVideoError(`Failed to play video: ${unmutedError.message}`);
                    setIsPlaying(false);
                  });
                } else {
                  setVideoError(`Failed to play video: ${error.message}`);
                  setIsPlaying(false);
                }
              });
          }
        }
      } catch (error) {
        console.error('Error toggling play/pause:', error);
        setVideoError('Error controlling video playback.');
      }
    } else {
      console.error('Video element not found');
    }
  };

  const testVideoPlay = () => {
    const videoElement = videoRef.current;
    if (videoElement) {
      console.log('Testing video play...');
      console.log('Video element:', videoElement);
      console.log('Video src:', videoElement.src);
      console.log('Video readyState:', videoElement.readyState);
      console.log('Video paused:', videoElement.paused);
      
      // Try to play with user interaction
      videoElement.play().then(() => {
        console.log('Test play successful');
        setIsPlaying(true);
      }).catch(error => {
        console.error('Test play failed:', error);
        setVideoError(`Test play failed: ${error.message}`);
      });
    }
  };

  const handleSeek = (e) => {
    const videoElement = videoRef.current;
    if (videoElement && duration > 0) {
      try {
        const rect = e.currentTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const width = rect.width;
        const seekTime = (clickX / width) * duration;
        videoElement.currentTime = seekTime;
      } catch (error) {
        console.error('Error seeking video:', error);
      }
    }
  };

  const handleVolumeChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
    }
  };

  const toggleMute = () => {
    const videoElement = videoRef.current;
    if (videoElement) {
      videoElement.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const formatTime = (seconds) => {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="video-player">
      <div className="video-container">
        <video
          ref={videoRef}
          className="video-element"
          controls={false}
          preload="metadata"
          playsInline
          muted={false}
        />
        
        {!isVideoLoaded && !videoError && (
          <div className="video-loading">
            <div className="loading-spinner"></div>
            <p>Loading video...</p>
          </div>
        )}

        {videoError && (
          <div className="video-error">
            <p>⚠️ {videoError}</p>
            <p>Supported formats: MP4, AVI, MOV, MKV, WMV, FLV, WebM</p>
          </div>
        )}
        
        {isTranscribing && (
          <div className="transcribing-indicator">
            <div className="pulse-dot"></div>
            <span>Transcribing...</span>
          </div>
        )}
      </div>

      <div className="video-controls">
        <div className="control-buttons">
          <button 
            className="play-pause-btn"
            onClick={togglePlayPause}
            disabled={!isVideoLoaded || !!videoError}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16"/>
                <rect x="14" y="4" width="4" height="16"/>
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21"/>
              </svg>
            )}
          </button>

          <div className="time-display">
            <span>{formatTime(currentTime)}</span>
            <span>/</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <div className="progress-container">
          <div 
            className="progress-bar"
            onClick={handleSeek}
          >
            <div 
              className="progress-fill"
              style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            ></div>
          </div>
        </div>

        <div className="volume-controls">
          <button 
            className="mute-btn"
            onClick={toggleMute}
            aria-label={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted || volume === 0 ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <line x1="1" y1="1" x2="23" y2="23"/>
                <path d="M9 9v6a3 3 0 0 0 3 3l6-6"/>
                <path d="M17.5 9.5c.5-1.5 1-2.5 1-2.5s-1-1-3-1-3 1-3 1"/>
              </svg>
            ) : volume < 0.5 ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="11,5 6,9 2,9 2,15 6,15 11,19 11,5"/>
                <path d="M15.5 8.5a3 3 0 0 1 0 7"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="11,5 6,9 2,9 2,15 6,15 11,19 11,5"/>
                <path d="M15.5 8.5a3 3 0 0 1 0 7"/>
                <path d="M19.1 4.9a6 6 0 0 1 0 14.2"/>
              </svg>
            )}
          </button>
          
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={volume}
            onChange={handleVolumeChange}
            className="volume-slider"
          />
        </div>
      </div>

      {/* Test button for debugging */}
      {process.env.NODE_ENV === 'development' && (
        <div style={{ marginTop: '0.5rem' }}>
          <button 
            onClick={testVideoPlay}
            style={{ 
              padding: '0.5rem 1rem', 
              background: '#3498db', 
              color: 'white', 
              border: 'none', 
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Test Video Play
          </button>
        </div>
      )}

      {/* Debug info in development */}
      {process.env.NODE_ENV === 'development' && (
        <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.5rem' }}>
          Debug: Video loaded: {isVideoLoaded ? 'Yes' : 'No'} | 
          Playing: {isPlaying ? 'Yes' : 'No'} | 
          Duration: {formatTime(duration)} | 
          Current: {formatTime(currentTime)} |
          Play attempts: {playAttempts}
        </div>
      )}
    </div>
  );
};

export default VideoPlayer; 