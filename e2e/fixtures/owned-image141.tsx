/** Development-only local PNG/URL lifetime fixture: no provider data, style, tiles or credentials. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useOwnedImageOverlay, type OwnedImageFrame } from '../../components/map/useOwnedImageOverlay';
if (!import.meta.env.DEV) throw new Error('Development-only local fixture');
mapboxgl.accessToken = 'pk.fictional-owned-image-proof';
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, options) => {
    const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        location.href,
    );
    if (
        url.hostname === 'events.mapbox.com' ||
        (url.hostname === 'api.mapbox.com' && url.pathname.includes('map-sessions'))
    )
        return new Response(null, { status: 204 });
    return nativeFetch(input, options);
};
declare global {
    interface Window {
        __ownedImage141: { start(): Promise<string>; off(): void; stick(): void; remove(): void; evidence(): unknown };
    }
}
const releases: { url: string; sourcePresent: boolean | null }[] = [],
    errors: string[] = [];
function Fixture() {
    const ref = React.useRef<mapboxgl.Map | null>(null),
        container = React.useRef<HTMLDivElement>(null);
    const [ready, setReady] = React.useState(false),
        [enabled, setEnabled] = React.useState(false);
    const [frame, setFrame] = React.useState<(OwnedImageFrame & { active: boolean }) | null>(null);
    const latest = React.useRef(frame);
    latest.current = frame;
    const prepare = React.useCallback(() => {
        if (!frame) throw Error('Frame missing');
        return frame;
    }, [frame]);
    const status = useOwnedImageOverlay(ref, ready, {
        id: 'owned-png',
        label: 'Local PNG',
        credit: 'Synthetic local source',
        enabled,
        owner: frame,
        revision: frame?.url ?? '',
        sourceCurrent: () => !!frame?.active,
        prepare,
        maxEdge: 1024,
    });
    React.useEffect(() => {
        const map = new mapboxgl.Map({
            container: container.current!,
            center: [0, 0],
            zoom: 1,
            preserveDrawingBuffer: true,
            performanceMetricsCollection: false,
            attributionControl: false,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'base', type: 'background', paint: { 'background-color': '#081c2c' } }],
            },
        });
        ref.current = map;
        map.on('load', () => setReady(true));
        map.on('error', (event) => errors.push(event.error.message));
        window.__ownedImage141 = {
            start: async () => {
                const canvas = document.createElement('canvas');
                canvas.width = 16;
                canvas.height = 16;
                const context = canvas.getContext('2d')!;
                context.fillStyle = '#38bdf8';
                context.fillRect(0, 0, 16, 16);
                const blob = await new Promise<Blob>((resolve, reject) =>
                    canvas.toBlob((value) => (value ? resolve(value) : reject(Error('PNG missing'))), 'image/png'),
                );
                const url = URL.createObjectURL(blob);
                setFrame({
                    url,
                    width: 16,
                    height: 16,
                    coordinates: [
                        [-30, 30],
                        [30, 30],
                        [30, -30],
                        [-30, -30],
                    ],
                    active: true,
                    release: () => {
                        let sourcePresent: boolean | null = null;
                        try {
                            sourcePresent = !!map.getSource('owned-png-source');
                        } catch {
                            /* removed scene */
                        }
                        releases.push({ url, sourcePresent });
                        URL.revokeObjectURL(url);
                    },
                });
                setEnabled(true);
                return url;
            },
            off: () => {
                if (latest.current) latest.current.active = false;
                setEnabled(false);
            },
            stick: () => {
                const removeLayer = map.removeLayer.bind(map),
                    removeSource = map.removeSource.bind(map),
                    layout = map.setLayoutProperty.bind(map);
                map.removeLayer = (id) => (id.startsWith('owned-png') ? map : removeLayer(id));
                map.removeSource = (id) => (id.startsWith('owned-png') ? map : removeSource(id));
                map.setLayoutProperty = (id, ...args) => (id.startsWith('owned-png') ? map : layout(id, ...args));
            },
            remove: () => map.remove(),
            evidence: () => {
                let source: boolean | null = null;
                try {
                    source = !!map.getSource('owned-png-source');
                } catch {
                    /* removed scene */
                }
                return { releases: [...releases], errors: [...errors], source };
            },
        };
        return () => map.remove();
    }, []);
    return (
        <main style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
            <div ref={container} style={{ position: 'absolute', inset: 0 }} />
            <output data-testid="owned-image-status" style={{ position: 'absolute', top: 0, left: 0, color: 'white' }}>
                {ready ? status : 'map-loading'}
            </output>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
