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

## Install as app (PWA) & deployment

You can use the site as an installable app (e.g. on Android: “Add to Home screen”) and optionally use a custom domain.

### Do I need a custom domain?

**No.** You can use the URL Vercel gives you (e.g. `https://your-project.vercel.app`). “Add to Home screen” and the app icon work the same with or without a custom domain.

**Optional:** To use a domain like `app.example.com`:
1. In the [Vercel dashboard](https://vercel.com/dashboard), open your project.
2. Go to **Settings → Domains**, add `app.example.com`.
3. In your DNS provider, add the CNAME record Vercel shows (e.g. `cname.vercel-dns.com`).

### How to set the app up (Vercel)

1. Push your code to GitHub and import the repo in [Vercel](https://vercel.com).
2. Add environment variables in **Project → Settings → Environment Variables** (e.g. `OPENAI_API_KEY`, Supabase keys).
3. Deploy. Vercel will build the client and serve it.

### Home screen icon not showing

The app icon on the home screen comes from the PWA manifest. For it to show correctly:

1. **Redeploy after the latest changes**  
   The project was updated so `/icons/` and `manifest.json` are no longer rewritten to the SPA; the real icon files are served. Redeploy so the new `vercel.json` and `client/public/icons/` are live.

2. **Use HTTPS**  
   Install and icons work only over HTTPS (Vercel provides this).

3. **Remove and re-add to home screen**  
   If you added to home screen before the fix, remove the shortcut and add again so the browser fetches the new manifest and icons.

Icon files used: `client/public/icons/icon-192.png` and `client/public/icons/icon-512.png`. They are committed so the build includes them.

## FX Advisor (KRW→USD)

FRED-only automated advisor for when to convert KRW to USD. Valuation-driven; broad USD and risk filters.

### Environment variables

- **FRED_API_KEY** – Required for sync. Get a free key at [FRED API](https://fred.stlouisfed.org/docs/api/api_key.html).
- **SUPABASE_URL** – Supabase project URL.
- **SUPABASE_SERVICE_ROLE_KEY** – Service role key (server-side only; never expose in the client).

### FRED series IDs (code uses these only; no DXY/KOSPI naming)

| Series ID           | Use in app                |
|---------------------|---------------------------|
| DEXKOUS             | usdkrw_spot               |
| DTWEXBGS            | usd_broad_index_proxy     |
| NASDAQ100           | nasdaq100                 |
| VIXCLS              | vix                       |
| DGS2                | us2y                      |
| NASDAQNQDXKR        | korea_equity_proxy        |
| IR3TIB01KRM156N     | kr_rate_proxy (monthly)   |

### How to run a backfill

Backfill loads ~500 observations per series from FRED and writes `fx_market_snapshots` and today’s `fx_advice_runs`.

- **From the UI:** Open **FX Advisor (KRW→USD)** and click **Run sync (FRED + advice)**.
- **From the API:** `POST /api/fx-sync` with optional body `{ "user_cash_krw": 1000000 }`.
- **From the command line:** Use curl: `curl -X POST http://localhost:3000/api/fx-sync -H "Content-Type: application/json" -d "{}"`.

### How to trigger a daily sync

- **Cron (e.g. Vercel):** Schedule a request to `POST https://your-domain.com/api/fx-sync` once per day (e.g. after US market close).
- **Manual:** Same as backfill (UI button or `POST /api/fx-sync`).

### API endpoints

- **GET /api/fx-advice/today** – Latest snapshot, latest advice, portfolio summary (from `fx_conversions`).
- **POST /api/fx-sync** – Fetch FRED, compute indicators, upsert snapshots, run advisor, upsert advice.
- **GET /api/fx-dashboard?days=365** – Chart-ready time series for the dashboard.

### Database

Run the Supabase migration `supabase/migrations/004_fx_advisor.sql` to create `fx_market_snapshots`, `fx_advice_runs`, `fx_conversions`, and `fx_manual_flags`. Use Supabase dashboard or `supabase db push` (if using Supabase CLI).

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