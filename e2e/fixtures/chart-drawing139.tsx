/** Synthetic map/receiver only; real annotation renderer, private Directory.Data store and export handoff. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import ChartDrawingTools from '../../components/map/drawing/ChartDrawingTools';
import PaperChartSheet from '../../components/map/PaperChartSheet';
import { MapBaseSelector } from '../../components/map/MapBaseSelector';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { NmeaStore } from '../../services/NmeaStore';
import { useSettingsStore, awaitSettingsLoaded } from '../../stores/settingsStore';
import { loadAnnotations } from '../../services/chartAnnotations/store';
import type { AnnotationLibrary } from '../../services/chartAnnotations/model';
import type { InstrumentEvidence } from '../../services/instruments/measurements';
if (!import.meta.env.DEV) throw Error('Development-only synthetic fixture.');
mapboxgl.accessToken = 'pk.synthetic-drawing-test';
Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
declare global {
    interface Window {
        __drawingFixture: {
            library: () => Promise<AnnotationLibrary>;
            switchOwner: () => void;
            switchVessel: () => void;
            fix: (via?: InstrumentEvidence['via'], age?: number, heading?: boolean) => void;
            resetStyle: () => void;
            foreground: (active: boolean) => void;
            competing: (active: boolean) => void;
            probe: () => Promise<{
                annotations: number;
                ruler: number;
                draft: number;
                pixel: number[];
                loaded: boolean;
            }>;
        };
    }
}
function Fixture() {
    const composed = new URLSearchParams(location.search).has('composed');
    const container = React.useRef<HTMLDivElement | null>(null),
        map = React.useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = React.useState(false),
        [open, setOpen] = React.useState(false),
        [paper, setPaper] = React.useState(false),
        [active, setActive] = React.useState(true),
        [competing, setCompeting] = React.useState(false),
        [owned, setOwned] = React.useState(false);
    const close = React.useCallback(() => setOpen(false), []),
        closePaper = React.useCallback(() => setPaper(false), []),
        interaction = React.useCallback((value: boolean) => setOwned(value), []);
    const available = active && ready && !competing;
    React.useEffect(() => {
        if (!active) {
            setOpen(false);
            setPaper(false);
        }
    }, [active]);
    React.useEffect(() => {
        const style = () => ({
            version: 8 as const,
            sources: {},
            layers: [{ id: 'sea', type: 'background' as const, paint: { 'background-color': '#0b2030' } }],
        });
        const m = new mapboxgl.Map({
            container: container.current!,
            testMode: true,
            accessToken: 'pk.synthetic-drawing-test',
            performanceMetricsCollection: false,
            preserveDrawingBuffer: true,
            center: [0, 0],
            zoom: 9,
            fadeDuration: 0,
            style: style(),
        });
        map.current = m;
        m.on('load', () => setReady(true));
        window.__drawingFixture = {
            library: () => loadAnnotations(),
            switchOwner: () => setAuthIdentityScope('drawing-fixture-owner-B'),
            switchVessel: () => useSettingsStore.setState({ activeVesselId: 'another-fixture-vessel' }),
            fix: (via = 'gateway', age = 0, heading = true) => {
                const at = Date.now() - age;
                NmeaStore.getState().instrumentEvidence = {
                    identity: 'fictional-boat-receiver',
                    via,
                    position: { lat: 0, lon: 0, at },
                    readings: heading
                        ? {
                              headingTrue: {
                                  value: 90,
                                  at,
                                  unit: 'degrees',
                                  reference: 'true',
                                  source: 'fictional-heading',
                              },
                          }
                        : {},
                };
            },
            resetStyle: () => m.setStyle(style()),
            foreground: setActive,
            competing: setCompeting,
            probe: () =>
                new Promise((resolve) => {
                    m.once('render', () => {
                        const source = (id: string) =>
                            (
                                m.getSource(id) as
                                    | (mapboxgl.GeoJSONSource & {
                                          _data?: {
                                              features: Array<{
                                                  geometry: { type: string; coordinates: number[][] | number[] };
                                              }>;
                                          };
                                      })
                                    | undefined
                            )?._data?.features ?? [];
                        const annotations = source('user-chart-annotations'),
                            ruler = source('user-boat-ruler'),
                            draft = source('user-chart-draft'),
                            first = annotations[0];
                        const c = m.getCanvas(),
                            gl = c.getContext('webgl2')!,
                            binding = gl.getParameter(gl.FRAMEBUFFER_BINDING),
                            pixel = new Uint8Array(4);
                        let x = c.width / 2,
                            y = c.height / 2;
                        if (first?.geometry.type === 'LineString') {
                            const points = first.geometry.coordinates as number[][],
                                a = m.project([points[0][0], points[0][1]]),
                                b = m.project([points[1][0], points[1][1]]),
                                rect = c.getBoundingClientRect();
                            x = (((a.x + b.x) / 2) * c.width) / rect.width;
                            y = c.height - (((a.y + b.y) / 2) * c.height) / rect.height;
                        }
                        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                        gl.readPixels(Math.floor(x), Math.floor(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                        gl.bindFramebuffer(gl.FRAMEBUFFER, binding);
                        resolve({
                            annotations: annotations.length,
                            ruler: ruler.length,
                            draft: draft.length,
                            pixel: [...pixel],
                            loaded:
                                !!m.getSource('user-chart-annotations') && m.isSourceLoaded('user-chart-annotations'),
                        });
                    });
                    m.triggerRepaint();
                }),
        };
        return () => m.remove();
    }, []);
    return (
        <main className="fixed inset-0 overflow-hidden bg-slate-950 text-white" data-owned={owned}>
            <div ref={container} className="thalassa-chart-map" style={{ position: 'absolute', inset: 0 }} />
            {!composed && (
                <button
                    className="absolute left-3 top-3 z-20 min-h-11 rounded-xl bg-slate-800 px-3"
                    disabled={!ready || owned}
                    onClick={() => setOpen(true)}
                >
                    Your drawings
                </button>
            )}
            {composed && (
                <MapBaseSelector
                    visible={active && ready}
                    value="relief"
                    onChange={() => {}}
                    encCellCount={0}
                    encVisible={false}
                    onToggleEnc={() => {}}
                    onCharts={() => setPaper(true)}
                />
            )}
            {paper && (
                <PaperChartSheet
                    onClose={closePaper}
                    bounds={[-1, -1, 1, 1]}
                    sources={[]}
                    onToggle={() => {}}
                    onOpacity={() => {}}
                    onConsent={() => {}}
                    category="standard"
                    onCategory={() => {}}
                    satelliteMode
                    onDrawingTools={() => {
                        setOpen(true);
                        setPaper(false);
                    }}
                    drawingToolsDisabled={!available || owned}
                />
            )}
            <ChartDrawingTools
                map={map.current}
                mapReady={ready}
                active={active}
                canDraw={composed ? available && !paper : true}
                open={open}
                onClose={close}
                onInteractionChange={interaction}
            />
        </main>
    );
}
async function mount() {
    setAuthIdentityScope('drawing-fixture-owner-A');
    await awaitSettingsLoaded();
    useSettingsStore.setState({ activeVesselId: 'fixture-vessel-A' });
    createRoot(document.getElementById('root')!).render(<Fixture />);
}
void mount();
