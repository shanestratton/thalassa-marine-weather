import React, { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import { RoutingModeDialog } from '../../components/autorouting/RoutingModeDialog';
import { SlideToAction } from '../../components/ui/SlideToAction';
import { PanePortalScope } from '../../context/PanePortalContext';
import { NIGHT_SCRIM_Z_INDEX } from '../../components/ui/OverlayPortal';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { supabase } from '../../services/supabase';
import { LocationStore } from '../../stores/LocationStore';
import { awaitSettingsLoaded, useSettingsStore } from '../../stores/settingsStore';
import { initGlobalKeyboardScroll } from '../../utils/keyboardScroll';
import type { AutoroutingTrialRequest } from '../../types/autorouting';
import '../../index.css';

const params = new URLSearchParams(location.search);
const pane = params.get('pane') === 'true';
const mode = params.get('mode') || 'dark';
document.documentElement.classList.toggle('display-light', mode === 'light');
setAuthIdentityScope('trial-layout-fixture');
// Existing planning context is fixture data, never persisted. The choice
// dialog must snapshot it itself rather than receiving test-only props.
LocationStore.setState({ lat: -26.68, lon: 153.16, source: 'search', name: 'Fixture coast' });
const settingsReady = awaitSettingsLoaded().then(() =>
    useSettingsStore.setState({
        settings: {
            ...useSettingsStore.getState().settings,
            vessel: {
                name: 'Fixture vessel',
                type: 'sail',
                length: 35,
                beam: 11,
                draft: 1.5 / 0.3048,
                displacement: 12000,
                maxWaveHeight: 2,
                cruisingSpeed: 6,
            },
        },
    }),
);
const control = {
    statuses: 0,
    calculations: 0,
    manualSelections: 0,
    mapsCreated: 0,
    mapsRemoved: 0,
    map: null as mapboxgl.Map | null,
};
Object.assign(window, { __trialFixture: control });
const OriginalMap = mapboxgl.Map;
Object.assign(mapboxgl, {
    Map: class extends OriginalMap {
        constructor(options: mapboxgl.MapboxOptions) {
            super(options);
            control.mapsCreated += 1;
            control.map = this;
        }
        remove() {
            control.mapsRemoved += 1;
            control.map = null;
            return super.remove();
        }
    },
});

// Playwright replaces only the Supabase client module with an empty local
// client. The real trial service still snapshots, authorizes and validates.
// All account and provider operations below are in-memory, with no live I/O.
Object.assign(supabase!.auth, {
    getSession: async () => ({
        data: { session: { user: { id: 'trial-layout-fixture' }, access_token: 'fixture-only-not-a-token' } },
        error: null,
    }),
});
Object.assign(supabase!.functions, {
    invoke: async (_name: string, { body }: { body: AutoroutingTrialRequest & { action: string } }) => {
        if (body.action === 'status') {
            control.statuses += 1;
            if (params.get('status') === 'failed') return { data: null, error: new Error('Fixture unavailable') };
            return {
                data: {
                    enabled: params.get('status') !== 'disabled',
                    ready: params.get('status') !== 'unready',
                    message: params.get('status') === 'unready' ? 'Fixture provider setup is pending.' : undefined,
                },
                error: null,
            };
        }
        control.calculations += 1;
        const { departure, destination } = body;
        return {
            data: {
                id: 'layout-proposal',
                provider: 'SevenCs',
                createdAt: '2026-09-12T00:00:00Z',
                coordinates: [
                    [departure.lon, departure.lat],
                    [(departure.lon + destination.lon) / 2 + 0.005, (departure.lat + destination.lat) / 2],
                    [destination.lon, destination.lat],
                ],
                warnings: Array.from(
                    { length: 4 },
                    (_, index) =>
                        `Fixture warning ${index + 1}: Independently inspect current official charts, notices, tides and all vessel clearances. This lengthy advisory must remain readable in the small pane without covering the chart or Close.`,
                ),
            },
            error: null,
        };
    },
});

// Same visual-viewport keyboard model used by the existing keyboard suite.
const viewport = new EventTarget();
Object.assign(viewport, { height: innerHeight, offsetTop: 0, scale: 1 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
window.addEventListener('test:keyboard', ((event: CustomEvent<number>) => {
    Object.assign(viewport, { height: innerHeight - event.detail });
    viewport.dispatchEvent(new Event('resize'));
}) as EventListener);
initGlobalKeyboardScroll();

function Fixture() {
    const frame = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [manual, setManual] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const selectManual = useCallback(() => {
        control.manualSelections += 1;
        setOpen(false);
        setManual(true);
    }, []);
    const [companionClicks, setCompanionClicks] = useState(0);
    return (
        <main className="flex h-dvh w-full flex-col overflow-hidden bg-slate-950 text-white">
            <header className="h-16 shrink-0 px-4 py-4 font-bold">THALASSA · Layout fixture</header>
            <div className={`flex min-h-0 flex-1 ${pane ? 'gap-2 p-2 pb-16' : ''}`}>
                {pane && (
                    <aside className="min-w-0 flex-1 rounded-xl bg-slate-900 p-4" aria-label="Companion pane">
                        <button className="min-h-11" onClick={() => setCompanionClicks((count) => count + 1)}>
                            Companion action {companionClicks}
                        </button>
                    </aside>
                )}
                {/* Match App: scope wraps the frame, whose ref is therefore
                    attached before the scope's layout measurement runs. */}
                <PanePortalScope enabled={pane} paneId="planning" frameRef={frame}>
                    <section
                        ref={frame}
                        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
                        data-testid="trial-pane"
                        data-split-pane={pane ? 'planning' : undefined}
                    >
                        {manual ? (
                            <div className="p-4">
                                <h1>Manual routing selected</h1>
                                <button className="min-h-11" onClick={() => setManual(false)}>
                                    Return to planning
                                </button>
                            </div>
                        ) : (
                            <div className="p-4">
                                <SlideToAction
                                    label="Slide to Start Plotting"
                                    thumbIcon={<span aria-hidden="true">↗</span>}
                                    onConfirm={() => setOpen(true)}
                                />
                            </div>
                        )}
                        {open && <RoutingModeDialog mapboxToken="pk.fixture" onClose={close} onManual={selectManual} />}
                    </section>
                </PanePortalScope>
            </div>
            {mode === 'night' && (
                <div
                    className="pointer-events-none fixed inset-0"
                    style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: NIGHT_SCRIM_Z_INDEX }}
                />
            )}
        </main>
    );
}
void settingsReady.then(() => createRoot(document.getElementById('root')!).render(<Fixture />));
