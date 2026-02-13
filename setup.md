# 🚀 Quick Setup for Real Video Transcription

## Step 1: Get OpenAI API Key

1. Go to https://platform.openai.com/
2. Sign up or log in
3. Go to "API Keys" section
4. Click "Create new secret key"
5. Copy your API key (starts with `sk-`)

## Step 2: Set Environment Variable

**Windows:**
```cmd
set OPENAI_API_KEY=sk-your-api-key-here
```

**macOS/Linux:**
```bash
export OPENAI_API_KEY=sk-your-api-key-here
```

## Step 3: Install FFmpeg

**Windows:**
1. Download from https://ffmpeg.org/download.html
2. Extract to a folder (e.g., `C:\ffmpeg`)
3. Add to PATH: `C:\ffmpeg\bin`

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt update && sudo apt install ffmpeg
```

## Step 4: Test Installation

```bash
# Test FFmpeg
ffmpeg -version

# Test OpenAI API key (replace with your key)
curl -H "Authorization: Bearer sk-your-api-key-here" https://api.openai.com/v1/models
```

## Step 5: Start the App

```bash
# Build the client
npm run build

# Start the server
npm start
```

## Step 6: Test Transcription

1. Open http://localhost:5000
2. Upload a video with clear audio
3. Click "Transcribe Video"
4. Wait for the real transcription!

## Troubleshooting

- **"FFmpeg not found"**: Make sure FFmpeg is installed and in PATH
- **"API key not found"**: Check your environment variable is set correctly
- **"Transcription failed"**: Check server logs for detailed error messages

## Cost Estimate

- OpenAI Whisper API: ~$0.006 per minute of audio
- A 10-minute video costs about $0.06 to transcribe 