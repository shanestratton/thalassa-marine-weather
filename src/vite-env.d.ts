declare module '*.css';
declare module '*.png';
declare module '*.svg';
declare module '*.jpeg';
declare module '*.jpg';

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY: string
  readonly VITE_STORMGLASS_API_KEY: string
  readonly VITE_OPEN_METEO_API_KEY: string
  readonly VITE_MAPBOX_ACCESS_TOKEN: string
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_KEY: string
  // Standard Vite Environment Variables
  readonly BASE_URL: string
  readonly MODE: string
  readonly DEV: boolean
  readonly PROD: boolean
  readonly SSR: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Augment the global NodeJS namespace to type process.env correctly.
declare namespace NodeJS {
  interface ProcessEnv {
    API_KEY: string;
    GEMINI_API_KEY: string;
    STORMGLASS_API_KEY: string;
    OPEN_METEO_API_KEY: string;
    MAPBOX_ACCESS_TOKEN: string;
    SUPABASE_URL: string;
    SUPABASE_KEY: string;
    [key: string]: string | undefined;
  }
}