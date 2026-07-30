/** @type {import('tailwindcss').Config} */
export default {
    content: [
        './index.html',
        './src/**/*.{js,ts,jsx,tsx}',
        './components/**/*.{js,ts,jsx,tsx}',
        // pages/ was missing until 2026-06-13: any class used ONLY in a
        // pages/ file was purged from production CSS and silently no-op'd
        // on device while looking fine wherever components/ shared it.
        './pages/**/*.{js,ts,jsx,tsx}',
        './hooks/**/*.{js,ts,jsx,tsx}',
        './context/**/*.{js,ts,jsx,tsx}',
        './services/**/*.{js,ts,jsx,tsx}',
        // utils/ emits class names too (createMarkerEl map markers,
        // useDeviceClass tier classes).
        './utils/**/*.{js,ts,jsx,tsx}',
        // modules/ holds the LEGAL GATE (DisclaimerOverlay) — the first screen
        // every user sees and the only thing Lighthouse ever audits. Missing
        // here until 2026-07-30, so any class it did not share with a globbed
        // file was purged from production CSS. Exactly the pages/ bug above,
        // on the one screen nobody can skip.
        './modules/**/*.{js,ts,jsx,tsx}',
        // contexts/ (plural) exists alongside context/ (singular) and was
        // likewise uncovered.
        './contexts/**/*.{js,ts,jsx,tsx}',
        './*.{js,ts,jsx,tsx}',
    ],
    theme: {
        extend: {},
    },
    plugins: [],
};
