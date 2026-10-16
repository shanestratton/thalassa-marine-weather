/** Generated public-water radar/NMEA only; real app parser, RAM store, map hooks and Targets UI. */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import { RadarStore } from '../../services/radar/radarStore';
import { AisStore } from '../../services/AisStore';
import { AisTargetsSheet } from '../../components/map/AisTargetsSheet';
import { useRadarLayer } from '../../components/map/useRadarLayer';
import { useAisStreamLayer } from '../../components/map/useAisStreamLayer';
import { useSettingsStore } from '../../stores/settingsStore';
if (!import.meta.env.DEV) throw Error('Development fixture only');
const clock = Date.now(),
    date = new Date(clock);
const utc = date.toISOString().slice(11, 23).replaceAll(':', '');
const day =
    String(date.getUTCDate()).padStart(2, '0') +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    String(date.getUTCFullYear()).slice(-2);
useSettingsStore.setState((state) => ({
    ...state,
    settings: { ...state.settings, satelliteMode: true, subscriptionTier: 'free' },
}));
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
const session = RadarStore.openGateway()!;
for (const body of [
    'GPRMC,120000,A,0000.000,N,17959.940,E,5,0,020126,,,A',
    'HEHDT,0,T',
    'RATTM,1,1,90,R,10,180,R,0,6,N,Generated echo,T,,120000,A',
    'RATLL,2,0001.800,N,17959.940,W,<img src=x>,120000,T,',
])
    RadarStore.ingest(session, frame(body.replace('120000', utc).replace('020126', day)), clock);
const contact = RadarStore.getSnapshot().contacts.find((c) => c.targetNumber === 1)!;
AisStore.update({
    mmsi: 123456789,
    name: 'Generated matched vessel',
    lat: contact.position!.lat,
    lon: contact.position!.lon,
    sog: contact.motion!.sogKn,
    cog: contact.motion!.cogTrueDeg ?? undefined,
    lastUpdated: clock,
});
function Fixture() {
    const box = useRef<HTMLDivElement>(null),
        [map, setMap] = useState<mapboxgl.Map | null>(null),
        [open, setOpen] = useState(false);
    const merged = useRadarLayer(map, true);
    useAisStreamLayer(map, true, merged);
    useEffect(() => {
        const m = new mapboxgl.Map({
            container: box.current!,
            accessToken: 'pk.synthetic-radar-map',
            preserveDrawingBuffer: true,
            center: [180.007, 0.012],
            zoom: 12,
            attributionControl: false,
            fadeDuration: 0,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'sea', type: 'background', paint: { 'background-color': '#86b9cf' } }],
            },
        });
        m.on('error', (event) => console.error('Radar map', event.error?.message));
        m.once('load', () => {
            m.addSource('ais-targets', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            m.addLayer({
                id: 'ais-targets-circle',
                type: 'circle',
                source: 'ais-targets',
                paint: { 'circle-radius': 5, 'circle-color': '#22c55e' },
            });
            setMap(m);
        });
        Object.assign(window, {
            __radar137: {
                async render() {
                    await new Promise<void>((r) => {
                        m.once('render', () => r());
                        m.triggerRepaint();
                    });
                    const canvas = m.getCanvas(),
                        gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
                    const c = RadarStore.getSnapshot().contacts.find((c) => c.targetNumber === 1),
                        point = c?.position;
                    let cyan = 0;
                    if (gl && point) {
                        const p = m.project([point.lon < 0 ? point.lon + 360 : point.lon, point.lat]),
                            ratio = canvas.width / canvas.clientWidth;
                        const width = Math.round(25 * ratio),
                            height = width,
                            data = new Uint8Array(width * height * 4);
                        // Mapbox may leave an internal framebuffer bound after its render
                        // event. Inspect the actual canvas, then restore the renderer state.
                        const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
                        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                        gl.readPixels(
                            Math.floor(p.x * ratio - width / 2),
                            Math.floor(canvas.height - p.y * ratio - height / 2),
                            width,
                            height,
                            gl.RGBA,
                            gl.UNSIGNED_BYTE,
                            data,
                        );
                        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
                        for (let i = 0; i < data.length; i += 4)
                            if (data[i] < 100 && data[i + 1] > 120 && data[i + 2] > 130) cyan++;
                    }
                    return {
                        cyan,
                        now: Date.now(),
                        contacts: RadarStore.getSnapshot().contacts.map((c) => ({
                            at: c.at,
                            fresh: c.fresh,
                            motionAt: c.motion?.at,
                        })),
                        filter: m.getFilter('ais-targets-circle'),
                        loaded: m.isStyleLoaded(),
                        radar: m.getLayer('radar-targets')
                            ? m.queryRenderedFeatures({ layers: ['radar-targets'] }).length
                            : 0,
                        ais: m.queryRenderedFeatures({ layers: ['ais-targets-circle'] }).length,
                        drawn: m.getSource('radar-targets')
                            ? m
                                  .querySourceFeatures('radar-targets')
                                  .map((f) => ({ geometry: f.geometry, properties: f.properties }))
                            : [],
                    };
                },
                age() {
                    RadarStore.tick();
                },
                retire() {
                    RadarStore.retire(session);
                },
            },
        });
        return () => {
            setMap(null);
            m.remove();
            RadarStore.retire(session);
        };
    }, []);
    return (
        <main className="fixed inset-0 bg-slate-950 text-white">
            <div ref={box} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
            <button
                className="absolute bottom-3 left-3 z-10 min-h-11 rounded-lg bg-slate-950 px-4"
                onClick={(e) => {
                    e.currentTarget.focus();
                    setOpen(true);
                }}
            >
                Open targets
            </button>
            <span role="status" className="absolute top-3 left-3 z-10 bg-slate-950">
                {map ? 'Map ready' : 'Loading'}
            </span>
            {open && (
                <AisTargetsSheet
                    onClose={() => setOpen(false)}
                    onSelect={(feature) => {
                        setOpen(false);
                        const [lon, lat] = feature.geometry.coordinates;
                        map?.jumpTo({ center: [lon < 0 ? lon + 360 : lon, lat], zoom: 12 });
                        window.dispatchEvent(
                            new CustomEvent(
                                feature.properties?.radarContactKey
                                    ? 'thalassa:select-radar-target'
                                    : 'thalassa:select-ais-target',
                                {
                                    detail: feature.properties?.radarContactKey
                                        ? { contactKey: feature.properties.radarContactKey }
                                        : { mmsi: Number(feature.properties?.mmsi) },
                                },
                            ),
                        );
                    }}
                />
            )}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
