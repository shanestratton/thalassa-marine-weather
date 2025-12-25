
<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Thalassa Marine Weather - App Store Ready

This is a premium marine weather application built with React, Vite, and Capacitor for iOS deployment.

## 🚀 How to Build for the App Store (No Vercel Needed)

You do **not** need Vercel or any web host to deploy this app to the App Store. The entire application is bundled into the native iOS app.

### 1. Prerequisites
- A Mac computer (required for Xcode).
- Xcode installed (from the Mac App Store).
- An Apple Developer Account (for TestFlight/App Store submission).

### 2. Setup Local Environment
1. Clone this repository to your Mac.
2. Install dependencies:
   ```bash
   npm install
   ```
3. **Important:** Create a `.env` file in the root directory. Since you are not using Vercel, you must provide your API keys here so they are embedded into the app.
   ```env
   VITE_GEMINI_API_KEY=your_gemini_key
   VITE_STORMGLASS_API_KEY=your_stormglass_key
   VITE_MAPBOX_ACCESS_TOKEN=your_mapbox_key
   ```

### 3. Build & Sync
1. Compile the React app into static files:
   ```bash
   npm run build
   ```
2. Create the iOS native project (first time only):
   ```bash
   npx cap add ios
   ```
3. Sync your web code to the native project:
   ```bash
   npm run cap:sync
   ```

### 4. Deploy to Device / App Store
1. Open the project in Xcode:
   ```bash
   npm run cap:ios
   ```
2. inside Xcode:
   - Connect your iPhone via USB.
   - Select your team in the project settings.
   - Press **Play (Cmd+R)** to install on your phone.
   - Or go to **Product > Archive** to upload to App Store Connect.

## 🌐 Web Version (Optional)
If you *also* want a website version, you can deploy to Vercel/Netlify.
1. `npm run dev` to run locally.
2. Push to GitHub and connect to Vercel.
3. Add your Environment Variables in the Vercel Dashboard.
