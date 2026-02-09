
import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.thalassa.weather',
  appName: 'Thalassa',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  },
  backgroundColor: '#0f172a', // Set app background to dark blue theme
  plugins: {
    StatusBar: {
      style: 'DARK',
      overlaysWebView: true,
    },
    Keyboard: {
      resize: 'none',        // Keyboard overlays — doesn't push content up
      resizeOnFullScreen: false,
    }
  },
  ios: {
    allowsLinkPreview: false,
    scrollEnabled: false,
  }
};

export default config;
