/** Fixed small query families. No arbitrary QL, URL, historical user data or
 * query-wide inventory can cross the app/Edge boundary. OSM remains community
 * reference data; a qualified database cohort does not qualify depth/navigation.
 */
export type OwnedOsmKind = 'overlay' | 'seamarks' | 'references' | 'names' | 'coastline' | 'pilotage' | 'nodes';
export interface OwnedOsmRequest {
    schema: 1;
    kind: OwnedOsmKind;
    /** Overpass order: south, west, north, east; antimeridian is split upstream. */
    bbox: [number, number, number, number];
}
export const OWN_OSM_MAX_BYTES = 20_000_000;
export const OWN_OSM_MAX_ELEMENTS = 25_000;
export const OWN_OSM_MAX_SOURCE_AGE_MS = 45 * 86400_000;
const seamarks =
    'buoy_lateral|buoy_cardinal|buoy_isolated_danger|buoy_safe_water|buoy_special_purpose|buoy_installation|beacon_lateral|beacon_cardinal|beacon_isolated_danger|beacon_safe_water|beacon_special_purpose|light|light_major|light_minor|light_vessel|light_float|anchorage|anchor_berth|harbour|mooring|restricted_area|cable_submarine|pipeline_submarine|separation_zone|fairway|recommended_track|pilot_boarding|signal_station_traffic|signal_station_warning|coastguard_station|rescue_station';
const overlayTags = [
    ['way', 'natural', 'water'],
    ['relation', 'natural', 'water'],
    ['way', 'natural', 'reef'],
    ['relation', 'natural', 'reef'],
    ['way', 'natural', 'coastline'],
    ['way', 'leisure', 'marina'],
    ['relation', 'leisure', 'marina'],
    ['way', 'man_made', 'breakwater'],
    ['way', 'waterway', '^(canal|fairway|dock|river|riverbank)$', '~'],
    ['way', 'aeroway', '^(aerodrome|runway|taxiway|apron)$', '~'],
    ['relation', 'aeroway', '^(aerodrome|runway|taxiway|apron)$', '~'],
    ['way', 'seamark:type', 'navigation_line'],
    ['way', 'man_made', '^(pier|pontoon)$', '~'],
    ['way', 'floating', 'yes'],
];
const clause = (type: string, key: string, value: string, comparison = '=') =>
    `${type}["${key}"${comparison}"${value}"](@BBOX);`;
const templates: Record<OwnedOsmKind, string> = {
    overlay:
        '[out:json][timeout:30];(' + overlayTags.map(([t, k, v, c]) => clause(t, k, v, c)).join('') + ');out geom;',
    seamarks: '[out:json][timeout:30];(' + clause('nwr', 'seamark:type', seamarks, '~') + ');out center 3000;',
    references:
        '[out:json][timeout:20];(' +
        clause('nwr', 'seamark:type', 'mooring') +
        clause('nwr', 'mooring', 'buoy') +
        clause('nwr', 'seamark:buoy_special_purpose:category', 'mooring') +
        clause('nwr', 'seamark:type', '^(anchorage|anchor_berth)$', '~') +
        ');out center 3001;',
    names:
        '[out:json][timeout:25];(' +
        clause('nw', 'natural', 'bay') +
        clause('nw', 'leisure', 'marina') +
        ');out tags center 2001;(' +
        ['city', 'town', 'village'].map((k) => clause('node', 'place', k)).join('') +
        ');out tags center 1001;',
    coastline: '[out:json][timeout:25];' + clause('way', 'natural', 'coastline') + 'out geom;',
    pilotage:
        '[out:json][timeout:25];(' +
        ['node', 'way', 'relation'].map((t) => `${t}["seamark:type"](@BBOX);`).join('') +
        ');out geom;',
    nodes: '[out:json][timeout:25];(node["seamark:type"](@BBOX););out body;',
};

/** Strip only unquoted whitespace; quoted values and escapes retain identity. */
function compact(query: string): string {
    let quoted = false,
        escaped = false,
        out = '';
    for (const character of query) {
        if (quoted) {
            out += character;
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
        } else if (character === '"') {
            quoted = true;
            out += character;
        } else if (!/\s/.test(character)) out += character;
    }
    if (quoted || escaped) throw new Error('Unclosed OSM query string');
    return out;
}

export function parseOwnedOsmRequest(value: unknown): OwnedOsmRequest | null {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (
        row.schema !== 1 ||
        typeof row.kind !== 'string' ||
        !Object.hasOwn(templates, row.kind) ||
        !Array.isArray(row.bbox) ||
        row.bbox.length !== 4 ||
        !row.bbox.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
        Object.keys(row).some((k) => !['schema', 'kind', 'bbox'].includes(k))
    )
        return null;
    const [s, w, n, e] = row.bbox as number[];
    const maximumSpan = ['seamarks', 'pilotage', 'nodes'].includes(row.kind)
        ? 9
        : row.kind === 'coastline'
          ? 25
          : row.kind === 'overlay'
            ? 6
            : 1.01;
    if (s < -85 || n > 85 || w < -180 || e > 180 || s >= n || w >= e || n - s > maximumSpan || e - w > maximumSpan)
        return null;
    if (
        ['references', 'names'].includes(row.kind) &&
        (n - s !== 1 || e - w !== 1 || !Number.isInteger(s) || !Number.isInteger(w))
    )
        return null;
    return { schema: 1, kind: row.kind as OwnedOsmKind, bbox: [s, w, n, e] };
}

export function queryForOwnedOsm(input: OwnedOsmRequest, sentinel = false): string {
    const admitted = parseOwnedOsmRequest(input);
    if (!admitted) throw new Error('OSM operation/bounds refused');
    const query = templates[admitted.kind].replaceAll('@BBOX', admitted.bbox.join(','));
    return sentinel && admitted.kind === 'seamarks' ? query.replace('out center 3000;', 'out center 3001;') : query;
}

/** Adapt only our existing exact recipes; QL is never accepted by the public Edge. */
export function ownedOperationForQuery(query: string): OwnedOsmRequest {
    if (typeof query !== 'string' || query.length > 8192) throw new Error('OSM query size refused');
    const source = compact(query);
    const number = '-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
    const pattern = new RegExp('\\((' + [number, number, number, number].join(',') + ')\\)', 'g');
    let bbox: number[] | undefined;
    const signature = source.replace(pattern, (_whole, coordinates: string) => {
        const next = coordinates.split(',').map(Number);
        if (bbox && bbox.some((n, i) => n !== next[i])) throw new Error('Mixed OSM query boxes refused');
        bbox = next;
        return '(@BBOX)';
    });
    const kind = (Object.keys(templates) as OwnedOsmKind[]).find((k) => compact(templates[k]) === signature);
    const admitted = parseOwnedOsmRequest({ schema: 1, kind, bbox });
    if (!admitted) throw new Error('Unknown OSM query recipe refused');
    return admitted;
}

export interface OwnedOsmElement {
    type: 'node' | 'way' | 'relation';
    id: number;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
    geometry?: { lat: number; lon: number }[];
    bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
    members?: unknown[];
}
export interface OwnedOsmDocument {
    elements: OwnedOsmElement[];
    /** Completeness of this bounded selection, separate from full DB admission. */
    queryComplete: boolean;
    osm3s: { timestamp_osm_base: string };
    thalassaSource: { schema: 1; complete: true; cohortSha256: string; licence: 'ODbL-1.0'; sourceAt: string };
}

/** An empty answer is qualified only by a complete current private database
 * cohort and the original database clock, never by HTTP200/receipt time alone. */
export function parseOwnedOsmDocument(value: unknown, operation: OwnedOsmRequest, now = Date.now()): OwnedOsmDocument {
    const admitted = parseOwnedOsmRequest(operation);
    if (!admitted || !value || typeof value !== 'object') throw new Error('Invalid owned OSM document');
    const row = value as Record<string, unknown>;
    const source = row.thalassaSource as OwnedOsmDocument['thalassaSource'] | undefined;
    const osm = row.osm3s as OwnedOsmDocument['osm3s'] | undefined;
    const clock = Date.parse(source?.sourceAt ?? '');
    if (
        !source ||
        source.schema !== 1 ||
        source.complete !== true ||
        source.licence !== 'ODbL-1.0' ||
        typeof source.cohortSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(source.cohortSha256) ||
        !Number.isFinite(clock) ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.000)?Z$/.test(source.sourceAt) ||
        new Date(clock).toISOString().replace('.000Z', 'Z') !== source.sourceAt.replace('.000Z', 'Z') ||
        clock > now + 300_000 ||
        now - clock > OWN_OSM_MAX_SOURCE_AGE_MS ||
        osm?.timestamp_osm_base !== source.sourceAt ||
        (row.remark !== undefined && row.remark !== '') ||
        !Array.isArray(row.elements) ||
        row.elements.length > OWN_OSM_MAX_ELEMENTS
    )
        throw new Error('Unqualified owned OSM cohort');
    const elements = row.elements as Record<string, unknown>[];
    let points = 0;
    const position = (value: unknown): boolean => {
        if (!value || typeof value !== 'object') return false;
        const p = value as Record<string, unknown>;
        return (
            typeof p.lat === 'number' &&
            typeof p.lon === 'number' &&
            Number.isFinite(p.lat) &&
            Number.isFinite(p.lon) &&
            Math.abs(p.lat) <= 90 &&
            Math.abs(p.lon) <= 180
        );
    };
    const geometry = (value: unknown): boolean =>
        value === undefined || (Array.isArray(value) && (points += value.length) <= 1_000_000 && value.every(position));
    for (const el of elements) {
        if (
            !el ||
            typeof el !== 'object' ||
            !['node', 'way', 'relation'].includes(String(el.type)) ||
            !Number.isSafeInteger(el.id) ||
            Number(el.id) <= 0 ||
            ((el.lat !== undefined || el.lon !== undefined) && !position(el)) ||
            (el.center !== undefined && !position(el.center)) ||
            !geometry(el.geometry)
        )
            throw new Error('Invalid original OSM element');
        if (
            el.tags !== undefined &&
            (!el.tags ||
                typeof el.tags !== 'object' ||
                Array.isArray(el.tags) ||
                Object.entries(el.tags).length > 256 ||
                Object.entries(el.tags).some(([k, v]) => k.length > 256 || typeof v !== 'string' || v.length > 4096))
        )
            throw new Error('Invalid OSM tags');
        if (el.bounds !== undefined) {
            const b = el.bounds as Record<string, unknown>;
            if (
                !b ||
                typeof b !== 'object' ||
                !position({ lat: b.minlat, lon: b.minlon }) ||
                !position({ lat: b.maxlat, lon: b.maxlon })
            )
                throw new Error('Invalid OSM bounds');
        }
        if (
            el.members !== undefined &&
            (!Array.isArray(el.members) ||
                el.members.length > 25000 ||
                el.members.some((m) => !m || typeof m !== 'object' || !geometry(m.geometry)))
        )
            throw new Error('Invalid OSM relation geometry');
    }
    let queryComplete = true;
    if (admitted.kind === 'seamarks' || admitted.kind === 'references') {
        if (elements.length > 3001) throw new Error('OSM selection exceeds sentinel bound');
        queryComplete = elements.length <= 3000;
    }
    if (admitted.kind === 'nodes' && elements.length > 5000) throw new Error('Seamark inventory exceeds bound');
    if (admitted.kind === 'names') {
        const water = elements.filter((el) => {
            const tags = el.tags as Record<string, unknown> | undefined;
            return tags?.natural === 'bay' || tags?.leisure === 'marina';
        }).length;
        if (elements.length > 3002) throw new Error('OSM names exceed sentinel bound');
        queryComplete = water <= 2000 && elements.length - water <= 1000;
    }
    return {
        elements: elements as unknown as OwnedOsmElement[],
        queryComplete,
        osm3s: { timestamp_osm_base: source.sourceAt },
        thalassaSource: {
            schema: 1,
            complete: true,
            licence: 'ODbL-1.0',
            sourceAt: source.sourceAt,
            cohortSha256: source.cohortSha256,
        },
    };
}
