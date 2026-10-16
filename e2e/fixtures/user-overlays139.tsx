import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import UserOverlaysSheet from '../../components/map/UserOverlaysSheet';
import UserOverlayLayer from '../../components/map/UserOverlayLayer';
import PaperChartSheet from '../../components/map/PaperChartSheet';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { NmeaStore } from '../../services/NmeaStore';
if (!import.meta.env.DEV) throw Error('Development-only synthetic fixture.');
setAuthIdentityScope('overlay-fixture-owner-A');
mapboxgl.accessToken = 'pk.synthetic-overlay-test';
declare global {
    interface Window {
        __overlayFix: (lon: number, age?: number) => void;
        __overlaySwitch: () => void;
        __overlayProbe: () => Promise<{ features: number; pixel: number[]; loaded: boolean }>;
        __overlayRemoveStyle: () => void;
    }
}
function Fixture() {
    const container = React.useRef<HTMLDivElement | null>(null),
        map = React.useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = React.useState(false),
        [open, setOpen] = React.useState(false),
        [paper, setPaper] = React.useState(false);
    const close = React.useCallback(() => setOpen(false), []);
    const closePaper = React.useCallback(() => setPaper(false), []);
    React.useEffect(() => {
        const m = new mapboxgl.Map({
            container: container.current!,
            testMode: true,
            accessToken: 'pk.synthetic-overlay-test',
            performanceMetricsCollection: false,
            preserveDrawingBuffer: true,
            center: [0.5, 0.5],
            zoom: 7,
            fadeDuration: 0,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'sea', type: 'background', paint: { 'background-color': '#0b2030' } }],
            },
        });
        map.current = m;
        m.on('load', () => setReady(true));
        window.__overlayFix = (lon, age = 0) => {
            NmeaStore.getState().instrumentEvidence = {
                identity: 'fictional-gateway-A',
                via: 'gateway',
                readings: {},
                position: { lat: 0.5, lon, at: Date.now() - age },
            };
        };
        window.__overlaySwitch = () => setAuthIdentityScope('overlay-fixture-owner-B');
        window.__overlayRemoveStyle = () =>
            m.setStyle({
                version: 8,
                sources: {},
                layers: [{ id: 'sea', type: 'background', paint: { 'background-color': '#0b2030' } }],
            });
        window.__overlayProbe = () =>
            new Promise((resolve) => {
                m.once('render', () => {
                    const c = m.getCanvas(),
                        gl = c.getContext('webgl2')!,
                        binding = gl.getParameter(gl.FRAMEBUFFER_BINDING),
                        pixel = new Uint8Array(4);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    gl.readPixels(
                        Math.floor(c.width / 2),
                        Math.floor(c.height / 2),
                        1,
                        1,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        pixel,
                    );
                    gl.bindFramebuffer(gl.FRAMEBUFFER, binding);
                    resolve({
                        features:
                            (
                                m.getSource('private-user-overlays') as
                                    | (mapboxgl.GeoJSONSource & { _data?: { features: unknown[] } })
                                    | undefined
                            )?._data?.features.length ?? 0,
                        pixel: [...pixel],
                        loaded: !!m.getSource('private-user-overlays') && m.isSourceLoaded('private-user-overlays'),
                    });
                });
                m.triggerRepaint();
            });
        return () => m.remove();
    }, []);
    return (
        <div className="fixed inset-0 bg-slate-950 text-white">
            <div ref={container} style={{ position: 'absolute', inset: 0 }} />
            <button
                disabled={!ready}
                className="absolute left-3 top-3 z-20 rounded bg-slate-800 p-3 min-h-11"
                onClick={() => setOpen(true)}
            >
                Your overlays
            </button>
            <button
                disabled={!ready}
                className="absolute left-3 top-20 z-20 rounded bg-slate-800 p-3 min-h-11"
                onClick={(event) => {
                    // The production MapBaseSelector focuses its trigger before opening.
                    event.currentTarget.focus({ preventScroll: true });
                    setPaper(true);
                }}
            >
                Charts &amp; detail
            </button>
            <UserOverlayLayer map={map.current} mapReady={ready} active />
            <React.Suspense fallback={<p>Opening local overlays…</p>}>
                {open && <UserOverlaysSheet onClose={close} />}
                {paper && (
                    <PaperChartSheet
                        onClose={closePaper}
                        bounds={[0, 0, 1, 1]}
                        sources={[]}
                        onToggle={() => {}}
                        onOpacity={() => {}}
                        onConsent={() => {}}
                        category="standard"
                        onCategory={() => {}}
                        satelliteMode
                        onUserOverlays={() => setOpen(true)}
                    />
                )}
            </React.Suspense>
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
