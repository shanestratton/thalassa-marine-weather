
/// <reference types="vitest" />
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

// Define __dirname for ESM context
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  // 1. Load env vars from local .env files
  const env = loadEnv(mode, __dirname, '');

  // 2. Helper to resolve keys from either local .env or system env (Vercel Build Context)
  // Vercel exposes environment variables in process.env during build.
  const getKey = (key: string) => {
    const val = env[key] || process.env[key];
    if (val) return val;
    return '';
  };



  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react()],
    define: {
      // Polyfill process.env for browser compatibility
      // We set it to an empty object, but specific keys below will be replaced by string literals
      'process.env': {},

      // --- API KEY INJECTION ---
      // We inject these keys directly into the build so the client can use them.
      // This is required for Vercel static deployments where there is no runtime Node server.

      // 1. Gemini / Google GenAI
      'process.env.API_KEY': JSON.stringify(getKey('VITE_GEMINI_API_KEY') || getKey('GEMINI_API_KEY') || getKey('API_KEY') || ''),
      'process.env.GEMINI_API_KEY': JSON.stringify(getKey('VITE_GEMINI_API_KEY') || getKey('GEMINI_API_KEY') || getKey('API_KEY') || ''),

      // 2. Stormglass Marine Data
      'process.env.STORMGLASS_API_KEY': JSON.stringify(
        getKey('VITE_STORMGLASS_API_KEY') ||
        getKey('STORMGLASS_API_KEY') ||
        getKey('VITE_STORMGLASS_KEY') ||
        getKey('STORMGLASS_KEY') ||
        ''
      ),

      // 3. Open-Meteo (Optional Commercial Key)
      'process.env.OPEN_METEO_API_KEY': JSON.stringify(getKey('VITE_OPEN_METEO_API_KEY') || getKey('OPEN_METEO_API_KEY') || ''),

      // 4. Mapbox / Maps
      'process.env.MAPBOX_ACCESS_TOKEN': JSON.stringify(getKey('VITE_MAPBOX_ACCESS_TOKEN') || getKey('MAPBOX_ACCESS_TOKEN') || ''),

      // 5. Supabase (Backend/Auth)
      'process.env.SUPABASE_URL': JSON.stringify(getKey('VITE_SUPABASE_URL') || getKey('SUPABASE_URL') || ''),
      'process.env.SUPABASE_KEY': JSON.stringify(getKey('VITE_SUPABASE_ANON_KEY') || getKey('VITE_SUPABASE_KEY') || getKey('SUPABASE_KEY') || ''),
    },
    // Strip console.*/debugger from production builds
    esbuild: mode === 'production' ? {
      drop: ['console', 'debugger'],
    } : undefined,
    build: {
      outDir: 'dist',
      sourcemap: mode !== 'production',
      cssMinify: true,
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom'],
            'vendor-charts': ['uplot'],
            'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
            'vendor-leaflet': ['leaflet'],
            'vendor-pdf': ['html2canvas', 'jspdf'],
            'vendor-supabase': ['@supabase/supabase-js'],
          }
        }
      }
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './'),
      }
    },
    test: {
      environment: 'jsdom',
      exclude: ['**/node_modules/**', '**/e2e/**'],
      globals: true
    }
  };
});
