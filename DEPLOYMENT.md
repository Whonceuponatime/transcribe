# Deployment Guide: Vercel with Supabase Authentication

## Step 1: Set Up Supabase

1. **Create a Supabase project:**
   - Go to https://app.supabase.com
   - Click "New Project"
   - Fill in project details and wait for setup to complete

2. **Get your Supabase credentials:**
   - Go to Project Settings → API
   - Copy these values:
     - `Project URL` (this is your SUPABASE_URL)
     - `anon public` key (this is your SUPABASE_ANON_KEY)
     - `service_role` key (this is your SUPABASE_SERVICE_ROLE_KEY) - **Keep this secret!**

3. **Create a user in Supabase:**
   - Go to Authentication → Users
   - Click "Add user" → "Create new user"
   - Enter email and password for your account
   - This is the only way to add authorized users (manual whitelist)

4. **Disable public signups (recommended):**
   - Go to Authentication → Providers → Email
   - Disable "Enable email signup" to prevent unauthorized signups
   - Users can only be added manually by you

## Step 2: Deploy to Vercel

1. **Install Vercel CLI (optional):**
   ```bash
   npm install -g vercel
   ```

2. **Connect your repository to Vercel:**
   - Go to https://vercel.com
   - Click "Add New Project"
   - Import your Git repository (or use Vercel CLI: `vercel`)

3. **Configure build settings:**
   - **Framework Preset:** Other
   - **Build Command:** `npm run build`
   - **Output Directory:** `client/build`
   - **Install Command:** `npm install ; cd client ; npm install ; cd ..`

4. **Add Environment Variables in Vercel:**
   Go to Project Settings → Environment Variables and add these:

   **Backend Variables:**
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

   **Frontend Variables (add with REACT_APP_ prefix):**
   ```
   REACT_APP_SUPABASE_URL=https://your-project.supabase.co
   REACT_APP_SUPABASE_ANON_KEY=your_supabase_anon_key_here
   ```

5. **Deploy:**
   - Click "Deploy"
   - Wait for build to complete
   - Your app will be live at `https://your-app.vercel.app`

## Step 3: Update CORS After Deployment

1. **Get your Vercel URL** (e.g., `https://your-app.vercel.app`)

2. **Update environment variable:**
   - Go to Vercel project → Settings → Environment Variables
   - Update `ALLOWED_ORIGINS` to include your Vercel URL:
     ```
     ALLOWED_ORIGINS=https://your-app.vercel.app
     ```

3. **Redeploy:**
   - Go to Deployments → Click "..." on latest deployment → "Redeploy"

## Step 4: Add More Users (Optional)

To add more authorized users:
1. Go to your Supabase project → Authentication → Users
2. Click "Add user" → "Create new user"
3. Enter their email and password
4. They can now log in to your app

## Testing Authentication

1. **Visit your deployed app**
2. **You should see the login page**
3. **Enter the email and password you created in Supabase**
4. **You should be logged in and see all features**

## Troubleshooting

### "Unauthorized" errors:
- Check that environment variables are set correctly in Vercel
- Verify SUPABASE_URL and keys match your Supabase project
- Ensure the user exists in Supabase Authentication

### CORS errors:
- Update ALLOWED_ORIGINS to include your Vercel domain
- Redeploy after changing environment variables

### Build fails:
- Check build logs in Vercel
- Ensure all dependencies are installed
- Verify node version (should be 16+)

## Local Development

For local development with authentication:

1. **Create .env in root:**
   ```bash
   cp env.example.txt .env
   # Fill in your values
   ```

2. **Create client/.env.local:**
   ```
   REACT_APP_SUPABASE_URL=https://your-project.supabase.co
   REACT_APP_SUPABASE_ANON_KEY=your_supabase_anon_key_here
   ```

3. **Run the app:**
   ```bash
   # Terminal 1: Backend
   npm run dev

   # Terminal 2: Frontend
   npm run dev-client
   ```

## Security Notes

⚠️ **IMPORTANT:**
- Never commit `.env` files to Git
- Keep `SUPABASE_SERVICE_ROLE_KEY` secret (backend only)
- Only share `SUPABASE_ANON_KEY` with frontend
- Manually add users in Supabase (don't allow public signups)
- The service role key has admin privileges - keep it secure!

