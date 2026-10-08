import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { VesselProfile } from '../../types/vessel';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The draft-confirm fixture is available only through the development server.');

// Isolation BEFORE any application service loads: page-only storage, and no
// network at all (signed out, so a save stays on this page's settings).
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
    new Response(JSON.stringify({ error: 'Draft-confirm fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
// Large text: the root size the Shore Watch fixture uses for the same check.
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

const [{ initGlobalKeyboardScroll }, { DraftConfirmModal }, { requireConfirmedDraft }, settingsModule] =
    await Promise.all([
        import('../../utils/keyboardScroll'),
        import('../../components/vessel/DraftConfirmModal'),
        import('../../stores/draftConfirmStore'),
        import('../../stores/settingsStore'),
    ]);
initGlobalKeyboardScroll();

const draftParam = params.get('draft');
const vessel: VesselProfile | undefined =
    draftParam === 'unset'
        ? undefined
        : {
              name: 'Fixture yacht',
              type: 'sail',
              length: 40,
              beam: 13,
              draft: 7.87,
              displacement: 20000,
              maxWaveHeight: 10,
              cruisingSpeed: 6,
              ...(draftParam === 'estimated' ? { estimatedFields: ['draft'] } : {}),
          };
await settingsModule.awaitSettingsLoaded();
const settings = settingsModule.useSettingsStore.getState().settings;
settingsModule.useSettingsStore.setState({
    settings: {
        ...settings,
        vessel,
        vesselUnits: undefined,
        units: { ...settings.units, length: params.get('units') === 'ft' ? 'ft' : 'm' },
    },
});

const fixture = { outcome: 'waiting' as 'waiting' | 'ran' | 'did not run' };
Object.assign(window, { __draftFixture: fixture });

function Fixture() {
    const [outcome, setOutcome] = useState(fixture.outcome);
    const ask = async () => {
        const confirmed = await requireConfirmedDraft('autorouting-trial');
        fixture.outcome = confirmed ? 'ran' : 'did not run';
        setOutcome(fixture.outcome);
    };
    return (
        <main className="h-dvh overflow-hidden bg-slate-950 p-4 text-white">
            <h1 className="ui-page-title">Plan</h1>
            {/* A draft-dependent way in (RoutingModeDialog's Auto routing).
                Plan Your Day was this fixture's button until build 124: it
                reads no depth now, so it no longer asks. */}
            <button type="button" className="mt-4 min-h-11 rounded-xl bg-white/10 px-4" onClick={() => void ask()}>
                Auto routing
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
                    <span className="text-sky-300">PLAN</span>
                    <span>VESSEL</span>
                </div>
            </nav>
            <DraftConfirmModal />
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
