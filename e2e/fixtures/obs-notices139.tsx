/** Fictional public warning metadata, actual Mapbox camera/markers/popup and Charts sheet. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import ObsNoticesLayer from '../../components/map/ObsNoticesLayer';
import PaperChartSheet from '../../components/map/PaperChartSheet';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
if (!import.meta.env.DEV) throw Error('Development-only synthetic fixture.');
setAuthIdentityScope('notice-fixture-owner-A');
useSettingsStore.setState((state) => ({ settings: { ...state.settings, satelliteMode: true } }));
mapboxgl.accessToken = 'pk.synthetic-notices139';
const fetchedAt = Date.now() - 2 * 3600000;
const warning = (id: string, lat: number, lon: number) => ({
    id,
    msgYear: 2026,
    msgNumber: 1,
    navArea: 'X',
    areaLabel: 'NAVAREA X',
    subregion: '',
    issueDate: '160000Z OCT 2026',
    issueDateParsed: '2026-10-16T00:00:00Z',
    authority: 'Fictional official issuer',
    title: 'Fictional broadcast warning',
    text: 'Invented warning text <img src=x onerror="alert(1)">. Read the original issuer.',
    coordinates: [{ lat, lon }],
    status: 'A',
});
const notices = [warning('X-2026/1', 0, 179.9), warning('X-2026/2', 20, 0)];
localStorage.setItem(
    'thalassa_ntm_cache_v1',
    JSON.stringify({ fetchedAt, notices, sources: { amsa: { notices, fetchedAt, failing: false } } }),
);
localStorage.setItem(
    'thalassa_qld_ntm_v1',
    JSON.stringify({
        fetchedAt: fetchedAt - 3600000,
        notices: [
            {
                number: '1 T of 2026',
                subject: 'Fictional Queensland shoal',
                dateStr: '01/10/2026',
                region: 'Invented locality',
                pdfUrl: 'https://www.publications.qld.gov.au/example.pdf',
                datasetUrl: 'https://www.publications.qld.gov.au/dataset/example',
                lat: 0.03,
                lon: -179.97,
                createdMs: Date.now(),
            },
        ],
    }),
);
declare global {
    interface Window {
        __obsNoticeMap: mapboxgl.Map;
        __obsNoticeForeground: (active: boolean) => void;
        __obsNoticeSwitch: () => void;
    }
}
function Fixture() {
    const holder = React.useRef<HTMLDivElement | null>(null),
        map = React.useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = React.useState(false),
        [enabled, setEnabled] = React.useState(true),
        [active, setActive] = React.useState(true),
        [paper, setPaper] = React.useState(false);
    const close = React.useCallback(() => setPaper(false), []);
    React.useEffect(() => {
        const m = new mapboxgl.Map({
            container: holder.current!,
            testMode: true,
            center: [179.9, 0],
            zoom: 8,
            performanceMetricsCollection: false,
            preserveDrawingBuffer: true,
            fadeDuration: 0,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'sea', type: 'background', paint: { 'background-color': '#0b2236' } }],
            },
        });
        map.current = m;
        window.__obsNoticeMap = m;
        window.__obsNoticeForeground = setActive;
        window.__obsNoticeSwitch = () => setAuthIdentityScope('notice-fixture-owner-B');
        m.on('load', () => setReady(true));
        return () => m.remove();
    }, []);
    return (
        <div className="fixed inset-0 bg-slate-950 text-white">
            <div ref={holder} style={{ position: 'absolute', inset: 0 }} />
            <button
                disabled={!ready}
                onClick={() => setPaper(true)}
                className="absolute left-3 top-3 z-20 min-h-11 rounded bg-slate-800 px-3"
            >
                Charts &amp; detail
            </button>
            <span data-testid="notice-map-ready" className="sr-only">
                {ready ? 'ready' : 'loading'}
            </span>
            <ObsNoticesLayer map={map.current} mapReady={ready} active={active} enabled={enabled} />
            {paper && (
                <PaperChartSheet
                    onClose={close}
                    bounds={[179, -1, -179, 1]}
                    sources={[]}
                    onToggle={() => {}}
                    onOpacity={() => {}}
                    onConsent={() => {}}
                    category="standard"
                    onCategory={() => {}}
                    satelliteMode
                    notices={{ enabled, onChange: setEnabled }}
                />
            )}
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
