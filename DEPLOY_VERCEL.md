# 🚀 Deploy to Vercel

## 🎯 **Vercel Deployment Guide**

### **Step 1: Prepare Your Repository**

1. **Make sure your code is pushed to Git**:
   ```bash
   git add .
   git commit -m "feat: prepare for Vercel deployment"
   git push origin main
   ```

2. **Verify these files are in your repository**:
   - `vercel.json` ✅
   - `.vercelignore` ✅
   - `package.json` ✅
   - `server.js` ✅
   - `client/` folder ✅

### **Step 2: Deploy via Vercel CLI**

1. **Install Vercel CLI** (if not already installed):
   ```bash
   npm install -g vercel
   ```

2. **Login to Vercel**:
   ```bash
   vercel login
   ```

3. **Deploy to production**:
   ```bash
   vercel --prod
   ```

### **Step 3: Configure Environment Variables**

In your Vercel dashboard → Settings → Environment Variables, add:

```env
OPENAI_API_KEY=your_openai_api_key_here
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here (optional)
NODE_ENV=production
```

### **Step 4: Deploy via Vercel Dashboard**

**Alternative method** (if CLI doesn't work):

1. Go to https://vercel.com
2. Sign up/Login with GitHub
3. Click "New Project"
4. Import your repository
5. Configure:
   - **Framework Preset**: `Node.js`
   - **Root Directory**: `./` (leave default)
   - **Build Command**: `npm run build`
   - **Output Directory**: `client/build`
6. Set environment variables
7. Click "Deploy"

## 🔧 **Troubleshooting**

### **File Size Issues**
If you get "File size limit exceeded":
1. Make sure `.vercelignore` is properly configured
2. Remove large files from your repository
3. Try deploying again

### **Build Errors**
If build fails:
1. Check that all dependencies are in `package.json`
2. Verify `client/package.json` exists
3. Check build logs in Vercel dashboard

### **Environment Variables**
If API calls fail:
1. Verify environment variables are set correctly
2. Check that API keys are valid
3. Restart deployment after adding variables

## 🎉 **Your App Will Be Live!**

After successful deployment, you'll get a URL like:
`https://your-app-name.vercel.app`

## 📊 **Vercel Benefits**

- ✅ **Free tier available**
- ✅ **Automatic deployments**
- ✅ **Built-in CDN**
- ✅ **Great performance**
- ✅ **Easy custom domains**

Your React + Express app will be live in minutes! 🚀 