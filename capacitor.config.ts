
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
    }
  }
};

export default config;
