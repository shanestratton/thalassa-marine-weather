import { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
    appId: 'com.thalassa.weather',
    appName: 'Thalassa',
    webDir: 'dist',
    server: {
        androidScheme: 'https',
        // ── DEV (live reload from Mac's Vite dev server) ───────────
        // Uncomment to live-reload from the Mac. Comment back BEFORE
        // any TestFlight build and any time the dev server isn't
        // running (otherwise the WebView hits "Could not connect" and
        // the app is blank — see iOS error code -1004).
        // Caveat: Supabase auth + CapacitorHttp had issues talking
        // to the dev server in the past (likely cleartext / origin
        // mismatch) — re-test sign-in if anything breaks.
        // url: 'http://192.168.50.159:3000',
        // cleartext: true,
    },
    backgroundColor: '#020617', // slate-950 — one continuous shell dark
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
