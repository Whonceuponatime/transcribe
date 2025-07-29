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
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:5000"],
    methods: ["GET", "POST"]
  }
});

// Initialize OpenAI (you'll need to set OPENAI_API_KEY environment variable)
let openai;
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== '') {
  try {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    console.log('OpenAI API configured successfully');
  } catch (error) {
    console.warn('OpenAI API key invalid. Text-to-speech and transcription features will be disabled.');
    openai = null;
  }
} else {
  console.warn('OpenAI API key not found in environment variables. Text-to-speech and transcription features will be disabled.');
  openai = null;
}

// Initialize ElevenLabs
let elevenlabsApiKey;
if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.trim() !== '') {
  elevenlabsApiKey = process.env.ELEVENLABS_API_KEY.trim();
  console.log('ElevenLabs API key configured successfully');
} else {
  console.warn('ElevenLabs API key not found in environment variables. ElevenLabs text-to-speech features will be disabled.');
  elevenlabsApiKey = null;
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
  if (!openai) {
    throw new Error('OpenAI API key not configured. Please set OPENAI_API_KEY environment variable.');
  }
  
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

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Server is running',
    openaiConfigured: !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== ''),
    elevenlabsConfigured: !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.trim() !== ''),
    elevenlabsApiKey: !!elevenlabsApiKey,
    timestamp: new Date().toISOString()
  });
});

// Upload endpoint
app.post('/api/upload', upload.single('video'), (req, res) => {
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
app.post('/api/transcribe', upload.single('video'), async (req, res) => {
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

// Get ElevenLabs models
app.get('/api/models', async (req, res) => {
  try {
    if (!elevenlabsApiKey) {
      return res.status(503).json({ error: 'ElevenLabs API key not configured' });
    }

    const response = await axios({
      method: 'GET',
      url: 'https://api.elevenlabs.io/v1/models',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': elevenlabsApiKey
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching models:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch models', details: error.response?.data || error.message });
  }
});

// Get ElevenLabs voices
app.get('/api/voices', async (req, res) => {
  try {
    if (!elevenlabsApiKey) {
      return res.status(503).json({ error: 'ElevenLabs API key not configured' });
    }

    const response = await axios({
      method: 'GET',
      url: 'https://api.elevenlabs.io/v1/voices',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': elevenlabsApiKey
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching voices:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch voices', details: error.response?.data || error.message });
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

// Text-to-Speech endpoint
app.post('/api/text-to-speech', async (req, res) => {
  try {
    const { text, voice = 'jOEnNSVLOHUgmrNwfqQE', provider = 'elevenlabs' } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Text is required' });
    }

    if (text.length > 4000) {
      return res.status(400).json({ error: 'Text is too long. Maximum 4000 characters allowed.' });
    }

    console.log('Text-to-Speech request received');
    console.log('Text length:', text.length, 'characters');
    console.log('Voice:', voice);
    console.log('Provider:', provider);

    let buffer;

    if (provider === 'elevenlabs') {
      if (!elevenlabsApiKey) {
        return res.status(503).json({ error: 'ElevenLabs API key not configured. Please set ELEVENLABS_API_KEY environment variable.' });
      }

      try {
        // Use ElevenLabs REST API directly
        const response = await axios({
          method: 'POST',
          url: `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': elevenlabsApiKey
          },
          data: {
            text: text,
            model_id: 'eleven_multilingual_v2',
            output_format: 'mp3_44100_128'
          },
          responseType: 'arraybuffer'
        });

        buffer = Buffer.from(response.data);
      } catch (elevenlabsError) {
        console.error('ElevenLabs TTS error:', elevenlabsError.response?.data || elevenlabsError.message);
        return res.status(500).json({ 
          error: 'ElevenLabs TTS failed', 
          details: elevenlabsError.response?.data || elevenlabsError.message,
          suggestion: 'Please check your ElevenLabs API key and voice ID'
        });
      }

    } else {
      // Fallback to OpenAI TTS
      if (!openai) {
        return res.status(503).json({ error: 'OpenAI API key not configured. Please set OPENAI_API_KEY environment variable.' });
      }

      // Validate OpenAI voice
      const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
      if (!validVoices.includes(voice)) {
        return res.status(400).json({ error: 'Invalid voice selected for OpenAI' });
      }

      // Create speech using OpenAI TTS
      const mp3 = await openai.audio.speech.create({
        model: "tts-1",
        voice: voice,
        input: text,
      });

      // Convert the response to a buffer
      buffer = Buffer.from(await mp3.arrayBuffer());
    }

    // Set response headers
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', 'attachment; filename="speech.mp3"');

    // Send the audio buffer
    res.send(buffer);

    console.log('Text-to-Speech completed successfully');
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

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Upload directory: ${uploadsDir}`);
  console.log(`Audio directory: ${audioDir}`);
  console.log('Ready to handle large video files (no size limit)');
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