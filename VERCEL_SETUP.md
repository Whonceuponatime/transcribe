# Quick Vercel Deployment Guide

## Environment Variables to Add in Vercel

Go to your Vercel project → Settings → Environment Variables and add:

### Backend Variables
```
OPENAI_API_KEY=your_openai_api_key_here
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key_here
NODE_ENV=production
ALLOWED_ORIGINS=https://your-app.vercel.app
PORT=3000
```

### Frontend Variables (REACT_APP_ prefix)
```
REACT_APP_SUPABASE_URL=https://your-project.supabase.co
REACT_APP_SUPABASE_ANON_KEY=your_supabase_anon_key_here
```

## Supabase Setup

1. Create project at https://app.supabase.com
2. Go to Authentication → Users → "Add user"
3. Create your user account manually
4. Go to Authentication → Providers → Email
5. **Disable "Enable email signup"** (only manually added users can access)

## Build Settings in Vercel

- **Framework Preset:** Other
- **Build Command:** `npm run vercel-build`
- **Output Directory:** `client/build`
- **Install Command:** `npm install`

## After Deployment

1. Note your Vercel URL (e.g., `https://your-app.vercel.app`)
2. Update `ALLOWED_ORIGINS` env var with your actual Vercel URL
3. Redeploy to apply changes

## Login

Use the email/password you created in Supabase to log in.

