/** Pure presentation/export of logged measurements; never queries or fills from forecasts. */
import type { ShipLogEntry } from '../types';
import type { PiTrackHistory, PiTrackHistoryPoint } from './piTrackHistory';

export const TRACK_GRAPH_FIELDS = [
    { key: 'sog_kts', label: 'Speed over ground', unit: 'kt' },
    { key: 'tws_kts', label: 'True wind speed', unit: 'kt' },
    { key: 'depth_m', label: 'Measured depth', unit: 'm' },
    { key: 'pressure_hpa', label: 'Pressure', unit: 'hPa' },
    { key: 'heel_deg', label: 'Heel', unit: 'deg' },
] as const;
export type TrackGraphField = (typeof TRACK_GRAPH_FIELDS)[number]['key'];
export const TRACK_GRAPH_GAP_MS = 300_000;

export function trackGraph(history: PiTrackHistory, key: TrackGraphField) {
    const values = history.points.map((point) => point[key]).filter((value): value is number => value !== null);
    if (!values.length) return { paths: [] as string[], minimum: null, maximum: null, count: 0 };
    let minimum = Infinity,
        maximum = -Infinity;
    for (const value of values) {
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
    }
    const spread = maximum - minimum || 1;
    const paths: string[] = [];
    let path = '',
        previous: number | null = null;
    for (const point of history.points) {
        const value = point[key];
        if (value === null) {
            if (path) paths.push(path);
            path = '';
            previous = null;
            continue;
        }
        if (previous !== null && point.at_ms - previous > TRACK_GRAPH_GAP_MS) {
            if (path) paths.push(path);
            path = '';
        }
        const x = 4 + (272 * (point.at_ms - history.from)) / Math.max(1, history.to - history.from);
        const y = maximum === minimum ? 36 : 64 - (56 * (value - minimum)) / spread;
        const xy = `${x.toFixed(2)},${y.toFixed(2)}`;
        path += path ? `L${xy}` : `M${xy}L${xy}`; // Round cap makes an isolated recorded fix visible.
        previous = point.at_ms;
    }
    if (path) paths.push(path);
    return { paths, minimum, maximum, count: values.length };
}

export function piTrackMapEntries(history: PiTrackHistory): ShipLogEntry[] {
    return history.points.map((point) => ({
        id: `pi-${history.snapshot}-${point.sample_id}`,
        userId: '',
        voyageId: `pi-track-${history.snapshot}`,
        timestamp: new Date(point.at_ms).toISOString(),
        latitude: point.lat,
        longitude: point.lon,
        positionFormatted: `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`,
        entryType: 'auto',
        source: 'device',
        positionSource: 'vessel-pi-log',
        speedKts: point.sog_kts ?? undefined,
        courseDeg: point.cog_deg ?? undefined,
        windSpeed: point.tws_kts ?? undefined,
        windDirection: point.twd_deg === null ? undefined : `${point.twd_deg.toFixed(0)} deg true`,
        pressure: point.pressure_hpa ?? undefined,
        waterTemp: point.water_temp_c ?? undefined,
    }));
}

const fields = [
    'sample_id',
    'lat',
    'lon',
    'reason',
    'sog_kts',
    'cog_deg',
    'stw_kts',
    'hdg_deg',
    'depth_m',
    'tws_kts',
    'twd_deg',
    'water_temp_c',
    'pressure_hpa',
    'heel_deg',
    'engine_rpm',
    'twa_deg',
    'sog_at_ms',
    'cog_true_at_ms',
    'stw_at_ms',
    'heading_true_deg',
    'heading_true_at_ms',
    'leeway_deg',
    'leeway_at_ms',
    'leeway_source',
    'engine_rpm_at_ms',
] as const;
const xml = (value: string) =>
    value.replace(
        /[<>&"']/g,
        (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!,
    );
const csv = (value: unknown) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
};
export function piTrackCsv(history: PiTrackHistory): string {
    const header = ['requested_from_utc', 'requested_to_utc', 'partial_window', 'timestamp_utc', ...fields];
    const rows = history.points.map((point) =>
        [
            new Date(history.from).toISOString(),
            new Date(history.to).toISOString(),
            history.truncated,
            new Date(point.at_ms).toISOString(),
            ...fields.map((field) => point[field]),
        ]
            .map(csv)
            .join(','),
    );
    return '\uFEFF' + [header.join(','), ...rows].join('\r\n') + '\r\n';
}
export function piTrackGpx(history: PiTrackHistory): string {
    let previous: PiTrackHistoryPoint | null = null;
    const segments: string[] = [];
    let segment = '';
    for (const point of history.points) {
        if (previous && point.at_ms - previous.at_ms > TRACK_GRAPH_GAP_MS) {
            segments.push(segment);
            segment = '';
        }
        const extensions = fields
            .filter((field) => !['lat', 'lon'].includes(field) && point[field] !== null && point[field] !== undefined)
            .map((field) => `<thalassa:${field}>${xml(String(point[field]))}</thalassa:${field}>`)
            .join('');
        segment += `<trkpt lat="${point.lat}" lon="${point.lon}"><time>${new Date(point.at_ms).toISOString()}</time><extensions>${extensions}</extensions></trkpt>`;
        previous = point;
    }
    if (segment) segments.push(segment);
    const name = history.truncated ? 'Boat track - loaded partial window' : 'Boat track - requested window';
    const description = `Requested ${new Date(history.from).toISOString()} to ${new Date(history.to).toISOString()}; ${history.points.length} logged fixes; ${history.truncated ? 'PARTIAL: remaining data is not included' : 'complete selected snapshot window'}. Missing measurements are omitted.`;
    return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Thalassa" xmlns="http://www.topografix.com/GPX/1/1" xmlns:thalassa="urn:thalassa:track:1"><metadata><name>${xml(name)}</name><desc>${xml(description)}</desc></metadata><trk><name>${xml(name)}</name>${segments.map((part) => `<trkseg>${part}</trkseg>`).join('')}</trk></gpx>`;
}
