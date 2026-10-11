// Real Mapbox projection and production marker DOM; synthetic coordinate only.
// No GPS watch, location permission, chart tiles, credentials or cloud writes.
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import { OWNSHIP_MARKER_OPTIONS, createVesselElement } from '../../components/map/useVesselTracker';
import { buildFlagElement } from '../../components/map/useDestinationFlag';
import { buildMobElement } from '../../components/map/useMobMarker';
import { createRouteGhostEl } from '../../components/map/useRouteGhostMarker';

document.body.style.cssText = 'margin:0;background:#020617;color:white;font:14px system-ui;overflow:auto;';
const root = document.getElementById('root')!;
root.style.cssText = 'height:auto;min-height:100vh;';
root.innerHTML =
    '<h1 style="padding:12px">OBS marker anchoring · synthetic fixture</h1><button id="check" style="padding:12px;background:#075985">Check zoom, rotation & insertion order</button><pre id="results" style="white-space:pre-wrap;padding:12px">Waiting for chart</pre><div id="map" style="position:relative;height:550px;width:100%"></div>';
const coordinate: [number, number] = [149.225, -21.112];
const container = document.getElementById('map')!;
const output = document.getElementById('results')!;
const map = new mapboxgl.Map({
    container,
    center: coordinate,
    zoom: 12.7,
    attributionControl: false,
    testMode: true,
    style: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#123047' } }],
    },
});
const markers = [
    new mapboxgl.Marker({ element: buildFlagElement('Test destination'), anchor: 'bottom' }),
    new mapboxgl.Marker({ element: createRouteGhostEl().root, anchor: 'center' }),
    new mapboxgl.Marker({ element: buildMobElement().el, anchor: 'center' }),
    new mapboxgl.Marker({ element: createVesselElement(), ...OWNSHIP_MARKER_OPTIONS }),
];
for (const marker of markers) marker.setLngLat(coordinate).addTo(map);
let busy = false;
async function checkMatrix() {
    if (busy) return;
    busy = true;
    const lines: string[] = [];
    let worst = 0;
    for (const reverse of [false, true]) {
        for (const marker of reverse ? [...markers].reverse() : markers) {
            const el = marker.getElement();
            el.parentElement?.appendChild(el);
        }
        for (const zoom of [8, 12.7, 19]) {
            for (const [bearing, pitch] of [
                [0, 0],
                [55, 40],
            ]) {
                map.jumpTo({ center: coordinate, zoom, bearing, pitch });
                await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                );
                const expected = map.project(coordinate);
                const frame = container.getBoundingClientRect();
                const errors = markers.map((marker, index) => {
                    const rect = marker.getElement().getBoundingClientRect();
                    const x = (rect.left + rect.right) / 2 - frame.left;
                    const y = (index === 0 ? rect.bottom : (rect.top + rect.bottom) / 2) - frame.top;
                    return Math.hypot(x - expected.x, y - expected.y);
                });
                worst = Math.max(worst, ...errors);
                lines.push(
                    `z${zoom} bearing${bearing} pitch${pitch} ${reverse ? 'reverse' : 'forward'}: ${errors.map((n) => n.toFixed(2)).join(', ')} px`,
                );
            }
        }
    }
    output.textContent = `${worst < 1 ? 'PASS' : 'FAIL'} · ${container.clientWidth}px wide · max drift ${worst.toFixed(3)} px · flag/ghost/MOB/vessel\n${lines.join('\n')}`;
    busy = false;
}
document.getElementById('check')!.addEventListener('click', () => void checkMatrix());
map.once('load', () => void checkMatrix());
