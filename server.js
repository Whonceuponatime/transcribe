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
const sharp = require('sharp');
const ExifParser = require('exif-parser');
const { PDFDocument } = require('pdf-lib');
// const archiver = require('archiver'); // Temporarily disabled

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:3001", "http://localhost:5000"],
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
  origin: ["http://localhost:3000", "http://localhost:3001", "http://localhost:5000"],
  credentials: true
}));
app.use(express.json({ limit: '1gb' }));
app.use(express.urlencoded({ limit: '1gb', extended: true }));
app.use(express.static(path.join(__dirname, 'client/build')));

// Increase timeout for large file uploads
app.use((req, res, next) => {
  req.setTimeout(3600000); // 1 hour
  res.setTimeout(3600000); // 1 hour
  next();
});

// Create directories if they don't exist
const uploadsDir = path.join(__dirname, 'uploads');
const audioDir = path.join(__dirname, 'audio');
const metadataDir = path.join(__dirname, 'metadata');
const convertedDir = path.join(__dirname, 'converted');
const pdfsDir = path.join(__dirname, 'pdfs');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir);
}
if (!fs.existsSync(metadataDir)) {
  fs.mkdirSync(metadataDir);
}
if (!fs.existsSync(convertedDir)) {
  fs.mkdirSync(convertedDir);
}
if (!fs.existsSync(pdfsDir)) {
  fs.mkdirSync(pdfsDir);
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


// Configure multer for audio file uploads
const audioUpload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Accept audio files
    const audioMimeTypes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/wave',
      'audio/x-wav',
      'audio/mp4',
      'audio/m4a',
      'audio/aac',
      'audio/ogg',
      'audio/flac',
      'audio/x-flac',
      'audio/wma'
    ];
    
    const audioExtensions = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    
    if (audioMimeTypes.includes(file.mimetype) || audioExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed! Supported formats: MP3, WAV, M4A, AAC, OGG, FLAC, WMA'), false);
    }
  }
  // Removed file size limits to handle large audio files
});

// Configure multer for media files (videos and images) for metadata processing
const mediaStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, metadataDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const mediaUpload = multer({ 
  storage: mediaStorage,
  fileFilter: (req, file, cb) => {
    // Accept video and image files
    const isVideo = file.mimetype.startsWith('video/');
    const isImage = file.mimetype.startsWith('image/');
    
    if (isVideo || isImage) {
      cb(null, true);
    } else {
      cb(new Error('Only video and image files are allowed!'), false);
    }
  }
  // Removed file size limits to handle large files
});

// Configure multer for image conversion
const imageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, convertedDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const imageUpload = multer({ 
  storage: imageStorage,
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
  // Removed file size limits to handle large images
});

// Configure multer for PDF uploads
const pdfStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, pdfsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const pdfUpload = multer({ 
  storage: pdfStorage,
  fileFilter: (req, file, cb) => {
    // Accept only PDF files
    if (file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  }
  // Removed file size limits to handle large PDFs
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

// Transcribe audio using OpenAI Whisper with retry logic
const transcribeAudio = async (audioPath, options = {}) => {
  if (!openai) {
    throw new Error('OpenAI API key not configured. Please set OPENAI_API_KEY environment variable.');
  }
  
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Transcription attempt ${attempt}/${maxRetries}...`);
      
      const audioFile = fs.createReadStream(audioPath);
      
      const transcriptionOptions = {
        file: audioFile,
        model: "whisper-1",
        response_format: "text",
        ...options
      };

      // Optional: Specify language if provided
      if (options.language) {
        transcriptionOptions.language = options.language;
        console.log(`Transcribing with specified language: ${options.language}`);
      } else {
        console.log('Transcribing with automatic language detection');
      }

      const transcription = await openai.audio.transcriptions.create(transcriptionOptions);
      console.log(`Transcription successful on attempt ${attempt}`);
      return transcription;
      
    } catch (error) {
      lastError = error;
      console.error(`Transcription attempt ${attempt} failed:`, error.message);
      
      // Check if it's a network error that we should retry
      if (error.code === 'ECONNRESET' || 
          error.message.includes('Connection error') ||
          error.message.includes('network') ||
          error.message.includes('timeout')) {
        
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s, 8s
          console.log(`Network error detected. Retrying in ${delay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      
      // For non-network errors or after max retries, throw immediately
      throw error;
    }
  }
  
  // If we get here, all retries failed
  throw lastError;
};

// Transcribe large audio files by splitting into chunks
const transcribeAudioChunked = async (audioPath, options = {}) => {
  console.log('Starting chunked audio transcription...');
  
  // Use FFmpeg to get audio duration and split into 10-minute chunks
  const chunkDuration = 600; // 10 minutes in seconds
  const outputDir = path.dirname(audioPath);
  const baseName = path.basename(audioPath, path.extname(audioPath));
  
  try {
    // Get audio duration
    const durationCmd = `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`;
    const duration = parseFloat(require('child_process').execSync(durationCmd, { encoding: 'utf8' }).trim());
    console.log(`Audio duration: ${duration} seconds (${(duration/60).toFixed(1)} minutes)`);
    
    const numChunks = Math.ceil(duration / chunkDuration);
    console.log(`Splitting into ${numChunks} chunks of ${chunkDuration} seconds each...`);
    
    let fullTranscription = '';
    
    for (let i = 0; i < numChunks; i++) {
      const startTime = i * chunkDuration;
      const endTime = Math.min((i + 1) * chunkDuration, duration);
      const chunkPath = path.join(outputDir, `${baseName}_chunk_${i + 1}.mp3`);
      
      console.log(`Processing chunk ${i + 1}/${numChunks} (${startTime}s - ${endTime}s)...`);
      
      // Extract chunk using FFmpeg (transcode to MP3)
      const ffmpegCmd = `ffmpeg -i "${audioPath}" -ss ${startTime} -t ${endTime - startTime} -acodec libmp3lame -ar 44100 -ac 1 "${chunkPath}" -y`;
      require('child_process').execSync(ffmpegCmd);
      
      try {
        // Transcribe this chunk
        const chunkTranscription = await transcribeAudio(chunkPath, options);
        fullTranscription += chunkTranscription + ' ';
        
        console.log(`Chunk ${i + 1} transcribed successfully (${chunkTranscription.length} characters)`);
        
      } finally {
        // Clean up chunk file
        if (fs.existsSync(chunkPath)) {
          fs.unlinkSync(chunkPath);
        }
      }
      
      // Add a small delay between chunks to avoid rate limiting
      if (i < numChunks - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log('Chunked transcription completed successfully');
    return fullTranscription.trim();
    
  } catch (error) {
    console.error('Chunked transcription error:', error);
    throw error;
  }
};

// Metadata processing functions
const processImageMetadata = async (inputPath, outputPath, options) => {
  try {
    // Use Sharp to process the image and remove metadata
    const image = sharp(inputPath);
    
    // Remove all metadata by default, or apply specific options
    if (options.removeAll) {
      // Remove all metadata
      await image
        .withMetadata({}) // Remove all metadata
        .jpeg({ quality: 90 }) // Re-encode as JPEG to ensure metadata removal
        .png({ quality: 90 }) // Re-encode as PNG to ensure metadata removal
        .toFile(outputPath);
    } else {
      // Apply selective metadata removal
      const metadata = await image.metadata();
      const newMetadata = {};
      
      // Keep only specific metadata if not being removed
      if (!options.removeLocation && metadata.exif) {
        // This is a simplified approach - in a real implementation,
        // you'd need more sophisticated EXIF manipulation
        newMetadata.exif = metadata.exif;
      }
      
      await image
        .withMetadata(newMetadata)
        .toFile(outputPath);
    }
    
    return true;
  } catch (error) {
    console.error('Error processing image metadata:', error);
    throw error;
  }
};

const processVideoMetadata = async (inputPath, outputPath, options) => {
  try {
    // For videos, we'll use FFmpeg to remove metadata
    return new Promise((resolve, reject) => {
      let ffmpegCommand = ffmpeg(inputPath);
      
      // Remove metadata by re-encoding without metadata
      ffmpegCommand = ffmpegCommand
        .outputOptions([
          '-map_metadata', '-1', // Remove all metadata
          '-c:v', 'copy', // Copy video stream without re-encoding
          '-c:a', 'copy'  // Copy audio stream without re-encoding
        ]);
      
      // Add specific metadata removal options
      if (options.removeLocation) {
        ffmpegCommand = ffmpegCommand.outputOptions(['-metadata', 'location=']);
      }
      
      if (options.removeCameraInfo) {
        ffmpegCommand = ffmpegCommand.outputOptions([
          '-metadata', 'make=',
          '-metadata', 'model=',
          '-metadata', 'software='
        ]);
      }
      
      ffmpegCommand
        .on('progress', (progress) => {
          console.log('Video processing progress:', progress.percent + '%');
        })
        .on('end', () => {
          console.log('Video metadata processing completed');
          resolve(true);
        })
        .on('error', (err) => {
          console.error('Video metadata processing error:', err);
          reject(err);
        })
        .save(outputPath);
    });
  } catch (error) {
    console.error('Error processing video metadata:', error);
    throw error;
  }
};

// Image conversion functions
const convertImage = async (inputPath, outputPath, settings) => {
  try {
    console.log(`Converting image: ${inputPath} -> ${outputPath}`);
    console.log('Conversion settings:', settings);
    
    let sharpInstance = sharp(inputPath);
    
    // Apply resize if requested
    if (settings.resize) {
      if (settings.maintainAspectRatio) {
        sharpInstance = sharpInstance.resize(settings.width, settings.height, {
          fit: 'inside',
          withoutEnlargement: true
        });
      } else {
        sharpInstance = sharpInstance.resize(settings.width, settings.height);
      }
    }
    
    // Convert to the specified format
    const outputFormat = settings.outputFormat.toLowerCase();
    
    switch (outputFormat) {
      case 'png':
        await sharpInstance
          .png({ quality: settings.quality })
          .toFile(outputPath);
        break;
        
      case 'jpg':
      case 'jpeg':
        await sharpInstance
          .jpeg({ quality: settings.quality })
          .toFile(outputPath);
        break;
        
      case 'webp':
        await sharpInstance
          .webp({ quality: settings.quality })
          .toFile(outputPath);
        break;
        
      case 'gif':
        await sharpInstance
          .gif()
          .toFile(outputPath);
        break;
        
      case 'bmp':
        await sharpInstance
          .bmp()
          .toFile(outputPath);
        break;
        
      case 'tiff':
        await sharpInstance
          .tiff({ quality: settings.quality })
          .toFile(outputPath);
        break;
        
      case 'svg':
        throw new Error('SVG conversion is not supported. SVG is a vector format and cannot be generated from raster images. Please use PNG, JPEG, or WebP instead.');
        
      case 'ico':
        const icoPngOutputPath = outputPath.replace('.ico', '.png');
        await sharpInstance
          .png({ quality: settings.quality })
          .toFile(icoPngOutputPath);
        console.log('Note: ICO conversion requires special handling. Converted to PNG instead.');
        // Update the output path to reflect the actual file extension
        return icoPngOutputPath;
        
      case 'avif':
        await sharpInstance
          .avif({ quality: settings.quality })
          .toFile(outputPath);
        break;
        
      default:
        throw new Error(`Unsupported output format: ${outputFormat}`);
    }
    
    console.log(`Successfully converted image to ${outputFormat}`);
    return true;
    
  } catch (error) {
    console.error('Error converting image:', error);
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
    
    // Get language preference from request body (optional)
    const language = req.body.language || null;
    const transcriptionOptions = language ? { language } : {};
    
    const transcription = await transcribeAudio(audioPath, transcriptionOptions);
    
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

// Direct audio transcription endpoint (skips video processing)
app.post('/api/transcribe-audio', audioUpload.single('audio'), async (req, res) => {
  try {
    console.log('Direct audio transcription request received');
    
    if (!req.file) {
      console.log('No audio file uploaded');
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const fileSizeMB = (req.file.size / (1024 * 1024)).toFixed(2);
    console.log('Audio file received:', req.file.originalname, 'Size:', fileSizeMB + ' MB');
    
    const audioPath = req.file.path;
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    
    // Check if it's a supported audio format
    const supportedFormats = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma'];
    if (!supportedFormats.includes(fileExtension)) {
      return res.status(400).json({ 
        error: 'Unsupported audio format', 
        supportedFormats: supportedFormats,
        receivedFormat: fileExtension
      });
    }

    console.log('Starting direct audio transcription...');
    console.log('Audio path:', audioPath);
    
    // Get language preference from request body (optional)
    const language = req.body.language || null;
    const transcriptionOptions = language ? { language } : {};
    
    let transcription;
    
    // Check if file is large (over 20MB) and needs chunking
    if (req.file.size > 20 * 1024 * 1024) {
      console.log('Large file detected, using chunked processing...');
      transcription = await transcribeAudioChunked(audioPath, transcriptionOptions);
    } else {
      console.log('Small file, using direct processing...');
      transcription = await transcribeAudio(audioPath, transcriptionOptions);
    }
    
    console.log('Direct audio transcription completed successfully');
    console.log('Transcription length:', transcription.length, 'characters');
    
    res.json({
      success: true,
      transcription: transcription,
      filename: req.file.originalname,
      fileSize: fileSizeMB + ' MB',
      transcriptionLength: transcription.length,
      processingType: req.file.size > 20 * 1024 * 1024 ? 'chunked_audio' : 'direct_audio'
    });
    
  } catch (error) {
    console.error('Direct audio transcription error:', error);
    
    // Clean up file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: 'Audio transcription failed', 
      details: error.message 
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


// Metadata processing endpoint
app.post('/api/process-metadata', mediaUpload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    console.log('Metadata processing request received:', req.files.length, 'files');

    // Parse metadata options
    const metadataOptions = JSON.parse(req.body.metadataOptions || '{}');
    console.log('Metadata options:', metadataOptions);

    const processedFiles = [];
    const processedDir = path.join(__dirname, 'processed');
    if (!fs.existsSync(processedDir)) {
      fs.mkdirSync(processedDir);
    }

    // Process each file
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const fileExtension = path.extname(file.originalname).toLowerCase();
      const isImage = file.mimetype.startsWith('image/');
      const isVideo = file.mimetype.startsWith('video/');

      console.log(`Processing file ${i + 1}/${req.files.length}: ${file.originalname}`);

      try {
        const outputFilename = `processed_${Date.now()}_${file.originalname}`;
        const outputPath = path.join(processedDir, outputFilename);

        if (isImage) {
          await processImageMetadata(file.path, outputPath, metadataOptions);
        } else if (isVideo) {
          await processVideoMetadata(file.path, outputPath, metadataOptions);
        } else {
          throw new Error('Unsupported file type');
        }

        processedFiles.push(outputFilename);
        console.log(`Successfully processed: ${file.originalname} -> ${outputFilename}`);

      } catch (fileError) {
        console.error(`Error processing file ${file.originalname}:`, fileError);
        // Continue with other files even if one fails
      }
    }

    // Clean up uploaded files
    for (const file of req.files) {
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      } catch (cleanupError) {
        console.error('Error cleaning up file:', file.originalname, cleanupError);
      }
    }

    res.json({
      success: true,
      processedFiles: processedFiles,
      totalFiles: req.files.length,
      processedCount: processedFiles.length
    });

  } catch (error) {
    console.error('Metadata processing error:', error);
    
    // Clean up files if they exist
    if (req.files) {
      for (const file of req.files) {
        try {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        } catch (cleanupError) {
          console.error('Error cleaning up file:', file.originalname, cleanupError);
        }
      }
    }
    
    res.status(500).json({ 
      error: 'Metadata processing failed', 
      details: error.message 
    });
  }
});

// Download processed metadata file
app.get('/api/download-metadata-file/:filename(*)', (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(__dirname, 'processed', filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filePath);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed', details: error.message });
  }
});

// Download all processed metadata files as ZIP
app.post('/api/download-all-metadata-files', (req, res) => {
  try {
    const { files } = req.body;
    const processedDir = path.join(__dirname, 'processed');
    
    if (!fs.existsSync(processedDir)) {
      return res.status(404).json({ error: 'No processed files found' });
    }
    
    // For now, we'll create a simple directory listing
    // In a real implementation, you'd use a ZIP library like archiver
    const availableFiles = [];
    files.forEach(filename => {
      const filePath = path.join(processedDir, filename);
      if (fs.existsSync(filePath)) {
        availableFiles.push(filename);
      }
    });
    
    // Create a simple text file with download instructions
    const downloadInstructions = `Metadata Processing Results
Generated: ${new Date().toISOString()}

Processed files:
${availableFiles.map(file => `  ${file}`).join('\n')}

To download individual files, use the download links in the application.

Total files: ${availableFiles.length}
`;
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="metadata-processing-results.txt"');
    res.send(downloadInstructions);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed', details: error.message });
  }
});

// Image conversion endpoint
app.post('/api/convert-images', imageUpload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    console.log('Image conversion request received:', req.files.length, 'files');

    // Parse conversion settings
    const conversionSettings = JSON.parse(req.body.conversionSettings || '{}');
    console.log('Conversion settings:', conversionSettings);

    const convertedFiles = [];
    const processedDir = path.join(__dirname, 'processed');
    if (!fs.existsSync(processedDir)) {
      fs.mkdirSync(processedDir);
    }

    // Process each file
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const fileExtension = path.extname(file.originalname).toLowerCase();
      const baseName = path.basename(file.originalname, fileExtension);

      console.log(`Converting file ${i + 1}/${req.files.length}: ${file.originalname}`);

      try {
        const outputExtension = `.${conversionSettings.outputFormat}`;
        const outputFilename = `converted_${Date.now()}_${baseName}${outputExtension}`;
        const outputPath = path.join(processedDir, outputFilename);

        const actualOutputPath = await convertImage(file.path, outputPath, conversionSettings);
        
        // Get the actual filename from the returned path
        const actualFilename = path.basename(actualOutputPath);
        convertedFiles.push(actualFilename);
        console.log(`Successfully converted: ${file.originalname} -> ${actualFilename}`);

      } catch (fileError) {
        console.error(`Error converting file ${file.originalname}:`, fileError);
        // Continue with other files even if one fails
      }
    }

    // Clean up uploaded files
    for (const file of req.files) {
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      } catch (cleanupError) {
        console.error('Error cleaning up file:', file.originalname, cleanupError);
      }
    }

    res.json({
      success: true,
      convertedFiles: convertedFiles,
      totalFiles: req.files.length,
      convertedCount: convertedFiles.length
    });

  } catch (error) {
    console.error('Image conversion error:', error);
    
    // Clean up files if they exist
    if (req.files) {
      for (const file of req.files) {
        try {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        } catch (cleanupError) {
          console.error('Error cleaning up file:', file.originalname, cleanupError);
        }
      }
    }
    
    res.status(500).json({ 
      error: 'Image conversion failed', 
      details: error.message 
    });
  }
});

// Download converted image file
app.get('/api/download-converted-file/:filename(*)', (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(__dirname, 'processed', filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filePath);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed', details: error.message });
  }
});

// Download all converted image files as ZIP
app.post('/api/download-all-converted-files', (req, res) => {
  try {
    const { files } = req.body;
    const processedDir = path.join(__dirname, 'processed');
    
    if (!fs.existsSync(processedDir)) {
      return res.status(404).json({ error: 'No converted files found' });
    }
    
    // For now, we'll create a simple directory listing
    // In a real implementation, you'd use a ZIP library like archiver
    const availableFiles = [];
    files.forEach(filename => {
      const filePath = path.join(processedDir, filename);
      if (fs.existsSync(filePath)) {
        availableFiles.push(filename);
      }
    });
    
    // Create a simple text file with download instructions
    const downloadInstructions = `Image Conversion Results
Generated: ${new Date().toISOString()}

Converted files:
${availableFiles.map(file => `  ${file}`).join('\n')}

To download individual files, use the download links in the application.

Total files: ${availableFiles.length}
`;
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="image-conversion-results.txt"');
    res.send(downloadInstructions);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed', details: error.message });
  }
});

// Zigzag PDF merge endpoint
app.post('/api/zigzag-merge', pdfUpload.fields([
  { name: 'coverPage', maxCount: 1 },
  { name: 'oldPdf', maxCount: 1 },
  { name: 'newPdf', maxCount: 1 }
]), async (req, res) => {
  try {
    if (!req.files || !req.files.oldPdf || !req.files.newPdf) {
      return res.status(400).json({ error: 'Both old and new PDF files are required' });
    }

    const oldPdfPath = req.files.oldPdf[0].path;
    const newPdfPath = req.files.newPdf[0].path;
    const coverPagePath = req.files.coverPage ? req.files.coverPage[0].path : null;

    console.log('Zigzag merge request received');
    if (coverPagePath) {
      console.log('Cover page:', req.files.coverPage[0].originalname);
    }
    console.log('Old PDF:', req.files.oldPdf[0].originalname);
    console.log('New PDF:', req.files.newPdf[0].originalname);

    // Load both PDFs
    const oldPdfBytes = fs.readFileSync(oldPdfPath);
    const newPdfBytes = fs.readFileSync(newPdfPath);
    
    const oldPdfDoc = await PDFDocument.load(oldPdfBytes);
    const newPdfDoc = await PDFDocument.load(newPdfBytes);

    // Create new merged PDF
    const mergedPdf = await PDFDocument.create();

    // Add cover page first if provided
    if (coverPagePath) {
      const coverPageBytes = fs.readFileSync(coverPagePath);
      const coverPageDoc = await PDFDocument.load(coverPageBytes);
      const coverPages = coverPageDoc.getPages();
      if (coverPages.length > 0) {
        // Add only the first page of the cover PDF
        const [copiedCoverPage] = await mergedPdf.copyPages(coverPageDoc, [0]);
        mergedPdf.addPage(copiedCoverPage);
      }
    }

    const oldPageCount = oldPdfDoc.getPageCount();
    const newPageCount = newPdfDoc.getPageCount();
    const maxPages = Math.max(oldPageCount, newPageCount);

    console.log(`Old PDF has ${oldPageCount} pages`);
    console.log(`New PDF has ${newPageCount} pages`);
    console.log(`Merging ${maxPages} page pairs...`);

    // Alternate pages: old, new, old, new, etc.
    // Each addPage() call creates a separate page
    for (let i = 0; i < maxPages; i++) {
      try {
        // Log progress every 10 pages
        if (i % 10 === 0 || i === maxPages - 1) {
          console.log(`Processing page ${i + 1} of ${maxPages}...`);
        }

        // Add old PDF page as a separate page
        if (i < oldPageCount) {
          const [copiedOldPage] = await mergedPdf.copyPages(oldPdfDoc, [i]);
          mergedPdf.addPage(copiedOldPage);
        }

        // Add new PDF page as a separate page
        if (i < newPageCount) {
          const [copiedNewPage] = await mergedPdf.copyPages(newPdfDoc, [i]);
          mergedPdf.addPage(copiedNewPage);
        }
      } catch (pageError) {
        console.error(`Error processing page ${i + 1}:`, pageError);
        throw new Error(`Failed to merge page ${i + 1}: ${pageError.message}`);
      }
    }

    console.log(`Successfully merged all ${maxPages} page pairs`);

    // Verify final page count
    const finalPageCount = mergedPdf.getPageCount();
    const expectedPageCount = (coverPagePath ? 1 : 0) + (oldPageCount + newPageCount);
    console.log(`Final merged PDF has ${finalPageCount} pages (expected: ${expectedPageCount})`);
    
    if (finalPageCount !== expectedPageCount) {
      console.warn(`Warning: Page count mismatch! Expected ${expectedPageCount} but got ${finalPageCount}`);
    }

    // Save merged PDF
    const mergedPdfBytes = await mergedPdf.save();
    const outputFilename = `zigzag-merged-${Date.now()}.pdf`;
    const outputPath = path.join(pdfsDir, outputFilename);
    fs.writeFileSync(outputPath, mergedPdfBytes);
    
    console.log(`Saved merged PDF: ${outputFilename} (${finalPageCount} pages, ${(mergedPdfBytes.length / 1024 / 1024).toFixed(2)} MB)`);

    // Clean up uploaded files
    fs.unlinkSync(oldPdfPath);
    fs.unlinkSync(newPdfPath);
    if (coverPagePath) {
      fs.unlinkSync(coverPagePath);
    }

    console.log(`Successfully merged PDFs: ${outputFilename}`);

    res.json({
      message: 'PDFs merged successfully',
      filename: outputFilename
    });

  } catch (error) {
    console.error('Zigzag merge error:', error);
    res.status(500).json({ 
      error: 'Failed to merge PDFs', 
      details: error.message 
    });
  }
});

// Unzigzag PDF endpoint
app.post('/api/unzigzag', pdfUpload.single('zigzagPdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Zigzagged PDF file is required' });
    }

    const zigzagPdfPath = req.file.path;
    console.log('Unzigzag request received');
    console.log('Zigzag PDF:', req.file.originalname);

    // Load zigzagged PDF
    const zigzagPdfBytes = fs.readFileSync(zigzagPdfPath);
    const zigzagPdfDoc = await PDFDocument.load(zigzagPdfBytes);

    // Create two separate PDFs
    const oldPdf = await PDFDocument.create();
    const newPdf = await PDFDocument.create();

    const pages = zigzagPdfDoc.getPages();
    
    if (pages.length === 0) {
      throw new Error('Zigzagged PDF has no pages');
    }

    // Split alternating pages: even pages (0, 2, 4...) go to old, odd pages (1, 3, 5...) go to new
    for (let i = 0; i < pages.length; i++) {
      if (i % 2 === 0) {
        // Even pages (0, 2, 4...) -> old PDF
        const [copiedPage] = await oldPdf.copyPages(zigzagPdfDoc, [i]);
        oldPdf.addPage(copiedPage);
      } else {
        // Odd pages (1, 3, 5...) -> new PDF
        const [copiedPage] = await newPdf.copyPages(zigzagPdfDoc, [i]);
        newPdf.addPage(copiedPage);
      }
    }

    // Save both PDFs
    const oldPdfBytes = await oldPdf.save();
    const newPdfBytes = await newPdf.save();
    
    const oldFilename = `unzigzag-old-${Date.now()}.pdf`;
    const newFilename = `unzigzag-new-${Date.now()}.pdf`;
    
    const oldPath = path.join(pdfsDir, oldFilename);
    const newPath = path.join(pdfsDir, newFilename);
    
    fs.writeFileSync(oldPath, oldPdfBytes);
    fs.writeFileSync(newPath, newPdfBytes);

    // Clean up uploaded file
    fs.unlinkSync(zigzagPdfPath);

    console.log(`Successfully split PDF: ${oldFilename}, ${newFilename}`);

    res.json({
      message: 'PDF split successfully',
      files: [oldFilename, newFilename]
    });

  } catch (error) {
    console.error('Unzigzag error:', error);
    res.status(500).json({ 
      error: 'Failed to split PDF', 
      details: error.message 
    });
  }
});

// Download PDF file
app.get('/api/download-pdf/:filename(*)', (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(pdfsDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filePath);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed', details: error.message });
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