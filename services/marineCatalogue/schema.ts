/** Public gazetteer/reference records only. Never accepts chart meshes or boat positions. */
export type CatalogueDataset = 'places' | 'osm' | 'noaa' | 'facilities';
export type CatalogueKind =
    | 'island'
    | 'bay'
    | 'cove'
    | 'harbour'
    | 'reef'
    | 'headland'
    | 'anchorage'
    | 'mooring'
    | 'marina'
    | 'fuel';
export interface MarinePlace {
    id: string;
    name: string;
    kind: CatalogueKind;
    lat: number;
    lon: number;
    country: string;
    aliases: string[];
    approximate: boolean;
    access?: string;
    restrictions?: string[];
    colours?: string[];
    /** Only admitted from the exact point's optional public coastline model. */
    fetchLandNM?: number[];
    /** Only in the opt-in facilities dataset; one source object may offer both. */
    facilityKinds?: ('marina' | 'fuel')[];
}
export interface CatalogueManifest {
    schema: 1;
    dataset: CatalogueDataset;
    generation: string;
    builtAt: string;
    sourceAt: string;
    count: number;
    /** Explicit source coverage, not a claim of complete anchorage knowledge. */
    coverage: string;
    licence: string;
    sourceUrl: string;
    /** Complete inventory of nonempty immutable shards. Missing key means known empty. */
    shards: string[];
    agreementSha256?: string;
    /** Facilities preserve the cumulative inventory of stable regional extracts. */
    cohorts?: { id: string; sourceAt: string; sha256: string }[];
}
export interface CatalogueShard {
    schema: 1;
    dataset: CatalogueDataset;
    generation: string;
    key: string;
    records: MarinePlace[];
}
function sourceClock(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
    const at = Date.parse(value);
    return Number.isFinite(at) && new Date(at).toISOString().replace('.000Z', 'Z') === value;
}
export const CATALOGUE_BASE = 'https://tiles.thalassatiles.com/marine-catalogue/v1';
export const SHARD_MAX_BYTES = 2 * 1024 * 1024;
export const CACHE_MAX_BYTES = 24 * 1024 * 1024;
export const CACHE_MAX_ENTRIES = 96;
export const LICENCES = {
    places: { label: 'GeoNames · CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    osm: { label: '© OpenStreetMap contributors · ODbL', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
    facilities: { label: '© OpenStreetMap contributors · ODbL', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
    noaa: {
        label: 'NOAA-derived reference · not official ENC',
        url: 'https://charts.noaa.gov/ENCs/ENC_Agreement.shtml',
    },
} as const;
export const normaliseName = (text: string) =>
    text
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
/** Three Unicode letters/numbers: no user text or coordinates in request URLs. */
export function namePrefix(text: string): string | null {
    const chars = Array.from(normaliseName(text).replace(/ /g, ''));
    return chars.length < 3
        ? null
        : chars
              .slice(0, 3)
              .map((c) => c.codePointAt(0)!.toString(16))
              .join('-');
}
export function validPosition(lat: unknown, lon: unknown): lat is number {
    return (
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180
    );
}
export function areaKey(lat: number, lon: number): string {
    if (!validPosition(lat, lon)) throw new Error('Invalid catalogue point');
    return `${Math.min(89, Math.floor((lat + 90) / 2))}_${Math.floor(((((lon + 180) % 360) + 360) % 360) / 2)}`;
}
/** A 50 NM area, including the date line. Refuse very wide polar fan-outs. */
export function nearbyAreaKeys(lat: number, lon: number, radiusNM = 50): string[] {
    if (!validPosition(lat, lon) || radiusNM <= 0 || radiusNM > 50) throw new Error('Choose an area within 50 NM');
    const dy = radiusNM / 60;
    const dx = Math.min(180, dy / Math.max(0.001, Math.cos((lat * Math.PI) / 180)));
    const keys = new Set<string>();
    for (let y = Math.max(-90, Math.floor((lat - dy) / 2) * 2); y <= Math.min(90, lat + dy); y += 2) {
        for (let x = Math.floor((lon - dx) / 2) * 2; x <= lon + dx; x += 2) {
            keys.add(areaKey(y, ((((x + 180) % 360) + 360) % 360) - 180));
            if (keys.size > 16) throw new Error('This polar area is too wide; choose a smaller area');
        }
    }
    return [...keys];
}
export function cataloguePath(path: string): boolean {
    return /^(places|osm|noaa|facilities)\/(?:manifest\.json|[a-z0-9-]{8,48}\/(?:areas\/(?:[0-8]?\d)_(?:1[0-7]\d|[0-9]?\d)(?:-[0-3]{1,8})?|names\/(?:[a-f0-9]{1,6}-){2,23}[a-f0-9]{1,6}(?:-end)?)\.json)$/.test(
        path,
    );
}
/** Quadrants are SW=0, SE=1, NW=2, NE=3, at most eight refinements. */
export function areaShardBounds(key: string): [number, number, number, number] {
    if (!/^areas\/(?:[0-8]?\d)_(?:1[0-7]\d|[0-9]?\d)(?:-[0-3]{1,8})?$/.test(key)) throw new Error('Invalid area leaf');
    const [base, quadrants = ''] = key.slice(6).split('-');
    const [row, column] = base.split('_').map(Number);
    let south = row * 2 - 90,
        west = column * 2 - 180,
        width = 2;
    for (const digit of quadrants) {
        width /= 2;
        const quadrant = Number(digit);
        if (quadrant & 1) west += width;
        if (quadrant & 2) south += width;
    }
    return [west, south, west + width, south + width];
}
/** All published leaves for selected public root cells, nearest leaves first locally. */
export function areaSearchKeys(
    m: CatalogueManifest,
    roots: readonly string[],
    near?: { lat: number; lon: number },
): string[] {
    const wanted = new Set(roots);
    const distance = (key: string) => {
        if (!near) return 0;
        const [w, s, e, n] = areaShardBounds(key);
        const dx =
            ((((((w + e) / 2 - near.lon + 180) % 360) + 360) % 360) - 180) * Math.cos((near.lat * Math.PI) / 180);
        return dx * dx + ((s + n) / 2 - near.lat) ** 2;
    };
    return m.shards
        .filter((key) => key.startsWith('areas/') && wanted.has(key.slice(6).split('-')[0]))
        .sort((a, b) => distance(a) - distance(b) || a.localeCompare(b));
}
/** Dense prefixes split into smaller immutable leaves. Never scan every world name. */
export function nameSearchKeys(m: CatalogueManifest, query: string): string[] {
    const q = normaliseName(query).replace(/ /g, '');
    return m.shards.filter((key) => {
        if (!key.startsWith('names/')) return false;
        const terminal = key.endsWith('-end');
        try {
            const value = String.fromCodePoint(
                ...key
                    .slice(6)
                    .replace(/-end$/, '')
                    .split('-')
                    .map((s) => Number.parseInt(s, 16)),
            );
            return terminal ? value.startsWith(q) : value.startsWith(q) || q.startsWith(value);
        } catch {
            return false;
        }
    });
}
const string = (v: unknown, max: number) =>
    typeof v === 'string' && v.length > 0 && v.length <= max && !/\p{Cc}/u.test(v);
export function validMarinePlace(p: MarinePlace, dataset: CatalogueDataset): boolean {
    const id =
        dataset === 'places'
            ? /^geonames:[1-9]\d{0,11}$/
            : dataset === 'osm' || dataset === 'facilities'
              ? /^osm-(node|way|relation)[1-9]\d{0,15}$/
              : /^noaa:[a-fA-F0-9]{16}$/;
    return (
        !!p &&
        Object.keys(p).every((k) =>
            [
                'id',
                'name',
                'kind',
                'lat',
                'lon',
                'country',
                'aliases',
                'approximate',
                'access',
                'restrictions',
                'colours',
                'fetchLandNM',
                'facilityKinds',
            ].includes(k),
        ) &&
        id.test(p.id) &&
        string(p.name, 200) &&
        validPosition(p.lat, p.lon) &&
        (dataset === 'facilities'
            ? ['marina', 'fuel'].includes(p.kind) &&
              Array.isArray(p.facilityKinds) &&
              p.facilityKinds.length >= 1 &&
              p.facilityKinds.length <= 2 &&
              new Set(p.facilityKinds).size === p.facilityKinds.length &&
              p.facilityKinds.every((k) => ['marina', 'fuel'].includes(k)) &&
              p.facilityKinds.includes(p.kind as 'marina' | 'fuel')
            : p.facilityKinds === undefined &&
              (dataset === 'places'
                  ? ['island', 'bay', 'cove', 'harbour', 'reef', 'headland', 'anchorage', 'mooring'].includes(p.kind)
                  : ['anchorage', 'mooring'].includes(p.kind))) &&
        typeof p.country === 'string' &&
        /^(?:[A-Z]{2})?$/.test(p.country) &&
        typeof p.approximate === 'boolean' &&
        Array.isArray(p.aliases) &&
        p.aliases.length <= 16 &&
        p.aliases.every((a) => string(a, 200)) &&
        (p.access === undefined || string(p.access, 300)) &&
        (p.restrictions === undefined ||
            (Array.isArray(p.restrictions) &&
                p.restrictions.length <= 12 &&
                p.restrictions.every((s) => string(s, 300)))) &&
        (p.colours === undefined ||
            (Array.isArray(p.colours) &&
                p.colours.length <= 9 &&
                p.colours.every((s) => /^(blue|white|red|green|yellow|orange|black|brown|grey)$/.test(s)))) &&
        (p.fetchLandNM === undefined ||
            (Array.isArray(p.fetchLandNM) &&
                p.fetchLandNM.length === 36 &&
                p.fetchLandNM.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 15)))
    );
}
export function parseManifest(value: unknown, dataset: CatalogueDataset): CatalogueManifest {
    const m = value as CatalogueManifest;
    const source =
        dataset === 'places'
            ? 'https://download.geonames.org/'
            : dataset === 'osm' || dataset === 'facilities'
              ? 'https://download.geofabrik.de/'
              : 'https://www.charts.noaa.gov/';
    if (
        !m ||
        Object.keys(m).some(
            (k) =>
                ![
                    'schema',
                    'dataset',
                    'generation',
                    'builtAt',
                    'sourceAt',
                    'count',
                    'coverage',
                    'licence',
                    'sourceUrl',
                    'shards',
                    'agreementSha256',
                    'cohorts',
                ].includes(k),
        ) ||
        m.schema !== 1 ||
        m.dataset !== dataset ||
        !/^[a-z0-9-]{8,48}$/.test(m.generation) ||
        !Number.isFinite(Date.parse(m.builtAt)) ||
        !Number.isFinite(Date.parse(m.sourceAt)) ||
        Date.parse(m.sourceAt) > Date.now() + 300000 ||
        Date.parse(m.builtAt) > Date.now() + 300000 ||
        !Number.isSafeInteger(m.count) ||
        m.count < 1 ||
        m.count > 2000000 ||
        !string(m.coverage, 300) ||
        m.licence !== LICENCES[dataset].url ||
        typeof m.sourceUrl !== 'string' ||
        !m.sourceUrl.startsWith(source) ||
        !Array.isArray(m.shards) ||
        m.shards.length > 50000 ||
        new Set(m.shards).size !== m.shards.length ||
        !m.shards.every((key) => cataloguePath(`${dataset}/${m.generation}/${key}.json`)) ||
        (dataset === 'facilities'
            ? !Array.isArray(m.cohorts) ||
              m.cohorts.length < 1 ||
              m.cohorts.length > 32 ||
              new Set(m.cohorts.map((v) => v?.id)).size !== m.cohorts.length ||
              !m.cohorts.every(
                  (v) =>
                      v &&
                      Object.keys(v).sort().join(',') === 'id,sha256,sourceAt' &&
                      typeof v.id === 'string' &&
                      /^https:\/\/download\.geofabrik\.de\/[a-z0-9/_-]+$/.test(v.id) &&
                      sourceClock(v.sourceAt) &&
                      Date.parse(v.sourceAt) <= Date.parse(m.builtAt) &&
                      /^[a-f0-9]{64}$/.test(v.sha256),
              ) ||
              m.sourceAt !== [...m.cohorts].map((v) => v.sourceAt).sort()[0]
            : m.cohorts !== undefined) ||
        (dataset === 'noaa' ? !/^[a-f0-9]{64}$/.test(m.agreementSha256 ?? '') : m.agreementSha256 !== undefined)
    )
        throw new Error('Invalid catalogue manifest');
    return m;
}
export function parseShard(value: unknown, m: CatalogueManifest, key: string): MarinePlace[] {
    const s = value as CatalogueShard;
    if (
        !s ||
        Object.keys(s).some((k) => !['schema', 'dataset', 'generation', 'key', 'records'].includes(k)) ||
        s.schema !== 1 ||
        s.dataset !== m.dataset ||
        s.generation !== m.generation ||
        s.key !== key ||
        !Array.isArray(s.records) ||
        s.records.length > 10000 ||
        !s.records.every((p) => validMarinePlace(p, m.dataset))
    )
        throw new Error('Invalid catalogue shard');
    const ids = new Set<string>();
    const bounds = key.startsWith('areas/') ? areaShardBounds(key) : null;
    for (const p of s.records) {
        const lon = ((((p.lon + 180) % 360) + 360) % 360) - 180;
        if (
            ids.has(p.id) ||
            (bounds &&
                (areaKey(p.lat, p.lon) !== key.slice(6).split('-')[0] ||
                    lon < bounds[0] ||
                    lon >= bounds[2] ||
                    p.lat < bounds[1] ||
                    (bounds[3] === 90 ? p.lat > 90 : p.lat >= bounds[3])))
        )
            throw new Error('Wrong catalogue area or duplicate identity');
        ids.add(p.id);
    }
    return s.records;
}
export function placeSourceUrl(p: MarinePlace): string {
    return p.id.startsWith('geonames:')
        ? `https://www.geonames.org/${p.id.slice(9)}/`
        : p.id.startsWith('osm-')
          ? `https://www.openstreetmap.org/${p.id.slice(4).replace(/^(node|way|relation)/, '$1/')}`
          : 'https://charts.noaa.gov/ENCs/';
}
