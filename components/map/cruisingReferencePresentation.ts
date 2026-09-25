import type { CruisingPoint } from '../../services/anchorages/cruisingReference';
import { CONDITION_COLOURS, type TrafficLight, type PlaceConditions } from '../../services/anchorages/placeConditions';
import { placeConditionsHtml } from './placeConditionsPresentation';
const esc = (v: unknown) =>
    String(v ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
export const BUOY_COLOURS: Record<string, string> = {
    blue: '#38bdf8',
    white: '#f8fafc',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    orange: '#fb923c',
    brown: '#b98961',
    black: '#334155',
    grey: '#94a3b8',
};

export function mooringPopup(point: CruisingPoint, conditions?: PlaceConditions): string {
    const colours = point.colours.length ? point.colours.join(' / ') : 'Not recorded';
    const date = Number.isFinite(Date.parse(point.retrievedAt))
        ? new Date(point.retrievedAt).toISOString().slice(0, 10)
        : 'Unknown';
    // URLs come from the parsers, not OSM website tags. Still validate on cache reads.
    const link =
        /^https:\/\/(www\.openstreetmap\.org\/(node|way|relation)\/\d+|spatial-gis\.information\.qld\.gov\.au\/arcgis\/rest\/services\/Environment\/ParksMarineMoorings\/FeatureServer\/20)$/.test(
            point.sourceUrl,
        )
            ? `<a href="${esc(point.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(point.source)}</a>`
            : esc(point.source);
    return `<div style="font-family:system-ui;color:#0f172a;max-width:270px;max-height:40dvh;overflow-y:auto;line-height:1.45">
      <div style="font-size:11px;letter-spacing:.12em;color:#0369a1;font-weight:800">MOORING REFERENCE</div>
      <h3 style="font-size:17px;margin:5px 0">${esc(point.name)}</h3>
      <div><strong>Buoy colour:</strong> ${esc(colours)}</div>
      ${point.mooringClass ? `<div><strong>Class ${esc(point.mooringClass)} band:</strong> ${esc(point.band)}</div>` : ''}
      <div><strong>Access:</strong> ${esc(point.access)}</div>
      ${point.approximate ? '<div>Approximate area centre — not an individual buoy position.</div>' : ''}
      ${point.notes ? `<p style="margin:8px 0">${esc(point.notes)}</p>` : ''}
      <div class="place-conditions">${conditions ? placeConditionsHtml(conditions) : ''}</div>
      <p style="padding:8px;background:#fef3c7;border-radius:8px;font-size:12px">Colour is not permission or suitability. Verify the physical buoy, permission, vessel limits and condition. Reef-protection markers are not moorings.</p>
      <div style="font-size:11px;color:#475569">${link} · retrieved ${esc(date)}<br/>No live occupancy or availability. Positions and coverage may be incomplete.</div>
    </div>`;
}

/** Small, map-anchored double-cone silhouette; grey means unknown, never green
 * for a guessed safe status. A second stripe shows a documented body colour. */
export function mooringIcon(
    colours: string[],
    band: string | null,
    light?: TrafficLight,
): { width: number; height: number; data: Uint8Array } {
    const size = 56;
    const data = new Uint8Array(size * size * 4);
    const rgba = (name: string) => {
        const hex = BUOY_COLOURS[name] ?? BUOY_COLOURS.grey;
        return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
    };
    const put = (x: number, y: number, colour: number[]) => data.set(colour, (y * size + x) * 4);
    if (light) {
        const hex = CONDITION_COLOURS[light];
        const ring = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
        for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++) {
                const d = Math.hypot(x - 27.5, y - 27.5);
                if (d >= 23 && d <= 27) put(x, y, ring);
            }
    }
    for (let y = 8; y <= 45; y++)
        for (let x = 6; x <= 49; x++) {
            const half = y <= 27 ? (y - 7) * 0.95 : (46 - y) * 0.95;
            const d = Math.abs(x - 27.5);
            if (d <= half + 2)
                put(
                    x,
                    y,
                    d > half
                        ? [15, 23, 42, 255]
                        : rgba(y >= 23 && y <= 30 ? (band ?? colours[1] ?? colours[0]) : colours[0]),
                );
        }
    for (let y = 44; y < 51; y++)
        for (let x = 25; x < 31; x++) if (Math.hypot(x - 27.5, y - 47) < 3) put(x, y, [248, 250, 252, 255]);
    return { width: size, height: size, data };
}
