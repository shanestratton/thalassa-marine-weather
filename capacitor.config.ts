import { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
    appId: 'com.thalassa.weather',
    appName: 'Thalassa',
    webDir: 'dist',
    server: {
        androidScheme: 'https',
        // ── DEV (commented out) ────────────────────────────────────
        // To re-enable live reload from the Mac's Vite dev server,
        // uncomment and adjust the IP if needed. Caveat: Supabase
        // auth + CapacitorHttp had issues talking to the dev server
        // (likely cleartext / origin mismatch). Production-bundle
        // mode below is the default.
        // url: 'http://192.168.50.159:5173',
        // cleartext: true,
    },
    backgroundColor: '#0f172a', // Set app background to dark blue theme
    plugins: {
        CapacitorHttp: {
            enabled: true, // Patch fetch/XHR to use native HTTP — bypasses CORS
        },
        StatusBar: {
            style: 'DARK',
            overlaysWebView: true,
        },
        Keyboard: {
            resize: KeyboardResize.None, // Keyboard overlays — doesn't push content up
            resizeOnFullScreen: false,
        },
    },
    ios: {
        allowsLinkPreview: false,
        scrollEnabled: false,
    },
};

export default config;
