/** Display-only reference data. Colour is not permission, capacity or availability. */
export type ReferenceKind = 'mooring' | 'anchorage';
export type MooringColourFilter = 'all' | 'blue-white' | 'blue' | 'white';
export interface CruisingPoint {
    id: string;
    kind: ReferenceKind;
    name: string;
    lon: number;
    lat: number;
    colours: string[];
    band: string | null;
    mooringClass: string | null;
    access: string;
    notes: string;
    source: 'QPWS' | 'OpenStreetMap';
    sourceUrl: string;
    retrievedAt: string;
    approximate: boolean;
    /** Normalized reported restrictions. Absent in legacy caches whose parser
     * did not preserve anchoring/access tags; [] does not establish permission. */
    restrictionNotes?: string[];
    /** Exact-point coastline model, optional; never borrowed from a nearby bay. */
    fetchLandNM?: number[];
}
export interface ReferenceBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}
export interface ReferenceTile extends ReferenceBounds {
    key: string;
}
const COLOURS = new Set(['blue', 'white', 'red', 'green', 'yellow', 'orange', 'black', 'brown', 'grey']);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 600) : '');
export function colourNames(value: unknown): string[] {
    return [
        ...new Set(
            str(value)
                .toLowerCase()
                .replace(/gray/g, 'grey')
                .split(/[;,]/)
                .map((s) => s.trim())
                .filter((s) => COLOURS.has(s)),
        ),
    ];
}
export function matchesMooringColour(point: CruisingPoint, filter: MooringColourFilter): boolean {
    return (
        filter === 'all' ||
        point.colours.some((c) => (filter === 'blue-white' ? c === 'blue' || c === 'white' : c === filter))
    );
}
export function validReferencePosition(lon: unknown, lat: unknown): boolean {
    return (
        typeof lon === 'number' &&
        typeof lat === 'number' &&
        Number.isFinite(lon) &&
        Number.isFinite(lat) &&
        Math.abs(lon) <= 180 &&
        Math.abs(lat) <= 85
    );
}
export function validCachedReference(value: unknown): value is CruisingPoint {
    const p = value as CruisingPoint;
    return (
        !!p &&
        (p.kind === 'mooring' || p.kind === 'anchorage') &&
        p.source === 'OpenStreetMap' &&
        validReferencePosition(p.lon, p.lat) &&
        Array.isArray(p.colours) &&
        p.colours.length <= 9 &&
        p.colours.every((c) => COLOURS.has(c)) &&
        [p.id, p.name, p.access, p.notes, p.sourceUrl, p.retrievedAt].every(
            (v) => typeof v === 'string' && v.length <= 2000,
        ) &&
        Number.isFinite(Date.parse(p.retrievedAt)) &&
        typeof p.approximate === 'boolean' &&
        (p.restrictionNotes === undefined ||
            (Array.isArray(p.restrictionNotes) &&
                p.restrictionNotes.length <= 20 &&
                p.restrictionNotes.every(
                    (note) => typeof note === 'string' && note.length > 0 && note.length <= 1000,
                ))) &&
        p.band === null &&
        p.mooringClass === null
    );
}

/** Coarse one-degree cells: never send a boat's precise position. Bound queries
 * at wide zooms and split the antimeridian rather than querying the whole world. */
export function referenceTiles(bounds: ReferenceBounds, zoom: number): ReferenceTile[] {
    const { west, east, south, north } = bounds;
    if (zoom < 9 || ![west, east, south, north].every(Number.isFinite) || north < south || north - south > 4) return [];
    const span = east < west ? east + 360 - west : east - west;
    if (span < 0 || span > 6 || south < -85 || north > 85) return [];
    const tiles: ReferenceTile[] = [];
    for (let s = Math.floor(south); s <= Math.floor(north); s++) {
        for (let rawW = Math.floor(west); rawW <= Math.floor(west + span); rawW++) {
            const w = ((((rawW + 180) % 360) + 360) % 360) - 180;
            tiles.push({ key: `${s}:${w}`, west: w, south: s, east: w + 1, north: s + 1 });
            if (tiles.length > 8) return [];
        }
    }
    return tiles;
}

export function referenceQuery(tile: ReferenceTile): string {
    const bbox = `${tile.south},${tile.west},${tile.north},${tile.east}`;
    return `[out:json][timeout:20];(nwr["seamark:type"="mooring"](${bbox});nwr["mooring"="buoy"](${bbox});nwr["seamark:buoy_special_purpose:category"="mooring"](${bbox});nwr["seamark:type"~"^(anchorage|anchor_berth)$"](${bbox}););out center 3001;`;
}

function osmRestrictionNotes(tags: Record<string, string>): string[] {
    const notes: string[] = [];
    for (const key of [
        'access',
        'boat',
        'motorboat',
        'sailboat',
        'seamark:anchorage:access',
        'seamark:mooring:access',
    ]) {
        const value = str(tags[key]);
        if (
            /(?:^|[;,\s])(?:no|private|restricted|military|customers|permit|permission|destination)(?:$|[;,\s_])/i.test(
                value,
            )
        )
            notes.push(`Access restriction reported: ${key}=${value}`);
    }
    for (const key of ['anchoring', 'anchorage']) {
        const value = str(tags[key]);
        if (/^(?:no|prohibited|forbidden|restricted)$/i.test(value))
            notes.push(`Anchoring restriction reported: ${key}=${value}`);
    }
    for (const key of [
        'seamark:anchorage:restriction',
        'seamark:restriction',
        'seamark:restricted_area:restriction',
        'access:conditional',
        'boat:conditional',
        'motorboat:conditional',
        'sailboat:conditional',
        'anchoring:conditional',
    ]) {
        const value = str(tags[key]);
        if (value && !/^(?:none|unrestricted)$/i.test(value)) notes.push(`Restriction reported: ${key}=${value}`);
    }
    return notes;
}

export function parseOsmReferences(body: unknown, retrievedAt: string): CruisingPoint[] {
    const payload = body as { elements?: unknown[]; remark?: unknown };
    if (!payload || !Array.isArray(payload.elements) || payload.remark || payload.elements.length >= 3001) {
        throw new Error('Incomplete reference response');
    }
    return payload.elements.flatMap((raw) => {
        const e = raw as {
            id?: unknown;
            type?: unknown;
            lat?: number;
            lon?: number;
            center?: { lat?: number; lon?: number };
            tags?: Record<string, string>;
        };
        if (!e || !['node', 'way', 'relation'].includes(String(e.type)) || !Number.isSafeInteger(e.id) || !e.tags)
            return [];
        const lat = e.lat ?? e.center?.lat,
            lon = e.lon ?? e.center?.lon;
        if (!validReferencePosition(lon, lat)) return [];
        const t = e.tags;
        const anchor = ['anchorage', 'anchor_berth'].includes(t['seamark:type']);
        const category = t['seamark:mooring:category'];
        // A bollard, pile, dolphin or reef-protection buoy is NOT a pick-up buoy.
        const mooring =
            t.mooring === 'buoy' ||
            t['seamark:buoy_special_purpose:category'] === 'mooring' ||
            (t['seamark:type'] === 'mooring' && (!category || category === 'buoy'));
        if (!anchor && !mooring) return [];
        const kind = anchor ? 'anchorage' : 'mooring';
        const access = str(t.access || t[anchor ? 'seamark:anchorage:access' : 'seamark:mooring:access']);
        return [
            {
                id: `osm-${e.type}${e.id}`,
                kind,
                lon: lon!,
                lat: lat!,
                name: str(t.name || t['seamark:name']) || (anchor ? 'Mapped anchorage' : 'Mapped mooring'),
                colours: colourNames(
                    t['seamark:mooring:colour'] || t['seamark:buoy_special_purpose:colour'] || t.colour,
                ),
                band: null,
                mooringClass: null,
                access: access || 'Unknown — check permission',
                notes: [
                    str(t.description),
                    str(t['seamark:information']),
                    t.fee === 'yes' ? 'Fee reported' : '',
                    str(t.maxstay) ? `Maximum stay reported: ${str(t.maxstay)}` : '',
                ]
                    .filter(Boolean)
                    .join(' · '),
                source: 'OpenStreetMap',
                sourceUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
                retrievedAt,
                approximate: e.type !== 'node',
                restrictionNotes: osmRestrictionNotes(t),
            } as CruisingPoint,
        ];
    });
}

// ── Named places (131-PYD-10) ──────────────────────────────────

/** A name on the map for Plan Your Day outside the Queensland atlas: a bay
 *  it can suggest, or a marina or settlement that names the start. */
export type NamedPlaceKind = 'bay' | 'marina' | 'city' | 'town' | 'village' | 'hamlet';
export interface NamedPlace {
    id: string;
    kind: NamedPlaceKind;
    name: string;
    lat: number;
    lon: number;
}
const SETTLEMENTS: readonly NamedPlaceKind[] = ['city', 'town', 'village', 'hamlet'];
const NAMED_KINDS: readonly NamedPlaceKind[] = ['bay', 'marina', ...SETTLEMENTS];
/** A cell with more names than this is cut short by Overpass: refused, never cached as complete. */
export const NAMED_PLACES_MAX = 5000;

/** The bays and marinas the Queensland atlas is built from (scripts/anchorages/build-qld.mjs), and the
 *  settlements, in one coarse cell. Names only, centres for ways. */
export function namedPlacesQuery(tile: ReferenceTile): string {
    const bbox = `${tile.south},${tile.west},${tile.north},${tile.east}`;
    return `[out:json][timeout:20];(nw["natural"="bay"]["name"](${bbox});nw["leisure"="marina"]["name"](${bbox});node["place"~"^(city|town|village|hamlet)$"]["name"](${bbox}););out tags center ${NAMED_PLACES_MAX + 1};`;
}

export function validNamedPlace(value: unknown): value is NamedPlace {
    const p = value as NamedPlace;
    return (
        !!p &&
        NAMED_KINDS.includes(p.kind) &&
        typeof p.id === 'string' &&
        /^osm-(?:node|way)[1-9]\d*$/.test(p.id) &&
        typeof p.name === 'string' &&
        p.name.length > 0 &&
        p.name.length <= 120 &&
        validReferencePosition(p.lon, p.lat)
    );
}

export function parseNamedPlaces(body: unknown): NamedPlace[] {
    const payload = body as { elements?: unknown[]; remark?: unknown };
    if (!payload || !Array.isArray(payload.elements) || payload.remark || payload.elements.length > NAMED_PLACES_MAX)
        throw new Error('Incomplete named places response');
    return payload.elements.flatMap((raw) => {
        const e = raw as {
            id?: unknown;
            type?: unknown;
            lat?: number;
            lon?: number;
            center?: { lat?: number; lon?: number };
            tags?: Record<string, string>;
        };
        if (!e?.tags || (e.type !== 'node' && e.type !== 'way') || !Number.isSafeInteger(e.id)) return [];
        const t = e.tags;
        const kind: NamedPlaceKind | null =
            t.natural === 'bay'
                ? 'bay'
                : t.leisure === 'marina'
                  ? 'marina'
                  : SETTLEMENTS.includes(t.place as NamedPlaceKind)
                    ? (t.place as NamedPlaceKind)
                    : null;
        // Rounded to about a metre: the cache holds thousands of them.
        const lat = Math.round((e.lat ?? e.center?.lat ?? NaN) * 1e5) / 1e5;
        const lon = Math.round((e.lon ?? e.center?.lon ?? NaN) * 1e5) / 1e5;
        const point = { id: `osm-${e.type}${e.id}`, kind, name: str(t.name).slice(0, 120), lat, lon };
        return kind && validNamedPlace(point) ? [point] : [];
    });
}

export const QPWS_URL =
    'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Environment/ParksMarineMoorings/FeatureServer/20';
const QPWS_BANDS: Record<string, string> = { T: 'brown', A: 'yellow', B: 'green', C: 'blue', D: 'red' };
export function parseQpwsReferences(body: unknown, retrievedAt: string): CruisingPoint[] {
    const fc = body as {
        features?: GeoJSON.Feature[];
        exceededTransferLimit?: boolean;
        properties?: { exceededTransferLimit?: boolean };
    };
    if (!fc || !Array.isArray(fc.features) || fc.exceededTransferLimit || fc.properties?.exceededTransferLimit)
        throw new Error('Incomplete QPWS reference');
    return fc.features.flatMap((f) => {
        if (f?.geometry?.type !== 'Point' || !f.properties) return [];
        const [lon, lat] = f.geometry.coordinates;
        if (!validReferencePosition(lon, lat)) return [];
        const p = f.properties;
        if (!Number.isSafeInteger(p.objectid)) return [];
        const cls = str(p.mooring_class).toUpperCase();
        return [
            {
                id: `qpws-${p.objectid}`,
                kind: 'mooring',
                name: str(p.site_and_mooring_reference_numb || p.site) || 'QPWS public mooring',
                lon,
                lat,
                colours: ['blue'],
                band: QPWS_BANDS[cls] ?? null,
                mooringClass: QPWS_BANDS[cls] ? cls : null,
                access: 'Public — conditions apply',
                notes: 'Check the buoy tag for vessel type/length, wind limit, time limit and condition. No live availability information.',
                source: 'QPWS',
                sourceUrl: QPWS_URL,
                retrievedAt,
                approximate: false,
            } as CruisingPoint,
        ];
    });
}

/** Only merge a near-exact duplicate with the SAME name. Nearby private and
 * public buoys must not disappear or inherit each other's access/colours. */
export function mergeMooringReferences(official: CruisingPoint[], osm: CruisingPoint[]): CruisingPoint[] {
    return [
        ...official,
        ...osm.filter(
            (p) =>
                p.kind !== 'mooring' ||
                !official.some(
                    (o) =>
                        p.name.trim().toLowerCase() === o.name.trim().toLowerCase() &&
                        Math.hypot(
                            (p.lat - o.lat) * 111_320,
                            (p.lon - o.lon) * 111_320 * Math.cos((p.lat * Math.PI) / 180),
                        ) < 10,
                ),
        ),
    ];
}
