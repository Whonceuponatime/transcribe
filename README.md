# Video Transcription & Text-to-Speech App

A full-stack web application for uploading videos and transcribing audio to text, plus converting text to speech for learning on the go using OpenAI APIs.

## Features

### Video Transcription
- Upload large video files (no size limit)
- Real-time audio extraction using FFmpeg
- Transcription using OpenAI Whisper API
- Modern React frontend with drag-and-drop upload
- Progress tracking for large files
- Export transcription results

### Text-to-Speech
- Convert text to speech using **OpenAI TTS** or **ElevenLabs** APIs
- **OpenAI**: 6 high-quality voices (Alloy, Echo, Fable, Onyx, Nova, Shimmer)
- **ElevenLabs**: 100+ voices with various accents and styles
- Upload text files (.txt, .md, .doc, .docx) or paste text directly
- Automatic handling of long texts (chunks and combines audio)
- Markdown formatting automatically cleaned for natural speech
- Audio playback with play/pause/stop controls
- Save and manage converted texts
- Perfect for learning while driving or multitasking

### User Authentication
- **Supabase Authentication** for secure user management
- Email/password sign up and sign in
- Protected API endpoints requiring authentication
- User session management
- Secure token-based authentication

## Setup

### Prerequisites

- Node.js (v14 or higher)
- FFmpeg installed on your system
- OpenAI API key
- Supabase account and project

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
   ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
   SUPABASE_URL=your_supabase_url_here
   SUPABASE_ANON_KEY=your_supabase_anon_key_here
   PORT=5000
   NODE_ENV=development
   ```
   
   Create a `.env` file in the `client` directory:
   ```
   REACT_APP_SUPABASE_URL=your_supabase_url_here
   REACT_APP_SUPABASE_ANON_KEY=your_supabase_anon_key_here
   ```
   
   Or set the environment variables directly:
   ```bash
   set OPENAI_API_KEY=your_api_key_here
   set ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
   set SUPABASE_URL=your_supabase_url_here
   set SUPABASE_ANON_KEY=your_supabase_anon_key_here
   ```

4. **Set up Supabase Authentication**
   
   Create a Supabase project at https://supabase.com
   
   In your Supabase dashboard:
   - Go to Settings > API
   - Copy your Project URL and anon/public key
   - Add these to your environment variables
   
   Enable Email authentication:
   - Go to Authentication > Settings
   - Enable "Enable email confirmations" if desired
   - Configure any additional auth settings

5. **Install FFmpeg**
   
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

### Video Transcription
- `GET /api/test` - Test server status
- `POST /api/upload` - Upload video file (requires authentication)
- `POST /api/transcribe` - Transcribe video audio (requires authentication)
- `GET /api/files` - List uploaded files

### Text-to-Speech
- `GET /api/voices` - Get available voices from both providers (requires authentication)
- `POST /api/text-to-speech` - Convert text to speech (supports provider and voice selection, requires authentication)

## File Structure

```
transcribe/
├── server.js              # Backend server
├── client/                # React frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── TextToSpeech.js    # Text-to-speech component
│   │   │   ├── TextToSpeech.css   # TTS styles
│   │   │   ├── Auth.js            # Authentication component
│   │   │   └── Auth.css           # Auth styles
│   │   ├── supabase.js            # Supabase client config
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