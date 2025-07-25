// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const ffmpeg = require('fluent-ffmpeg');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:5000"],
    methods: ["GET", "POST"]
  }
});

// Initialize OpenAI (you'll need to set OPENAI_API_KEY environment variable)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Supabase (optional for deployment)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
}



// Log API key status (without exposing the actual keys)
console.log('OpenAI API Key loaded:', process.env.OPENAI_API_KEY ? 'Yes' : 'No');
console.log('ElevenLabs API Key loaded:', process.env.ELEVENLABS_API_KEY ? 'Yes' : 'No');
console.log('Supabase URL loaded:', process.env.SUPABASE_URL ? 'Yes' : 'No');
console.log('Supabase Anon Key loaded:', process.env.SUPABASE_ANON_KEY ? 'Yes' : 'No');

if (!process.env.OPENAI_API_KEY) {
  console.error('WARNING: OPENAI_API_KEY not found in environment variables');
  console.error('OpenAI TTS will not be available');
}

if (!process.env.ELEVENLABS_API_KEY) {
  console.error('WARNING: ELEVENLABS_API_KEY not found in environment variables');
  console.error('ElevenLabs TTS will not be available');
}

// Middleware
app.use(cors({
  origin: ["http://localhost:3000", "http://localhost:5000"],
  credentials: true
}));
app.use(express.json({ limit: '1gb' }));
app.use(express.urlencoded({ limit: '1gb', extended: true }));
app.use(express.static(path.join(__dirname, 'client/build')));

// Increase timeout for large file uploads
app.use((req, res, next) => {
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000); // 5 minutes
  next();
});

// Create directories if they don't exist
const uploadsDir = path.join(__dirname, 'uploads');
const audioDir = path.join(__dirname, 'audio');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Accept video files
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed!'), false);
    }
  }
  // Removed file size limits to handle large videos
});

// Authentication middleware
const authenticateUser = async (req, res, next) => {
  // Skip authentication if Supabase is not configured
  if (!supabase) {
    console.log('Supabase not configured, skipping authentication');
    return next();
  }
  
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No authorization token provided' });
  }
  
  const token = authHeader.substring(7); // Remove 'Bearer ' prefix
  
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Extract audio from video
const extractAudio = (videoPath, audioPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .toFormat('mp3')
      .audioCodec('libmp3lame')
      .audioBitrate(128)
      .on('progress', (progress) => {
        console.log('Audio extraction progress:', progress.percent + '%');
      })
      .on('end', () => {
        console.log('Audio extraction completed');
        resolve(audioPath);
      })
      .on('error', (err) => {
        console.error('Audio extraction error:', err);
        reject(err);
      })
      .save(audioPath);
  });
};

// Transcribe audio using OpenAI Whisper
const transcribeAudio = async (audioPath) => {
  try {
    const audioFile = fs.createReadStream(audioPath);
    
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      response_format: "text"
    });

    return transcription;
  } catch (error) {
    console.error('Transcription error:', error);
    throw error;
  }
};

// Create speech chunk for long texts
const createSpeechChunk = async (text, voice, provider = 'openai') => {
  try {
    if (provider === 'openai') {
      const mp3 = await openai.audio.speech.create({
        model: "tts-1",
        voice: voice,
        input: text,
      });
      
      return Buffer.from(await mp3.arrayBuffer());
    } else if (provider === 'elevenlabs') {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: text,
          model_id: "eleven_monolingual_v1",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5
          }
        })
      });
      
      if (!response.ok) {
        throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
      }
      
      const audioBuffer = await response.arrayBuffer();
      return Buffer.from(audioBuffer);
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  } catch (error) {
    console.error('Speech chunk creation error:', error);
    throw error;
  }
};

// Combine multiple audio buffers into one
const combineAudioBuffers = (buffers) => {
  // For now, we'll concatenate the buffers
  // In a production app, you might want to use a proper audio library
  // to handle MP3 concatenation properly
  return Buffer.concat(buffers);
};

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Server is running',
    openaiConfigured: !!process.env.OPENAI_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// Upload endpoint
app.post('/api/upload', authenticateUser, upload.single('video'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    console.log('File uploaded:', req.file.originalname, 'Size:', (req.file.size / (1024 * 1024)).toFixed(2) + ' MB');

    const fileInfo = {
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      path: req.file.path
    };

    // Emit file upload success to connected clients
    io.emit('fileUploaded', fileInfo);

    res.json({
      message: 'Video uploaded successfully',
      file: fileInfo
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed', details: error.message });
  }
});

// Transcribe video endpoint
app.post('/api/transcribe', authenticateUser, upload.single('video'), async (req, res) => {
  try {
    console.log('Transcription request received');
    
    if (!req.file) {
      console.log('No file uploaded');
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const fileSizeMB = (req.file.size / (1024 * 1024)).toFixed(2);
    console.log('File received:', req.file.originalname, 'Size:', fileSizeMB + ' MB');
    
    const videoPath = req.file.path;
    const audioFilename = `audio-${Date.now()}.mp3`;
    const audioPath = path.join(audioDir, audioFilename);

    console.log('Starting transcription process...');
    console.log('Video path:', videoPath);
    console.log('Audio path:', audioPath);
    
    // Extract audio from video
    console.log('Extracting audio from video...');
    await extractAudio(videoPath, audioPath);
    
    // Get audio file size
    const audioStats = fs.statSync(audioPath);
    const audioSizeMB = (audioStats.size / (1024 * 1024)).toFixed(2);
    console.log('Audio extracted, size:', audioSizeMB + ' MB');
    
    // Transcribe audio
    console.log('Sending audio to OpenAI for transcription...');
    const transcription = await transcribeAudio(audioPath);
    
    // Clean up audio file
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
      console.log('Audio file cleaned up');
    }
    
    console.log('Transcription completed successfully');
    console.log('Transcription length:', transcription.length, 'characters');
    
    res.json({
      success: true,
      transcription: transcription,
      filename: req.file.originalname,
      fileSize: fileSizeMB + ' MB',
      transcriptionLength: transcription.length
    });
    
  } catch (error) {
    console.error('Transcription error:', error);
    
    // Clean up audio file if it exists
    const audioPath = path.join(audioDir, `audio-${Date.now()}.mp3`);
    if (fs.existsSync(audioPath)) {
      try {
        fs.unlinkSync(audioPath);
      } catch (cleanupError) {
        console.error('Error cleaning up audio file:', cleanupError);
      }
    }
    
    res.status(500).json({ 
      error: 'Transcription failed', 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Get uploaded files
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir)
      .filter(file => file.match(/\.(mp4|avi|mov|mkv|wmv|flv|webm)$/i))
      .map(file => {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          size: stats.size,
          uploadDate: stats.mtime
        };
      });
    
    res.json(files);
  } catch (error) {
    console.error('Error reading files:', error);
    res.status(500).json({ error: 'Failed to read files' });
  }
});

// Get available voices from both providers
app.get('/api/voices', authenticateUser, async (req, res) => {
  try {
    const voices = {
      openai: [],
      elevenlabs: []
    };

    // Get OpenAI voices
    if (process.env.OPENAI_API_KEY) {
      const openaiVoices = [
        { id: 'alloy', name: 'Alloy (Neutral)' },
        { id: 'echo', name: 'Echo (Warm)' },
        { id: 'fable', name: 'Fable (Storytelling)' },
        { id: 'onyx', name: 'Onyx (Deep)' },
        { id: 'nova', name: 'Nova (Bright & Energetic)' },
        { id: 'shimmer', name: 'Shimmer (Soft & Gentle)' }
      ];
      voices.openai = openaiVoices.map(voice => ({
        value: voice.id,
        label: voice.name
      }));
    }

    // Get ElevenLabs voices
    if (process.env.ELEVENLABS_API_KEY) {
      try {
        const response = await fetch('https://api.elevenlabs.io/v1/voices', {
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY
          }
        });
        
        if (response.ok) {
          const elevenlabsVoices = await response.json();
          voices.elevenlabs = elevenlabsVoices.voices.map(voice => ({
            value: voice.voice_id,
            label: voice.name
          }));
        } else {
          console.error('Error fetching ElevenLabs voices:', response.status, response.statusText);
        }
      } catch (error) {
        console.error('Error fetching ElevenLabs voices:', error);
        // If ElevenLabs fails, still return OpenAI voices
      }
    }

    res.json(voices);
  } catch (error) {
    console.error('Error fetching voices:', error);
    res.status(500).json({ error: 'Failed to fetch voices' });
  }
});

// Text-to-Speech endpoint
app.post('/api/text-to-speech', authenticateUser, async (req, res) => {
  try {
    const { text, voice = 'alloy', provider = 'openai' } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Text is required' });
    }

    // Validate provider
    if (!['openai', 'elevenlabs'].includes(provider)) {
      return res.status(400).json({ error: 'Invalid provider. Must be "openai" or "elevenlabs"' });
    }

    // Check if provider API key is available
    if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: 'OpenAI API key not configured' });
    }
    if (provider === 'elevenlabs' && !process.env.ELEVENLABS_API_KEY) {
      return res.status(400).json({ error: 'ElevenLabs API key not configured' });
    }

    console.log('Text-to-Speech request received');
    console.log('Provider:', provider);
    console.log('Voice:', voice);
    console.log('Text length:', text.length, 'characters');

    // Handle long texts by chunking them (only for OpenAI, ElevenLabs handles long texts better)
    const maxChunkSize = provider === 'openai' ? 4096 : 5000;
    let audioBuffers = [];
    
    if (text.length > maxChunkSize && provider === 'openai') {
      console.log(`Text is ${text.length} characters, chunking into smaller pieces...`);
      
      // Split text into sentences to avoid cutting mid-sentence
      const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
      let currentChunk = '';
      
      for (const sentence of sentences) {
        if ((currentChunk + sentence).length <= maxChunkSize) {
          currentChunk += sentence;
        } else {
          if (currentChunk) {
            audioBuffers.push(await createSpeechChunk(currentChunk.trim(), voice, provider));
          }
          currentChunk = sentence;
        }
      }
      
      if (currentChunk) {
        audioBuffers.push(await createSpeechChunk(currentChunk.trim(), voice, provider));
      }
      
      console.log(`Created ${audioBuffers.length} audio chunks`);
      
      // Combine audio buffers
      const combinedBuffer = combineAudioBuffers(audioBuffers);
      
      // Set response headers
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', combinedBuffer.length);
      res.setHeader('Content-Disposition', 'attachment; filename="speech.mp3"');
      
      // Send the combined audio buffer
      res.send(combinedBuffer);
      
      console.log('Text-to-Speech completed successfully (chunked)');
      console.log('Audio size:', (combinedBuffer.length / 1024).toFixed(2), 'KB');
      return;
    }

    console.log('Text-to-Speech request received');
    console.log('Text length:', text.length, 'characters');
    console.log('Voice:', voice);

    // Validate voice
    const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    if (!validVoices.includes(voice)) {
      return res.status(400).json({ error: 'Invalid voice selected' });
    }

    // Create speech using selected provider
    console.log(`Sending text to ${provider.toUpperCase()} TTS API...`);
    console.log('Text preview (first 200 chars):', text.substring(0, 200));
    
    let buffer;
    
    if (provider === 'openai') {
      const mp3 = await openai.audio.speech.create({
        model: "tts-1",
        voice: voice,
        input: text,
      });
      buffer = Buffer.from(await mp3.arrayBuffer());
    } else if (provider === 'elevenlabs') {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: text,
          model_id: "eleven_monolingual_v1",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5
          }
        })
      });
      
      if (!response.ok) {
        throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
      }
      
      const audioBuffer = await response.arrayBuffer();
      buffer = Buffer.from(audioBuffer);
    }

    // Set response headers
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', 'attachment; filename="speech.mp3"');

    // Send the audio buffer
    res.send(buffer);

    console.log(`${provider.toUpperCase()} Text-to-Speech completed successfully`);
    console.log('Audio size:', (buffer.length / 1024).toFixed(2), 'KB');

  } catch (error) {
    console.error('Text-to-Speech error:', error);
    res.status(500).json({ 
      error: 'Text-to-Speech failed', 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
});

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
  console.log(`Upload directory: ${uploadsDir}`);
  console.log(`Audio directory: ${audioDir}`);
  console.log('Ready to handle large video files (no size limit)');
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please stop the other server or use a different port.`);
    console.error('You can kill the process using:');
    console.error(`  netstat -ano | findstr :${PORT}`);
    console.error(`  taskkill /PID <PID> /F`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
}); 