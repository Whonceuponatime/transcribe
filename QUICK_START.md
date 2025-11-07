# 🚀 Quick Start: Supabase + Vercel Deployment

## ✅ What's Been Implemented

All features now require authentication. Only users you manually add to Supabase can access the app.

## 📋 To-Do List for Deployment

### 1. Create User in Supabase (5 minutes)

1. Go to https://app.supabase.com
2. Open your project: `npszmrzrpqwhsdzixtzh`
3. Go to **Authentication → Users**
4. Click **"Add user" → "Create new user"**
5. Enter your email and password
6. ✅ Done! This is your login

### 2. Disable Public Signups (Recommended)

1. In Supabase, go to **Authentication → Providers → Email**
2. Toggle OFF "Enable email signup"
3. ✅ Now only manually added users can access

### 3. Add Environment Variables in Vercel

Go to your Vercel project settings and add these:

```
OPENAI_API_KEY=(your OpenAI key)
ELEVENLABS_API_KEY=(your ElevenLabs key)
SUPABASE_URL=https://npszmrzrpqwhsdzixtzh.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wc3ptcnpycHF3aHNkeml4dHpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4NzA0NDYsImV4cCI6MjA3NzQ0NjQ0Nn0.Cyd9CS7JzpP2fKdN8BpBuVkcK3CosdJA0B2SreOw3Fo
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wc3ptcnpycHF3aHNkeml4dHpoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MTg3MDQ0NiwiZXhwIjoyMDc3NDQ2NDQ2fQ.qYx2sumDbMqIPn9NVdjastN8SZQ2fMVAFviE4htSWd0
NODE_ENV=production
ALLOWED_ORIGINS=https://samsjack.vercel.app
PORT=3000
REACT_APP_SUPABASE_URL=https://npszmrzrpqwhsdzixtzh.supabase.co
REACT_APP_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wc3ptcnpycHF3aHNkeml4dHpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4NzA0NDYsImV4cCI6MjA3NzQ0NjQ0Nn0.Cyd9CS7JzpP2fKdN8BpBuVkcK3CosdJA0B2SreOw3Fo
```

**Important:** Select "All Environments" for each variable!

### 4. Deploy

- Push your code to Git
- Vercel will auto-deploy
- Or use: `vercel --prod`

### 5. Login

- Visit: https://samsjack.vercel.app
- Login with the email/password you created in Supabase
- ✅ You're in!

## 🔐 Adding More Users

To add another user:
1. Supabase → Authentication → Users → "Add user"
2. Enter their email and password
3. They can now login

## 🛠️ Local Development

Create `client/.env.local`:
```
REACT_APP_SUPABASE_URL=https://npszmrzrpqwhsdzixtzh.supabase.co
REACT_APP_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wc3ptcnpycHF3aHNkeml4dHpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4NzA0NDYsImV4cCI6MjA3NzQ0NjQ0Nn0.Cyd9CS7JzpP2fKdN8BpBuVkcK3CosdJA0B2SreOw3Fo
```

Update your root `.env` with the Supabase values from `env.example.txt`

## ❓ Troubleshooting

**Can't login?**
- Make sure you created the user in Supabase
- Check email/password spelling
- Verify env vars are set in Vercel

**"Unauthorized" errors?**
- Redeploy after adding env vars
- Check that all REACT_APP_ variables are set

**CORS errors?**
- Update ALLOWED_ORIGINS with your actual Vercel URL
- Redeploy

