# 🎬 Video Transcription App

A modern web application that allows you to upload videos and transcribe the audio to text using the Web Speech API. Built with React, Node.js, and Express.

## ✨ Features

- **Video Upload**: Drag and drop or click to upload video files
- **Real-time Transcription**: Use your microphone to transcribe audio from videos
- **Video Player**: Custom video player with controls and progress tracking
- **Transcription History**: Save and view previous transcriptions
- **Export Options**: Copy to clipboard or download as text file
- **Responsive Design**: Works on desktop and mobile devices
- **Modern UI**: Beautiful gradient design with glassmorphism effects

## 🚀 Quick Start

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Chrome or Edge browser (for Web Speech API support)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd transcribe
   ```

2. **Install dependencies**
   ```bash
   # Install backend dependencies
   npm install
   
   # Install frontend dependencies
   cd client
   npm install
   cd ..
   ```

3. **Start the development server**
   ```bash
   # Start backend server (from root directory)
   npm run dev
   
   # In a new terminal, start frontend (from root directory)
   cd client
   npm start
   ```

4. **Open your browser**
   - Backend: http://localhost:5000
   - Frontend: http://localhost:3000

## 📖 How to Use

1. **Upload a Video**
   - Drag and drop a video file onto the upload area
   - Or click to browse and select a video file
   - Supported formats: MP4, AVI, MOV, MKV, WMV, FLV, WebM
   - Maximum file size: 100MB

2. **Start Transcription**
   - Click the "Start" button in the transcription panel
   - Allow microphone access when prompted
   - The app will begin listening to your microphone

3. **Play the Video**
   - Use the video player controls to play your video
   - The transcription will capture audio from your speakers/microphone
   - You can pause, seek, and control volume as needed

4. **Manage Transcriptions**
   - View real-time transcription in the text area
   - Click "Stop" to end transcription
   - Use "Clear" to reset the current transcription
   - Copy to clipboard or download as text file

5. **View History**
   - Previous transcriptions are saved with timestamps
   - Each entry shows the video time when transcription was captured

## 🛠️ Technical Details

### Backend (Node.js + Express)
- **File Upload**: Multer for handling video file uploads
- **WebSocket**: Socket.IO for real-time communication
- **CORS**: Enabled for cross-origin requests
- **File Storage**: Local file system storage

### Frontend (React)
- **Web Speech API**: Real-time speech recognition
- **Video Player**: Custom HTML5 video player
- **Drag & Drop**: File upload with visual feedback
- **Responsive Design**: Mobile-first approach

### Browser Compatibility
- **Chrome**: Full support (recommended)
- **Edge**: Full support
- **Firefox**: Limited support (no Web Speech API)
- **Safari**: Limited support (no Web Speech API)

## 🔧 Configuration

### Environment Variables
Create a `.env` file in the root directory:

```env
PORT=5000
NODE_ENV=development
```

### File Upload Limits
Modify `server.js` to change upload limits:
```javascript
limits: {
  fileSize: 100 * 1024 * 1024 // 100MB limit
}
```

## 📁 Project Structure

```
transcribe/
├── client/                 # React frontend
│   ├── public/
│   │   └── index.html
│   ├── src/
│   │   ├── components/
│   │   │   ├── VideoUpload.js
│   │   │   ├── VideoPlayer.js
│   │   │   └── TranscriptionPanel.js
│   │   ├── App.js
│   │   ├── App.css
│   │   └── index.js
│   └── package.json
├── uploads/               # Video file storage
├── server.js             # Express backend
├── package.json
└── README.md
```

## 🚀 Deployment

### Heroku
1. Create a Heroku app
2. Set buildpacks for Node.js
3. Deploy using Heroku CLI or GitHub integration

### Vercel
1. Connect your GitHub repository
2. Set build command: `npm run build`
3. Set output directory: `client/build`

### Docker
```dockerfile
FROM node:16-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN cd client && npm install && npm run build
EXPOSE 5000
CMD ["npm", "start"]
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📝 License

This project is licensed under the MIT License.

## 🐛 Troubleshooting

### Common Issues

1. **Speech recognition not working**
   - Ensure you're using Chrome or Edge
   - Check microphone permissions
   - Try refreshing the page

2. **Video not playing**
   - Check file format compatibility
   - Ensure file size is under 100MB
   - Try a different video file

3. **Upload fails**
   - Check file size limit
   - Ensure file is a valid video format
   - Check server logs for errors

### Browser Support
- **Chrome**: ✅ Full support
- **Edge**: ✅ Full support  
- **Firefox**: ❌ No Web Speech API
- **Safari**: ❌ No Web Speech API

## 📞 Support

If you encounter any issues or have questions, please:
1. Check the troubleshooting section
2. Search existing issues
3. Create a new issue with detailed information

---

**Note**: This app uses the Web Speech API which requires HTTPS in production and is only supported in Chrome and Edge browsers. 