# 🚀 Deployment Guide for Nuxthub

This guide will help you deploy your Video Transcription & Text-to-Speech app to Nuxthub.

## 📋 Prerequisites

1. **Nuxthub Account**: Sign up at https://nuxthub.com
2. **Git Repository**: Your code should be in a Git repository (GitHub, GitLab, etc.)
3. **Environment Variables**: Prepare your API keys

## 🔧 Environment Variables Setup

### Required Environment Variables

Create these environment variables in your Nuxthub dashboard:

```env
# OpenAI API (Required)
OPENAI_API_KEY=your_openai_api_key_here

# ElevenLabs API (Optional - for additional TTS voices)
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here

# Supabase (Optional - for authentication)
SUPABASE_URL=your_supabase_url_here
SUPABASE_ANON_KEY=your_supabase_anon_key_here

# App Configuration
NODE_ENV=production
PORT=5000
```

### How to Get API Keys

1. **OpenAI API Key**:
   - Go to https://platform.openai.com/api-keys
   - Create a new API key
   - Copy the key (starts with `sk-`)

2. **ElevenLabs API Key** (Optional):
   - Go to https://elevenlabs.io/
   - Sign up and get your API key
   - Copy the key

3. **Supabase Credentials** (Optional):
   - Go to https://supabase.com
   - Create a project
   - Go to Settings → API
   - Copy Project URL and anon key

## 🚀 Deployment Steps

### Step 1: Prepare Your Repository

1. **Push your code to Git**:
   ```bash
   git add .
   git commit -m "feat: prepare for deployment"
   git push origin main
   ```

2. **Verify these files are in your repository**:
   - `Dockerfile`
   - `nuxthub.json`
   - `package.json`
   - `server.js`
   - `client/` folder

### Step 2: Deploy to Nuxthub

1. **Login to Nuxthub Dashboard**
   - Go to https://nuxthub.com
   - Sign in to your account

2. **Create New Project**
   - Click "New Project"
   - Select "Deploy from Git"
   - Connect your Git repository

3. **Configure Deployment**
   - **Repository**: Select your repository
   - **Branch**: `main` (or your default branch)
   - **Build Command**: Leave empty (uses Dockerfile)
   - **Start Command**: Leave empty (uses Dockerfile)

4. **Set Environment Variables**
   - Go to your project settings
   - Add all the environment variables listed above
   - Make sure to add your actual API keys

5. **Deploy**
   - Click "Deploy"
   - Wait for the build to complete (5-10 minutes)

## 🔍 Troubleshooting

### Common Issues

1. **Build Fails**
   - Check that all files are committed to Git
   - Verify `Dockerfile` is in the root directory
   - Check build logs for specific errors

2. **App Won't Start**
   - Verify environment variables are set correctly
   - Check that API keys are valid
   - Review application logs

3. **FFmpeg Not Found**
   - The Dockerfile includes FFmpeg installation
   - If issues persist, check the build logs

4. **Authentication Issues**
   - If Supabase is not configured, authentication will be skipped
   - Users can still use the app without authentication

### Environment Variables Checklist

- [ ] `OPENAI_API_KEY` - Required for transcription and TTS
- [ ] `ELEVENLABS_API_KEY` - Optional for additional TTS voices
- [ ] `SUPABASE_URL` - Optional for authentication
- [ ] `SUPABASE_ANON_KEY` - Optional for authentication
- [ ] `NODE_ENV=production`
- [ ] `PORT=5000`

## 🌐 Access Your App

After successful deployment:

1. **Get Your App URL**: Nuxthub will provide a URL like `https://your-app-name.nuxthub.app`

2. **Test the Features**:
   - Video transcription
   - Text-to-speech conversion
   - File uploads
   - Audio playback

## 📊 Monitoring

- **Logs**: View application logs in the Nuxthub dashboard
- **Metrics**: Monitor CPU, memory, and network usage
- **Errors**: Check for any deployment or runtime errors

## 🔄 Updates

To update your app:

1. **Make changes to your code**
2. **Commit and push to Git**:
   ```bash
   git add .
   git commit -m "feat: update app"
   git push origin main
   ```
3. **Redeploy**: Nuxthub will automatically detect changes and redeploy

## 💡 Tips

1. **Start Simple**: Deploy without Supabase first, add authentication later
2. **Test Locally**: Make sure everything works locally before deploying
3. **Monitor Usage**: Keep an eye on API usage to avoid rate limits
4. **Backup**: Keep your API keys and configuration backed up

## 🆘 Support

If you encounter issues:

1. Check the Nuxthub documentation
2. Review the application logs
3. Verify all environment variables are set
4. Test the app locally first

Your app should now be successfully deployed on Nuxthub! 🎉 