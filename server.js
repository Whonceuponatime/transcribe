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

// Configure multer for text file uploads
const textUpload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Accept text and markdown files
    if (file.mimetype === 'text/plain' || 
        file.mimetype === 'text/markdown' || 
        file.originalname.endsWith('.txt') || 
        file.originalname.endsWith('.md')) {
      cb(null, true);
    } else {
      cb(new Error('Only text and markdown files are allowed!'), false);
    }
  }
  // Removed file size limits to handle large files
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
const transcribeAudio = async (audioPath, options = {}) => {
  if (!openai) {
    throw new Error('OpenAI API key not configured. Please set OPENAI_API_KEY environment variable.');
  }
  
  try {
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

// Global processing lock
let isProcessing = false;

// File analysis endpoint for multiple files (directory upload)
app.post('/api/analyze-files', textUpload.array('files', 100), async (req, res) => {
  try {
    if (isProcessing) {
      return res.status(429).json({ error: 'Another analysis is already in progress. Please wait for it to complete.' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    if (!openai) {
      return res.status(503).json({ error: 'OpenAI API key not configured. Please set OPENAI_API_KEY environment variable.' });
    }

    isProcessing = true;

    console.log('Multiple file analysis request received:', req.files.length, 'files');
    console.log('Request body keys:', Object.keys(req.body));
    console.log('Request body paths:', req.body.paths);
    console.log('Directory tree provided:', req.body.directoryTree ? 'Yes' : 'No');

    // Read all uploaded files with directory structure
    const fileContents = [];
    const fileNames = [];
    const filePaths = [];
    
    console.log('Processing files with paths from form data...');
    
    console.log('Form data keys:', Object.keys(req.body));
    console.log('Files received:', req.files.length);
    
    // Parse directory tree if provided
    let directoryMap = {};
    if (req.body.directoryTree) {
      console.log('Parsing directory tree...');
      const treeLines = req.body.directoryTree.split('\n');
      let currentPath = '';
      
      for (const line of treeLines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        
        // Check if this is a directory (ends with / or contains │ or ├─ or └─)
        if (trimmedLine.includes('│') || trimmedLine.includes('├─') || trimmedLine.includes('└─')) {
          // Extract directory name
          const dirMatch = trimmedLine.match(/[├└]─(.+)/);
          if (dirMatch) {
            const dirName = dirMatch[1].trim();
            if (dirName && !dirName.endsWith('.md') && !dirName.endsWith('.txt')) {
              currentPath = currentPath ? `${currentPath}/${dirName}` : dirName;
              console.log(`Found directory: ${currentPath}`);
            }
          }
        } else if (trimmedLine.includes('.md') || trimmedLine.includes('.txt')) {
          // This is a file
          const fileMatch = trimmedLine.match(/([^│├└\s]+\.(md|txt))/);
          if (fileMatch) {
            const fileName = fileMatch[1];
            const fullPath = currentPath ? `${currentPath}/${fileName}` : fileName;
            directoryMap[fileName] = fullPath;
            console.log(`Mapped file: ${fileName} -> ${fullPath}`);
          }
        }
      }
    }
    
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      // Get the path from the form data - handle both array and single value
      let relativePath = file.originalname;
      
      if (req.body.paths) {
        if (Array.isArray(req.body.paths)) {
          relativePath = req.body.paths[i] || file.originalname;
        } else {
          relativePath = req.body.paths || file.originalname;
        }
      }
      
      // If we have a directory map, use it to get the correct path
      if (Object.keys(directoryMap).length > 0 && directoryMap[file.originalname]) {
        relativePath = directoryMap[file.originalname];
        console.log(`Using directory map for ${file.originalname}: ${relativePath}`);
      }
      
      try {
        const content = fs.readFileSync(file.path, 'utf8');
        fileContents.push(content);
        fileNames.push(file.originalname);
        filePaths.push(relativePath);
        
        console.log(`File: ${file.originalname} -> Path: ${relativePath}`);
      } catch (readError) {
        console.error('Error reading file:', file.originalname, readError);
      }
    }
    
    console.log('Total files processed:', fileContents.length);
    console.log('File paths:', filePaths);

    if (fileContents.length === 0) {
      return res.status(400).json({ error: 'No valid files could be read' });
    }

    // Combine all file contents
    const combinedContent = fileContents.join('\n\n---\n\n');
    
    // Create a comprehensive prompt for OpenAI to analyze multiple files with directory structure
    const analysisPrompt = `You are an expert at analyzing Obsidian notes and creating intelligent links between related content across multiple files.

IMPORTANT: Consider the directory structure when creating links. Files are organized in folders that represent different phases or categories of penetration testing methodology.

Analyze the following collection of files and identify potential links that should be created. Look for:
1. References to numbered sections (like "4.1 Exploitation", "4.2 Post-Exploitation", "5. Lateral Movement")
2. Related concepts that should be linked across different files
3. Contextual relationships between different topics
4. Any mentions that could benefit from wiki-style links [[]]
5. Cross-references between files
6. Similar concepts mentioned in different contexts
7. **Directory-aware linking** - consider the folder structure when suggesting links
8. **Single-quoted keywords** - if you find keywords surrounded by single quotes like 'Exploitation', 'Post-Exploitation', 'Lateral Movement', etc., these should be converted to wiki-links with the appropriate numbered format (e.g., 'Exploitation' becomes [[4.1 Exploitation]])
9. **Skip already linked content** - do not suggest links for text that is already properly linked with [[]] brackets

For each potential link you find, provide:
- The exact text that should be linked
- The suggested link name (without the [[]] brackets)
- A brief explanation of why this should be linked
- Which file(s) contain the related content
- Consider the directory structure when suggesting link names

Format your response as a comprehensive analysis with specific suggestions for Obsidian linking across the entire collection.

Files to analyze (${fileNames.length} files):
${fileNames.join(', ')}

Directory structure context:
${filePaths.map((path, i) => `${i + 1}. ${path}`).join('\n')}

Combined content:
${combinedContent}

Please provide your analysis and linking suggestions:`;

    // Create a second prompt for processing files with embedded links
    const processingPrompt = `Based on the analysis above, process each file and embed the appropriate wiki-style links [[]] into the content.

For each file, replace mentions of related concepts with proper Obsidian wiki-links. For example:
- "Exploitation" becomes "[[4.1 Exploitation]]"
- "Post-Exploitation" becomes "[[4.2 Post-Exploitation]]"
- "Lateral Movement" becomes "[[5. Lateral Movement]]"

**IMPORTANT: Handle single-quoted keywords**
- Single-quoted keywords like 'Exploitation', 'Post-Exploitation', 'Lateral Movement' should be converted to wiki-links
- Remove the single quotes and replace with the appropriate numbered format
- Examples: 'Exploitation' → [[4.1 Exploitation]], 'Post-Exploitation' → [[4.2 Post-Exploitation]], 'Lateral Movement' → [[5. Lateral Movement]]
- **DO NOT modify text that is already properly linked** - if you see [[4.1 Exploitation]] or [[5. Lateral Movement]], leave it unchanged

Process each file individually and return the processed content with embedded links.

Files to process:
${fileNames.join(', ')}

Original content:
${combinedContent}

Please process each file and return the content with embedded wiki-links:`;

    // PHASE 1: Build complete document index for cross-referencing
    console.log('🔄 PHASE 1: Building complete document index...');
    io.emit('analysisProgress', { 
      message: 'Phase 1: Building complete document index for cross-referencing...',
      progress: 10
    });
    
    // Create a master index of all files for cross-referencing
    const masterIndex = fileNames.map((name, idx) => {
      const content = fileContents[idx];
      const truncatedContent = content.substring(0, 2500); // Increased to 2500 chars since o1-mini has higher limits
      return `File: ${name}\nPath: ${filePaths[idx]}\nContent Preview: ${truncatedContent}...`;
    }).join('\n\n---\n\n');
    
    console.log(`📚 Built master index of ${fileNames.length} files for cross-referencing`);
    io.emit('analysisProgress', { 
      message: `Built master index of ${fileNames.length} files`,
      progress: 20
    });
    
    // PHASE 2: Process files with full cross-file context
    console.log('🔗 PHASE 2: Processing files with full cross-file context...');
    io.emit('analysisProgress', { 
      message: 'Phase 2: Processing files with full cross-file context...',
      progress: 30
    });
    
    let completedFiles = [];
    
    const batchSize = 5; // Process 5 files at a time since o1-mini has 200,000 TPM and better reasoning
    const delay = 20000; // 20 second delay between batches since o1-mini is more efficient
    const maxCharsPerFile = 3000; // Increased to 3000 chars per file since o1-mini has higher limits
    
    let analysisResult = '';
    let processedContent = '';
    
    // Process files in batches with FULL CROSS-FILE CONTEXT
    for (let i = 0; i < fileContents.length; i += batchSize) {
      const batch = fileContents.slice(i, i + batchSize);
      const batchNames = fileNames.slice(i, i + batchSize);
      const batchPaths = filePaths.slice(i, i + batchSize);
      
      const currentBatch = Math.floor(i/batchSize) + 1;
      const totalBatches = Math.ceil(fileContents.length/batchSize);
      
      console.log(`Processing batch ${currentBatch}/${totalBatches}: ${batchNames.length} files`);
      
      // Emit progress update to client
      io.emit('analysisProgress', {
        message: `Processing batch ${currentBatch}/${totalBatches} (${batchNames.length} files): ${batchNames.join(', ')}`,
        progress: 30 + (currentBatch / totalBatches) * 40 // 30-70% for processing
      });
      
      // Truncate content to stay under token limits
      const truncatedBatch = batch.map(content => 
        content.length > maxCharsPerFile ? content.substring(0, maxCharsPerFile) + '\n\n[Content truncated for token limits]' : content
      );
      
      const batchContent = truncatedBatch.join('\n\n---\n\n');
      
      // ENHANCED PROMPT WITH CROSS-FILE CONTEXT
      const batchPrompt = `You are an expert at analyzing Obsidian notes and creating intelligent links between related content.

IMPORTANT: You have access to the COMPLETE DOCUMENT INDEX below. Use this to create intelligent cross-references between files.

Analyze the following batch of files and create intelligent links. Look for:
1. References to numbered sections (like "4.1 Exploitation", "4.2 Post-Exploitation", "5. Lateral Movement")
2. Related concepts that should be linked across different files
3. Contextual relationships between different topics
4. Any mentions that could benefit from wiki-style links [[]]
5. **Single-quoted keywords** - if you find keywords surrounded by single quotes like 'Exploitation', 'Post-Exploitation', 'Lateral Movement', etc., these should be converted to wiki-links with the appropriate numbered format (e.g., 'Exploitation' becomes [[4.1 Exploitation]])
6. **Skip already linked content** - do not suggest links for text that is already properly linked with [[]] brackets
7. **Skip code snippets** - do NOT create links for keywords that appear inside code blocks (like \`\`\`shell\`\`\`, \`\`\`bash\`\`\`, \`\`\`python\`\`\`, etc.) or inline code (like \`shell\`, \`bash\`, etc.)

COMPLETE DOCUMENT INDEX (for cross-referencing):
${masterIndex}

CURRENT BATCH FILES:
${batchNames.join(', ')}

CURRENT BATCH PATHS:
${batchPaths.map((path, idx) => `${idx + 1}. ${path}`).join('\n')}

CURRENT BATCH CONTENT:
${batchContent}

Please provide your analysis and linking suggestions, taking into account the complete document index for cross-file references:`;

      try {
        const batchAnalysis = await openai.chat.completions.create({
          model: "gpt-4o-mini", // Use gpt-4o-mini which is more widely available
          messages: [
            {
              role: "user",
              content: `You are an expert at analyzing text files and creating intelligent links between related content, especially for Obsidian note-taking systems. You have access to a complete document index for cross-referencing.

${batchPrompt}`
            }
          ],
          max_tokens: 2000, // gpt-4o-mini uses max_tokens
          temperature: 0.3
        });

        analysisResult += `\n\n--- BATCH ${Math.floor(i/batchSize) + 1} ---\n\n`;
        analysisResult += batchAnalysis.choices[0].message.content;
        
        // Track completed files
        completedFiles.push(...batchNames);
        io.emit('analysisProgress', {
          message: `Completed batch ${Math.floor(i/batchSize) + 1}/${totalBatches}`,
          progress: 30 + ((i + batchSize) / fileContents.length) * 40,
          completedFiles: completedFiles,
          currentBatch: Math.floor(i/batchSize) + 1,
          totalBatches: totalBatches
        });
        
        // Add delay between batches (except for the last batch)
        if (i + batchSize < fileContents.length) {
          console.log(`Waiting ${delay/1000} seconds before next batch...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        console.error(`Error processing batch ${Math.floor(i/batchSize) + 1}:`, error);
        
        // Handle rate limit errors with retry logic
        if (error.code === 'rate_limit_exceeded') {
          console.log('Rate limit exceeded, waiting 2 minutes before retry...');
          io.emit('analysisProgress', {
            message: 'Rate limit exceeded, waiting 2 minutes before retry...',
            progress: 30 + ((i + batchSize) / fileContents.length) * 40
          });
          
          // Wait 2 minutes for rate limit to reset
          await new Promise(resolve => setTimeout(resolve, 120000));
          
          // Retry the same batch
          i -= batchSize; // Retry this batch
          continue;
        }
        
        analysisResult += `\n\n--- ERROR IN BATCH ${Math.floor(i/batchSize) + 1} ---\n\n`;
        analysisResult += `Error: ${error.message}\n`;
        analysisResult += `Files in this batch: ${batchNames.join(', ')}\n`;
      }
    }

    // PHASE 3: Process files in batches for embedding links with cross-file context
    console.log('🔗 PHASE 3: Embedding links with cross-file context...');
    io.emit('analysisProgress', { 
      message: 'Phase 3: Embedding links with cross-file context...',
      progress: 70
    });
    
    for (let i = 0; i < fileContents.length; i += batchSize) {
      const batch = fileContents.slice(i, i + batchSize);
      const batchNames = fileNames.slice(i, i + batchSize);
      
      const currentBatch = Math.floor(i/batchSize) + 1;
      const totalBatches = Math.ceil(fileContents.length/batchSize);
      
      console.log(`Processing links for batch ${currentBatch}/${totalBatches}: ${batchNames.length} files`);
      
      // Emit progress update to client
      io.emit('analysisProgress', {
        message: `Processing links for batch ${currentBatch}/${totalBatches} (${batchNames.length} files): ${batchNames.join(', ')}`,
        progress: 50 + (currentBatch / totalBatches) * 50 // Second 50% for link processing
      });
      
      const batchContent = batch.join('\n\n---\n\n');
      const batchProcessingPrompt = `Based on the analysis above, process this batch of files and embed the appropriate wiki-style links [[]] into the content.

IMPORTANT: You have access to the COMPLETE DOCUMENT INDEX below. Use this to create intelligent cross-references between files.

For each file, replace mentions of related concepts with proper Obsidian wiki-links. For example:
- "Exploitation" becomes "[[4.1 Exploitation]]"
- "Post-Exploitation" becomes "[[4.2 Post-Exploitation]]"
- "Lateral Movement" becomes "[[5. Lateral Movement]]"

**IMPORTANT: Handle single-quoted keywords**
- Single-quoted keywords like 'Exploitation', 'Post-Exploitation', 'Lateral Movement' should be converted to wiki-links
- Remove the single quotes and replace with the appropriate numbered format
- Examples: 'Exploitation' → [[4.1 Exploitation]], 'Post-Exploitation' → [[4.2 Post-Exploitation]], 'Lateral Movement' → [[5. Lateral Movement]]
- **DO NOT modify text that is already properly linked** - if you see [[4.1 Exploitation]] or [[5. Lateral Movement]], leave it unchanged

**IMPORTANT: Skip code snippets**
- Do NOT create links for keywords that appear inside code blocks (like \`\`\`shell\`\`\`, \`\`\`bash\`\`\`, \`\`\`python\`\`\`, etc.)
- Do NOT create links for keywords that appear in inline code (like \`shell\`, \`bash\`, \`python\`, etc.)
- Code snippets should remain unchanged

**CRITICAL: RESPONSE FORMAT REQUIREMENTS**
You MUST follow this exact format for your response:

===FILE_SEPARATOR===
[First file content with embedded wiki-links]
===FILE_SEPARATOR===
[Second file content with embedded wiki-links]
===FILE_SEPARATOR===
[Third file content with embedded wiki-links]
===FILE_SEPARATOR===

**MANDATORY:**
1. Start your response with "===FILE_SEPARATOR==="
2. Process each file in the batch
3. Separate each file with "===FILE_SEPARATOR==="
4. End your response with "===FILE_SEPARATOR==="
5. Do NOT include any other text before or after the file content
6. Do NOT use any other separators like "---" or "###"

COMPLETE DOCUMENT INDEX (for cross-referencing):
${masterIndex}

CURRENT BATCH FILES:
${batchNames.join(', ')}

CURRENT BATCH CONTENT:
${batchContent}

Process each file and return ONLY the processed content with embedded wiki-links, separated by "===FILE_SEPARATOR===":`;

      try {
        let aiResponse = '';
        try {
          const batchProcessing = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Use gpt-4o-mini which is more widely available
            messages: [
              {
                role: "user",
                content: `You are an expert at processing text files and embedding Obsidian wiki-links. You understand the context and can intelligently replace mentions with proper wiki-style links [[]].

${batchProcessingPrompt}`
              }
            ],
            max_tokens: 3000, // gpt-4o-mini uses max_tokens
            temperature: 0.2
          });

          aiResponse = batchProcessing.choices[0].message.content;
          console.log(`AI Response for batch ${Math.floor(i/batchSize) + 1}:`);
          console.log('Response length:', aiResponse.length);
          console.log('Response preview:', aiResponse.substring(0, 300));
          console.log('Contains FILE_SEPARATOR:', aiResponse.includes('===FILE_SEPARATOR==='));
          console.log('Number of separators:', (aiResponse.match(/===FILE_SEPARATOR===/g) || []).length);
          
          processedContent += aiResponse;
          
          // Check if AI actually processed the content
          if (aiResponse.trim().length < 100) {
            console.log('WARNING: AI response seems too short, might be an error message');
            console.log('Full AI response:', aiResponse);
          }
        } catch (apiError) {
          console.error(`OpenAI API Error for batch ${Math.floor(i/batchSize) + 1}:`, apiError);
          console.error('Error details:', {
            message: apiError.message,
            code: apiError.code,
            status: apiError.status,
            type: apiError.type
          });
          
          // Add error information to processed content
          processedContent += `\n\n--- ERROR IN BATCH ${Math.floor(i/batchSize) + 1} ---\n\n`;
          processedContent += `OpenAI API Error: ${apiError.message}\n`;
          processedContent += `Error Code: ${apiError.code || 'Unknown'}\n`;
          processedContent += `Files in this batch: ${batchNames.join(', ')}\n`;
        }
        
        // Track completed files in processing phase
        completedFiles.push(...batchNames);
        io.emit('analysisProgress', {
          message: `Processed batch ${Math.floor(i/batchSize) + 1}/${totalBatches}`,
          progress: 70 + ((i + batchSize) / fileContents.length) * 30,
          completedFiles: completedFiles,
          currentBatch: Math.floor(i/batchSize) + 1,
          totalBatches: totalBatches
        });
        
        // Add delay between batches (except for the last batch)
        if (i + batchSize < fileContents.length) {
          console.log(`Waiting ${delay/1000} seconds before next batch...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        console.error(`Error processing links for batch ${Math.floor(i/batchSize) + 1}:`, error);
        
        // Handle rate limit errors with retry logic
        if (error.code === 'rate_limit_exceeded') {
          console.log('Rate limit exceeded in processing phase, waiting 2 minutes before retry...');
          io.emit('analysisProgress', {
            message: 'Rate limit exceeded in processing phase, waiting 2 minutes before retry...',
            progress: 70 + ((i + batchSize) / fileContents.length) * 30
          });
          
          // Wait 2 minutes for rate limit to reset
          await new Promise(resolve => setTimeout(resolve, 120000));
          
          // Retry the same batch
          i -= batchSize; // Retry this batch
          continue;
        }
        
        processedContent += `\n\n--- ERROR IN BATCH ${Math.floor(i/batchSize) + 1} ---\n\n`;
        processedContent += `Error: ${error.message}\n`;
        processedContent += `Files in this batch: ${batchNames.join(', ')}\n`;
      }
    }

    // Emit completion message
    io.emit('analysisProgress', {
      message: 'Analysis complete! Saving processed files...',
      progress: 100
    });
    
    // Send a final keep-alive message
    io.emit('analysisProgress', {
      message: 'Processing complete! Files are ready for download.',
      progress: 100,
      completedFiles: completedFiles
    });

    // Save processed files with directory structure
    const processedFiles = [];
    const processedDir = path.join(__dirname, 'processed');
    if (!fs.existsSync(processedDir)) {
      fs.mkdirSync(processedDir);
    }

    // Parse the processed content and save individual files with directory structure
    console.log('Processing content length:', processedContent.length);
    console.log('Number of files to process:', fileNames.length);
    
    // Try to split by the unique file separator first
    let fileSections = processedContent.split('===FILE_SEPARATOR===');
    console.log('Number of sections found with FILE_SEPARATOR:', fileSections.length);
    
    // If that doesn't work, try other separators
    if (fileSections.length < fileNames.length) {
      fileSections = processedContent.split('---');
      console.log('Number of sections found with ---:', fileSections.length);
    }
    if (fileSections.length < fileNames.length) {
      fileSections = processedContent.split('###');
      console.log('Number of sections found with ###:', fileSections.length);
    }
    if (fileSections.length < fileNames.length) {
      fileSections = processedContent.split('\n\n');
      console.log('Number of sections found with \\n\\n:', fileSections.length);
    }
    
    console.log('Final number of sections found:', fileSections.length);
    
    // If we still don't have enough sections, try to process what we have
    if (fileSections.length < fileNames.length) {
      console.log('Not enough sections found, attempting to process AI response...');
      console.log('AI Response length:', processedContent.length);
      console.log('AI Response preview:', processedContent.substring(0, 500));
      
      // Try to process the AI response even if it doesn't have exact separators
      if (processedContent.trim().length > 0) {
        // If we have some AI content, try to use it
        console.log('Using AI processed content with fallback...');
        
        for (let i = 0; i < fileNames.length; i++) {
          const fileName = fileNames[i];
          const relativePath = filePaths[i] || fileName;
          const originalContent = fileContents[i];
          
          // Create directory structure
          const fullPath = path.join(processedDir, relativePath);
          const dirPath = path.dirname(fullPath);
          
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
          
          // Try to find corresponding AI content, otherwise use original
          let processedContent = originalContent;
          if (i < fileSections.length && fileSections[i].trim()) {
            processedContent = fileSections[i].trim();
            console.log(`Using AI processed content for: ${relativePath}`);
          } else {
            console.log(`Using original content for: ${relativePath} (no AI content available)`);
          }
          
          fs.writeFileSync(fullPath, processedContent);
          processedFiles.push(relativePath);
          
          console.log(`Saved processed file: ${relativePath}`);
        }
      } else {
        // No AI content at all, use original files
        console.log('No AI content available, using original files...');
        
        for (let i = 0; i < fileNames.length; i++) {
          const fileName = fileNames[i];
          const relativePath = filePaths[i] || fileName;
          const originalContent = fileContents[i];
          
          // Create directory structure
          const fullPath = path.join(processedDir, relativePath);
          const dirPath = path.dirname(fullPath);
          
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
          
          fs.writeFileSync(fullPath, originalContent);
          processedFiles.push(relativePath);
          
          console.log(`Saved original file: ${relativePath}`);
        }
      }
    } else {
      // Use the AI-processed sections
      for (let i = 0; i < fileNames.length && i < fileSections.length; i++) {
        const fileName = fileNames[i];
        const relativePath = filePaths[i] || fileName;
        const fileContent = fileSections[i].trim();
        
        if (fileContent) {
          // Create directory structure
          const fullPath = path.join(processedDir, relativePath);
          const dirPath = path.dirname(fullPath);
          
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
          
          fs.writeFileSync(fullPath, fileContent);
          processedFiles.push(relativePath);
          
          console.log(`Saved processed file: ${relativePath}`);
        }
      }
    }

    // Clean up all uploaded files
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
      result: analysisResult,
      fileCount: fileNames.length,
      files: fileNames,
      processedFiles: processedFiles
    });

  } catch (error) {
    console.error('Multiple file analysis error:', error);
    
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
      error: 'File analysis failed', 
      details: error.message 
    });
  } finally {
    isProcessing = false; // Reset the lock
  }
});

// Download individual processed file with directory structure
app.get('/api/download-file/:filename(*)', (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(__dirname, 'processed', filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filename)}"`);
    res.sendFile(filePath);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed', details: error.message });
  }
});

// Download all processed files as ZIP with directory structure
app.post('/api/download-all-files', (req, res) => {
  try {
    const { files } = req.body;
    const processedDir = path.join(__dirname, 'processed');
    
    if (!fs.existsSync(processedDir)) {
      return res.status(404).json({ error: 'No processed files found' });
    }
    
    // Create a simple ZIP-like structure by creating a directory listing
    const availableFiles = [];
    files.forEach(filename => {
      const filePath = path.join(processedDir, filename);
      if (fs.existsSync(filePath)) {
        availableFiles.push(filename);
      }
    });
    
    // Create a directory structure report
    const structureReport = `Directory Structure Report
Generated: ${new Date().toISOString()}

Files processed with directory structure:
${availableFiles.map(file => `  ${file}`).join('\n')}

To restore your directory structure:
1. Create the necessary directories
2. Place each file in its corresponding directory
3. Replace existing files with the processed versions

Total files: ${availableFiles.length}
`;

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="directory-structure-report.txt"');
    res.send(structureReport);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed', details: error.message });
  }
});

// File analysis endpoint for single file (keeping for backward compatibility)
app.post('/api/analyze-file', textUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!openai) {
      return res.status(503).json({ error: 'OpenAI API key not configured. Please set OPENAI_API_KEY environment variable.' });
    }

    console.log('Single file analysis request received:', req.file.originalname);

    // Read the uploaded file
    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    
    // Create a prompt for OpenAI to analyze and link notes
    const analysisPrompt = `You are an expert at analyzing Obsidian notes and creating intelligent links between related content. 

Analyze the following text and identify potential links that should be created. Look for:
1. References to numbered sections (like "4.1 Exploitation", "4.2 Post-Exploitation", "5. Lateral Movement")
2. Related concepts that should be linked
3. Contextual relationships between different topics
4. Any mentions that could benefit from wiki-style links [[]]

For each potential link you find, provide:
- The exact text that should be linked
- The suggested link name (without the [[]] brackets)
- A brief explanation of why this should be linked

Format your response as a clear analysis with specific suggestions for Obsidian linking.

Text to analyze:
${fileContent}

Please provide your analysis and linking suggestions:`;

    // Call OpenAI API
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are an expert at analyzing text and creating intelligent links between related content, especially for Obsidian note-taking systems."
        },
        {
          role: "user",
          content: analysisPrompt
        }
      ],
      max_tokens: 2000,
      temperature: 0.3
    });

    const analysisResult = completion.choices[0].message.content;

    // Clean up the uploaded file
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      result: analysisResult,
      filename: req.file.originalname
    });

  } catch (error) {
    console.error('File analysis error:', error);
    
    // Clean up file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: 'File analysis failed', 
      details: error.message 
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