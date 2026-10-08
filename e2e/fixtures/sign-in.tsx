import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The sign-in fixture is available only through the development server.');

// Isolation BEFORE any application service loads: page-only storage and no
// network, so the auth store starts signed out and nothing leaves the page.
class FixtureStorage implements Storage {
    private entries = new Map<string, string>();
    get length() {
        return this.entries.size;
    }
    clear() {
        this.entries.clear();
    }
    getItem(key: string) {
        return this.entries.get(String(key)) ?? null;
    }
    key(index: number) {
        return [...this.entries.keys()][index] ?? null;
    }
    removeItem(key: string) {
        this.entries.delete(String(key));
    }
    setItem(key: string, value: string) {
        this.entries.set(String(key), String(value));
    }
}
Object.defineProperty(window, 'localStorage', { configurable: true, value: new FixtureStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new FixtureStorage() });
window.fetch = async () =>
    new Response(JSON.stringify({ error: 'Sign-in fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
// Large text: the root size the stand-in and Shore Watch fixtures use.
document.documentElement.style.fontSize = params.has('largeText') ? '24px' : '16px';

// The longest real caller prompt (Anchor Watch's shore sharing), unless asked otherwise.
const PROMPTS: Record<string, string | undefined> = {
    long: 'Sign in to share Anchor Watch between your vessel and shore devices. Local Anchor Watch remains available without an account.',
    short: 'Sign in to share your boat’s position from this phone.',
    none: undefined,
};
const prompt = PROMPTS[params.get('prompt') ?? 'long'];

// The banner a failed Sign in with Apple leaves on the sheet, through the same
// app-wide attempt state the sheet's own Apple handler publishes to. The
// longest real message by default (register-apple-token's 409 race).
const FAILURES: Record<string, string | null> = {
    race: 'Another Apple sign-in for this account finished at the same moment. Try again.',
    offline: "Apple Sign-In couldn't reach Thalassa. Check your connection and try again.",
    apple1000: "Apple Sign-In didn't complete (Apple error 1000). Try again.",
    none: null,
};
const failure = FAILURES[params.get('failure') ?? 'race'] ?? null;

const [{ SignInScreen }, attempt] = await Promise.all([
    import('../../components/SignInScreen'),
    import('../../services/auth/appleSignInAttempt'),
]);
if (failure) {
    attempt.beginAppleSignInAttempt();
    attempt.endAppleSignInAttempt(failure);
}

function Fixture() {
    const [open, setOpen] = useState(true);
    return (
        <main className="h-dvh overflow-hidden bg-slate-950 p-4 text-white">
            <h1 className="ui-page-title">Vessel</h1>
            <button type="button" className="mt-4 min-h-11 rounded-xl bg-white/10 px-4" onClick={() => setOpen(true)}>
                Open sign-in
            </button>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row
                above the home-indicator inset, opaque. The sheet must cover it. */}
            <nav
                aria-label="Main"
                className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
            >
                <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                    <span>THE GLASS</span>
                    <span>OBS</span>
                    <span>LOG</span>
                    <span className="text-sky-300">VESSEL</span>
                </div>
            </nav>
            <SignInScreen isOpen={open} onClose={() => setOpen(false)} prompt={prompt} />
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
