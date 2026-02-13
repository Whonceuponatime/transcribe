# Video Transcription App

A full-stack web application for uploading videos and transcribing audio to text using OpenAI Whisper API.

## Features

- Upload large video files (no size limit)
- Real-time audio extraction using FFmpeg
- Transcription using OpenAI Whisper API
- **Live Audio Translation** - Real-time microphone translation between Vietnamese and English
- Modern React frontend with drag-and-drop upload
- Progress tracking for large files
- Export transcription results
- Text-to-Speech (OpenAI & ElevenLabs)
- Metadata removal tools
- Image conversion
- PDF zigzag merging

## Setup

### Prerequisites

- Node.js (v14 or higher)
- FFmpeg installed on your system
- OpenAI API key

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd transcribe
   ```

2. **Install dependencies**
   ```bash
   npm install
   cd client
   npm install
   cd ..
   ```

3. **Set up environment variables**
   
   Create a `.env` file in the root directory:
   ```
   OPENAI_API_KEY=your_openai_api_key_here
   PORT=3000
   NODE_ENV=development
   ```
   
   **Required Environment Variables:**
   - `OPENAI_API_KEY` (Required): Your OpenAI API key for Whisper transcription and GPT translation
     - Used for: Live audio transcription and text translation
     - Get your key from: https://platform.openai.com/api-keys
   
   **Optional Environment Variables:**
   - `ELEVENLABS_API_KEY`: For ElevenLabs text-to-speech (optional)
   - `PORT`: Server port (default: 3000)
   - `NODE_ENV`: Environment mode (development/production)
   
   Or set the environment variable directly:
   ```bash
   set OPENAI_API_KEY=your_openai_api_key_here
   ```

4. **Install FFmpeg**
   
   Download and install FFmpeg from: https://ffmpeg.org/download.html
   
   Make sure FFmpeg is available in your system PATH.

### Running the Application

#### Option 1: Using batch files (Windows)
```bash
# Start the backend server
.\start-server.bat

# In a new terminal, start the frontend
.\start-frontend.bat
```

#### Option 2: Manual startup
```bash
# Terminal 1: Start backend
set OPENAI_API_KEY=your_api_key_here
node server.js

# Terminal 2: Start frontend
cd client
npm start
```

### Access the Application

- Frontend: http://localhost:3000
- Backend API: http://localhost:5000

## Security Notes

⚠️ **IMPORTANT**: Never commit your API keys to version control!

- The `.gitignore` file excludes sensitive files
- API keys should be stored in environment variables
- Update `start-server.bat` with your actual API key before running

## API Endpoints

- `GET /api/test` - Test server status
- `POST /api/upload` - Upload video file
- `POST /api/transcribe` - Transcribe video audio
- `GET /api/files` - List uploaded files

## File Structure

```
transcribe/
├── server.js              # Backend server
├── client/                # React frontend
│   ├── src/
│   │   ├── components/
│   │   └── App.js
│   └── package.json
├── uploads/               # Uploaded video files
├── audio/                 # Temporary audio files
├── .gitignore            # Git ignore rules
├── start-server.bat      # Windows server startup
└── start-frontend.bat    # Windows frontend startup
```

## Troubleshooting

### Common Issues

1. **Port 5000 already in use**
   - The batch file will automatically kill existing processes
   - Or manually: `taskkill /F /IM node.exe`

2. **FFmpeg not found**
   - Install FFmpeg and add to system PATH
   - Test with: `ffmpeg -version`

3. **API key errors**
   - Verify your OpenAI API key is correct
   - Check environment variable is set: `echo %OPENAI_API_KEY%`

4. **Large file uploads fail**
   - Server is configured for unlimited file sizes
   - Check network timeout settings

## Development

- Backend: Node.js with Express
- Frontend: React with modern hooks
- File processing: FFmpeg for audio extraction
- Transcription: OpenAI Whisper API

## License

This project is for educational purposes. Please respect OpenAI's usage policies. 