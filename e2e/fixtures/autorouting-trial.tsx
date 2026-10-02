import React, { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import { RoutingModeDialog } from '../../components/autorouting/RoutingModeDialog';
import {
    AutoroutingProviderContext,
    thalassaAutoroutingProvider,
    type AutoroutingProvider,
} from '../../components/autorouting/AutoroutingProviderContext';
import { SlideToAction } from '../../components/ui/SlideToAction';
import { PanePortalScope } from '../../context/PanePortalContext';
import { NIGHT_SCRIM_Z_INDEX } from '../../components/ui/OverlayPortal';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { LocationStore } from '../../stores/LocationStore';
import { awaitSettingsLoaded, useSettingsStore } from '../../stores/settingsStore';
import { initGlobalKeyboardScroll } from '../../utils/keyboardScroll';
import type { AutoroutingTrialRequest, AutoroutingTrialRoute } from '../../types/autorouting';
import type { TrialRouteReview } from '../../services/autoroutingReview';
import { importCell } from '../../services/enc/EncHazardService';
import '../../index.css';

const params = new URLSearchParams(location.search);
const pane = params.get('pane') === 'true';
/** ?engine=real runs Thalassa's own router on a synthetic navigation cell;
 * otherwise a stub provider returns synthetic geometry (2026-10-01). */
const realEngine = params.get('engine') === 'real';
const mode = params.get('mode') || 'dark';
document.documentElement.classList.toggle('display-light', mode === 'light');
// ?fonts=wide (2026-10-02): the Linux CI runner draws DejaVu Sans, far wider
// than a Mac's system font, and its wraps squeezed the tracer panel (CI
// 36920384778). Verdana on a Mac, DejaVu Sans on Linux: the same wraps on both.
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}
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
                airDraft: 50,
                draft: 1.5 / 0.3048,
                // Confirmed, so Auto opens at once; the ask itself is
                // browser-tested in draft-confirm-layout.spec.ts.
                draftConfirmedFt: 1.5 / 0.3048,
                displacement: 12000,
                maxWaveHeight: 2,
                cruisingSpeed: 6,
            },
            // Auto route (trial) switched on in Preferences: the real-engine
            // provider reads it (off by default since 2026-10-01).
            autorouteTrialEnabled: true,
        },
    }),
);
// Browser-local synthetic reference only. Never seeded in the production app,
// and never contributes trusted depth/route coverage.
const fineEncReady = importCell(
    {
        cellId: 'ZZ5TEST1',
        sourceHO: 'ZZ',
        edition: 1,
        issued: '2026-09-12',
        bbox: [152.8, -27, 153.5, -26.3],
        layers: {
            DEPARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { DRVAL1: 8, DRVAL2: 12 },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [
                                [
                                    [152.8, -27],
                                    [153.5, -27],
                                    [153.5, -26.3],
                                    [152.8, -26.3],
                                    [152.8, -27],
                                ],
                            ],
                        },
                    },
                ],
            },
            LNDARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'Polygon',
                            coordinates: [
                                [
                                    [152.8, -27],
                                    [153.11, -27],
                                    [153.13, -26.3],
                                    [152.8, -26.3],
                                    [152.8, -27],
                                ],
                            ],
                        },
                    },
                ],
            },
            DEPCNT: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { VALDCO: 8 },
                        geometry: {
                            type: 'LineString',
                            coordinates: [
                                [153.15, -27],
                                [153.15, -26.3],
                            ],
                        },
                    },
                ],
            },
        },
    },
    { usage: 'reference' },
);
// A distinct overview-scale fixture is necessary: ZZ5TEST1's 0.99° diagonal
// deliberately fails the production merger's 1.2° ocean-scale filter. Do not
// widen that fine chart's registry bbox or relax real selection guards just
// to make a low-zoom screenshot pass. This sparse synthetic coarse chart is
// only present in the explicit overview test, and remains reference-only.
const overviewEncReady =
    params.get('review') === 'overview'
        ? importCell(
              {
                  cellId: 'ZZ2TEST1',
                  sourceHO: 'ZZ',
                  edition: 1,
                  issued: '2026-09-12',
                  bbox: [151, -28, 155, -23],
                  layers: {
                      DEPARE: {
                          type: 'FeatureCollection',
                          features: [
                              {
                                  type: 'Feature',
                                  properties: { DRVAL1: 8, DRVAL2: 12 },
                                  geometry: {
                                      type: 'Polygon',
                                      coordinates: [
                                          [
                                              [151, -28],
                                              [155, -28],
                                              [155, -23],
                                              [151, -23],
                                              [151, -28],
                                          ],
                                      ],
                                  },
                              },
                          ],
                      },
                      LNDARE: {
                          type: 'FeatureCollection',
                          features: [
                              {
                                  type: 'Feature',
                                  properties: {},
                                  geometry: {
                                      type: 'Polygon',
                                      coordinates: [
                                          [
                                              [151, -28],
                                              [152.9, -28],
                                              [152.9, -23],
                                              [151, -23],
                                              [151, -28],
                                          ],
                                      ],
                                  },
                              },
                          ],
                      },
                  },
              },
              { usage: 'reference' },
          )
        : Promise.resolve();
// ?engine=real: a synthetic NAVIGATION cell in the open Tasman Sea (invented
// geometry near 161.0E, 31.0S — no real chart data): a 10 m sea, an island,
// and a bank charted 0–1 m (DRVAL1 0 / DRVAL2 1) south of it.
// ?charts=none installs nothing, so Auto opens with Calculate disabled.
const box = (w: number, s: number, e: number, n: number): GeoJSON.Polygon => ({
    type: 'Polygon',
    coordinates: [
        [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
        ],
    ],
});
const area = (geometry: GeoJSON.Polygon, properties: Record<string, unknown>): GeoJSON.Feature => ({
    type: 'Feature',
    properties,
    geometry,
});
const realEncReady =
    realEngine && params.get('charts') !== 'none'
        ? importCell(
              {
                  cellId: 'ZZ5TEST9',
                  sourceHO: 'ZZ',
                  edition: 1,
                  issued: '2026-10-01',
                  bbox: [160.9, -31.1, 161.1, -30.9],
                  layers: {
                      DEPARE: {
                          type: 'FeatureCollection',
                          features: [
                              // Sea around the island, in four strips.
                              area(box(160.9, -31.1, 160.99, -30.9), { DRVAL1: 10, DRVAL2: 20 }),
                              area(box(161.01, -31.1, 161.1, -30.9), { DRVAL1: 10, DRVAL2: 20 }),
                              area(box(160.99, -30.99, 161.01, -30.9), { DRVAL1: 10, DRVAL2: 20 }),
                              area(box(160.99, -31.1, 161.01, -31.03), { DRVAL1: 10, DRVAL2: 20 }),
                              // The bank south of the island.
                              area(box(160.99, -31.03, 161.01, -31.01), { DRVAL1: 0, DRVAL2: 1 }),
                          ],
                      },
                      LNDARE: {
                          type: 'FeatureCollection',
                          features: [area(box(160.99, -31.01, 161.01, -30.99), {})],
                      },
                      // Contours off the route's way: a real cell's feature
                      // density, so the corridor gate reads it routing-grade
                      // (InshoreRouter ROUTING_GRADE_MIN_FEATURES_PER_SQDEG).
                      DEPCNT: {
                          type: 'FeatureCollection',
                          features: Array.from({ length: 12 }, (_, i) => ({
                              type: 'Feature' as const,
                              properties: { VALDCO: 10 },
                              geometry: {
                                  type: 'LineString' as const,
                                  coordinates: [
                                      [160.91 + i * 0.015, -31.09],
                                      [160.91 + i * 0.015, -31.06],
                                  ],
                              },
                          })),
                      },
                  },
              },
              { usage: 'navigation' },
          )
        : Promise.resolve();
const encReady = Promise.all([fineEncReady, overviewEncReady, realEncReady]);
const control = {
    statuses: 0,
    calculations: 0,
    manualSelections: 0,
    mapsCreated: 0,
    mapsRemoved: 0,
    mapErrors: [] as string[],
    map: null as mapboxgl.Map | null,
    review: null as TrialRouteReview | null,
    releaseReview: null as (() => void) | null,
    lastRequest: null as AutoroutingTrialRequest | null,
    routeCoordinates: [] as [number, number][],
};
Object.assign(window, { __trialFixture: control });
const OriginalMap = mapboxgl.Map;
Object.assign(mapboxgl, {
    Map: class extends OriginalMap {
        constructor(options: mapboxgl.MapboxOptions) {
            super(options);
            control.mapsCreated += 1;
            control.map = this;
            this.on('error', (event) => control.mapErrors.push(event.error.message));
        }
        remove() {
            control.mapsRemoved += 1;
            control.map = null;
            return super.remove();
        }
    },
});

// The stub provider (2026-10-01): Auto's own router is replaced only for the
// layout scenarios; ?engine=real runs it. Nothing here makes a request.
const stubProvider: AutoroutingProvider = {
    status: () => {
        control.statuses += 1;
        const status = params.get('status');
        if (status === 'failed') throw new Error('Fixture unavailable');
        if (status === 'disabled') return { enabled: false, ready: false };
        if (status === 'unready')
            return {
                enabled: true,
                ready: false,
                message: 'Install charts for your area to use Auto. Manual is ready.',
            };
        return { enabled: true, ready: true };
    },
    calculate: async (body, signal) => {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        control.calculations += 1;
        control.lastRequest = structuredClone(body);
        const { departure, destination } = body;
        const coordinates: [number, number][] =
            params.get('review') === 'sparse'
                ? Array.from({ length: 1000 }, (_, index) => [
                      departure.lon + ((destination.lon - departure.lon) * index) / 999,
                      departure.lat + ((destination.lat - departure.lat) * index) / 999,
                  ])
                : [
                      [departure.lon, departure.lat],
                      [(departure.lon + destination.lon) / 2 + 0.005, (departure.lat + destination.lat) / 2],
                      [destination.lon, destination.lat],
                  ];
        control.routeCoordinates = structuredClone(coordinates);
        if (params.get('review') === 'sparse') {
            // Deliberately synthetic: the 556th original segment is hazardous
            // even though its raw vertex is not a numbered display waypoint.
            control.review = {
                phase: 'complete',
                legs: coordinates.slice(1).map(([lon, lat], index) => ({
                    incomplete: false,
                    verdict: {
                        grade: index === 555 ? 'danger' : 'clear',
                        minDepthM: index === 555 ? 1.2 : 8,
                        minAt: { lon, lat },
                        needsTide: false,
                        nudge: null,
                        nudgeTo: null,
                        issues:
                            index === 555
                                ? [
                                      {
                                          severity: 'danger',
                                          message: 'Sparse fixture obstruction in original segment 556',
                                          mark: { lon, lat: lat + 0.0002 },
                                      },
                                  ]
                                : [],
                    },
                })),
            };
        }
        if (params.get('review') === 'grouped') {
            // Synthetic verdicts for the warning presentation fixture only.
            // Playwright swaps just the grading entrypoint for this scenario;
            // the real panel, grouping helper, map and focus marker still run.
            control.review = {
                phase: 'complete',
                legs: coordinates.slice(1).map(([lon, lat], index) => ({
                    incomplete: false,
                    verdict: {
                        grade: index === 1 ? 'danger' : 'caution',
                        minDepthM: index === 1 ? 1.0 : 8,
                        minAt: { lat, lon },
                        needsTide: index === 1,
                        nudge: null,
                        nudgeTo: null,
                        issues: [
                            {
                                severity: 'caution',
                                message: `${index === 0 ? 50 : 90} m from charted track — review alignment`,
                                at: { lat: lat + 0.0005, lon },
                                chartTrack: {
                                    id: 'synthetic-entrance-track',
                                    label: 'Fixture entrance track',
                                    kind: 'recommended-track',
                                    offsetM: index === 0 ? 50 : 90,
                                },
                            },
                            ...(index === 1
                                ? [
                                      {
                                          severity: 'danger' as const,
                                          message: 'Fixture shallow depth — 1.0 m charted',
                                          at: { lat, lon },
                                      },
                                      {
                                          severity: 'danger' as const,
                                          message: 'Fixture obstruction near route',
                                          mark: { lat: lat - 0.0002, lon: lon - 0.0002 },
                                      },
                                  ]
                                : []),
                        ],
                    },
                })),
            };
        }
        const segments = coordinates.length - 1;
        const none = () => Array.from({ length: segments }, () => false);
        const route: AutoroutingTrialRoute = {
            id: 'layout-proposal',
            provider: 'Thalassa',
            createdAt: '2026-09-12T00:00:00Z',
            coordinates,
            ...(body.vesselProfile ? { vesselProfile: structuredClone(body.vesselProfile) } : {}),
            engine: {
                stateMask: Array.from({ length: segments }, () => 'green' as const),
                cautionMask: none(),
                canalMask: none(),
                channelMask: none(),
                offshoreMask: none(),
                cellsUsed: ['ZZ5TEST1'],
                distanceNM: 1,
                elapsedMs: 10,
                backstop: 'verified',
            },
            warnings: Array.from(
                { length: 4 },
                (_, index) =>
                    `Fixture warning ${index + 1}: Independently inspect current official charts, notices, tides and all vessel clearances. This lengthy advisory must remain readable in the small pane without covering the chart or Close.`,
            ),
        };
        return route;
    },
};
const provider: AutoroutingProvider = realEngine
    ? {
          status: () => {
              control.statuses += 1;
              return thalassaAutoroutingProvider.status();
          },
          calculate: (request, signal, onProgress) => {
              control.calculations += 1;
              control.lastRequest = structuredClone(request);
              return thalassaAutoroutingProvider.calculate(request, signal, onProgress);
          },
      }
    : stubProvider;

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
                        {open && (
                            <AutoroutingProviderContext.Provider value={provider}>
                                <RoutingModeDialog mapboxToken="pk.fixture" onClose={close} onManual={selectManual} />
                            </AutoroutingProviderContext.Provider>
                        )}
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
void Promise.all([settingsReady, encReady]).then(() =>
    createRoot(document.getElementById('root')!).render(<Fixture />),
);
