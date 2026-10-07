import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The move-anchor fixture is available only through the development server.');

// Isolation BEFORE any application service loads: page-only storage, and no
// network at all. The watch itself is a fictional one off Marseille.
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
    new Response(JSON.stringify({ error: 'Move-anchor fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
// Large text: the root size the Shore Watch and draft fixtures use for the same check.
document.documentElement.style.fontSize = params.has('largeText') ? '24px' : '16px';

// A real browser shows no mobile keyboard under automation. Model the visual
// viewport (as e2e/fixtures/keyboard.tsx does) with the real app CSS and the
// real app-wide keyboard guard, and paint the keyboard so hit-tests see it.
const viewport = new EventTarget();
const keyboardCover = document.createElement('div');
keyboardCover.textContent = 'Keyboard (simulated)';
keyboardCover.setAttribute('data-testid', 'keyboard');
Object.assign(keyboardCover.style, {
    position: 'fixed',
    bottom: '0',
    left: '0',
    right: '0',
    height: '0',
    display: 'none',
    background: '#334155',
    color: '#cbd5e1',
    textAlign: 'center',
    paddingTop: '20px',
    zIndex: '2147483647',
});
document.body.append(keyboardCover);
Object.assign(viewport, { height: window.innerHeight, offsetTop: 0, scale: 1 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
window.addEventListener('test:keyboard', ((event: CustomEvent<number>) => {
    Object.assign(viewport, { height: window.innerHeight - event.detail });
    keyboardCover.style.height = `${event.detail}px`;
    keyboardCover.style.display = event.detail ? 'block' : 'none';
    viewport.dispatchEvent(new Event('resize'));
}) as EventListener);

const [{ initGlobalKeyboardScroll }, { MoveAnchorSheet }, { NmeaStore }, service, settingsModule] = await Promise.all([
    import('../../utils/keyboardScroll'),
    import('../../components/anchor-watch/MoveAnchorSheet'),
    import('../../services/NmeaStore'),
    import('../../services/AnchorWatchService'),
    import('../../stores/settingsStore'),
]);
initGlobalKeyboardScroll();

await settingsModule.awaitSettingsLoaded();
const settings = settingsModule.useSettingsStore.getState().settings;
settingsModule.useSettingsStore.setState({
    settings: { ...settings, units: { ...settings.units, length: params.get('units') === 'ft' ? 'ft' : 'm' } },
});

// The boat's true heading, 3 s old, so the bearing prefills as it would aboard,
// and the instruments keep sending it (the sheet stops using a heading more
// than 10 s old, and a slow browser run can take that long).
const heading = NmeaStore.getState().headingTrue;
heading.value = 212;
heading.lastUpdated = Date.now() - 3_000;
window.setInterval(() => {
    heading.lastUpdated = Date.now() - 3_000;
}, 1_000);

// The watch was armed at the boat, so the anchor sits under her: the late-set case.
const boat = { latitude: 43.295, longitude: 5.36 };
const config = { rodeLength: 40, waterDepth: 8, scopeRatio: 5, rodeType: 'chain' as const, safetyMargin: 10 };
const snapshot: AnchorWatchSnapshot = {
    state: 'watching',
    anchorPosition: { ...boat, timestamp: Date.now() - 600_000 },
    vesselPosition: { ...boat, accuracy: 4, heading: 212, speed: 0, timestamp: Date.now() },
    swingRadius: service.calculateSwingRadius(config),
    distanceFromAnchor: 0,
    maxDistanceRecorded: 3,
    bearingToAnchor: 0,
    config,
    positionHistory: [],
    alarmTriggeredAt: null,
    alarmCause: null,
    watchStartedAt: Date.now() - 600_000,
    gpsAccuracy: 4,
    gpsQuality: 'standard',
    gpsQualityLabel: 'Standard GPS',
    guardianStatus: 'idle',
    setupError: null,
};

// The watch is the service's to move; here it only records what it was asked.
const fixture = { moves: [] as Array<[number, number]> };
Object.assign(window, { __moveAnchorFixture: fixture });
service.AnchorWatchService.relocateAnchor = async (lat: number, lon: number) => {
    fixture.moves.push([lat, lon]);
    return { ok: true };
};

function Fixture() {
    const [open, setOpen] = useState(false);
    const [outcome, setOutcome] = useState('waiting');
    // The boat's GPS keeps reporting, as it does aboard: the sheet waits for a
    // fix no more than 30 s old.
    const [watch, setWatch] = useState(snapshot);
    useEffect(() => {
        const timer = window.setInterval(
            () => setWatch((s) => ({ ...s, vesselPosition: { ...s.vesselPosition!, timestamp: Date.now() } })),
            2_000,
        );
        return () => window.clearInterval(timer);
    }, []);
    return (
        <main className="h-dvh overflow-hidden bg-slate-950 p-4 text-white">
            <h1 className="ui-page-title">Anchor Deployed</h1>
            <button type="button" className="mt-4 min-h-11 rounded-xl bg-white/10 px-4" onClick={() => setOpen(true)}>
                Open Move anchor
            </button>
            <output data-testid="outcome" className="mt-4 block text-sm text-slate-300">
                {outcome}
            </output>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row
                above the home-indicator inset, opaque. */}
            <nav
                aria-label="Main"
                className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
            >
                <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                    <span>THE GLASS</span>
                    <span>OBS</span>
                    <span>PLAN</span>
                    <span className="text-sky-300">VESSEL</span>
                </div>
            </nav>
            {open && (
                <MoveAnchorSheet
                    snapshot={watch}
                    onClose={() => setOpen(false)}
                    onMoved={() => {
                        setOpen(false);
                        setOutcome('moved');
                    }}
                />
            )}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
