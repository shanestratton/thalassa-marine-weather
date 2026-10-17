import { aromeDomain, AROME_MAX_SOURCE_AGE_MS, AROME_STEP_DEGREES, type AromeModelId } from './aromeDomains.ts';
import { AROME_HOURLY_UNITS, parseAromePoint, type AromePointForecast } from './aromePointContract.ts';

/** Immutable owned storage, independent of wx's private inbound network.
 * No provider URL, user URL, token or coarse wx point table is a fallback.
 */
export const AROME_STATIC_ORIGIN = 'https://tiles.thalassatiles.com/regional/arome/v1';
export const AROME_SLOT_BYTES = 4096;
export const AROME_MANIFEST_BYTES = 256 * 1024;
export const AROME_TILE_BYTES = 3 * 1024 * 1024;
export const AROME_TILE_CORE = 32;
export const AROME_TILE_HALO = 3;
export const AROME_STATIC_FIELDS = ['u10', 'v10', 'msl', 't2m', 'rh2m'] as const;
export const AROME_STATIC_UNITS = ['m/s', 'm/s', 'Pa', 'K', '%'] as const;
export const AROME_BINARY_MAGIC = 'THAROME1';

export interface AromeSlot {
    schema: 1;
    model: AromeModelId;
    runUtc: string;
    manifestSha256: string;
    manifestBytes: number;
}
export interface AromeTile {
    id: string;
    i0: number;
    j0: number;
    width: number;
    height: number;
    sha256: string;
    rawSha256: string;
    bytes: number;
    rawBytes: number;
}
export interface AromeStaticManifest {
    schema: 1;
    model: AromeModelId;
    runUtc: string;
    provider: 'Météo-France';
    product: 'AROME-OM';
    licence: 'Etalab-2.0';
    width: number;
    height: number;
    stepDegrees: 0.025;
    bounds: readonly number[];
    hours: 49;
    fields: typeof AROME_STATIC_FIELDS;
    units: typeof AROME_STATIC_UNITS;
    encoding: 'gzip-f64le-v1';
    core: 32;
    halo: 3;
    maskSha256: string;
    nativeProofSha256: string;
    catalogueSha256: string;
    packets: { offsetHours: number; sha256: string; bytes: number }[];
    tiles: AromeTile[];
}

const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
export const aromeHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, low: number, high: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;
const equalArray = (value: unknown, expected: readonly unknown[]) =>
    Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);

export function aromeRunCurrent(value: unknown, model: string, now: number): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:00|06|12|18):00:00Z$/.test(value)) return false;
    const run = Date.parse(value);
    return (
        aromeDomain(model) !== undefined &&
        Number.isFinite(now) &&
        Number.isFinite(run) &&
        new Date(run).toISOString() === value.replace('Z', '.000Z') &&
        run <= now &&
        now - run <= AROME_MAX_SOURCE_AGE_MS &&
        (model !== 'thalassa_arome_om_polyn_025' || /T(?:00|12):/.test(value))
    );
}

export function parseAromeSlot(value: unknown, model: string, now: number): AromeSlot | null {
    return record(value) &&
        value.schema === 1 &&
        value.model === model &&
        aromeRunCurrent(value.runUtc, model, now) &&
        aromeHash(value.manifestSha256) &&
        integer(value.manifestBytes, 1, AROME_MANIFEST_BYTES)
        ? (value as unknown as AromeSlot)
        : null;
}

export function aromeTileShape(model: string, x: number, y: number) {
    const domain = aromeDomain(model);
    if (
        !domain ||
        !integer(x, 0, Math.ceil(domain.width / AROME_TILE_CORE) - 1) ||
        !integer(y, 0, Math.ceil(domain.height / AROME_TILE_CORE) - 1)
    )
        return null;
    const i0 = Math.max(0, x * AROME_TILE_CORE - AROME_TILE_HALO);
    const j0 = Math.max(0, y * AROME_TILE_CORE - AROME_TILE_HALO);
    return {
        id: `${x}-${y}`,
        i0,
        j0,
        width: Math.min(domain.width, (x + 1) * AROME_TILE_CORE + AROME_TILE_HALO) - i0,
        height: Math.min(domain.height, (y + 1) * AROME_TILE_CORE + AROME_TILE_HALO) - j0,
    };
}

/** Validate the complete original grid inventory, never just the requested tile.
 * Fixed 49-packet and <=598-tile loops keep malformed JSON work bounded.
 */
export function parseAromeManifest(value: unknown, slot: AromeSlot, now: number): AromeStaticManifest | null {
    const domain = aromeDomain(slot.model);
    if (
        !domain ||
        !record(value) ||
        value.schema !== 1 ||
        value.model !== slot.model ||
        value.runUtc !== slot.runUtc ||
        !aromeRunCurrent(value.runUtc, slot.model, now) ||
        value.provider !== 'Météo-France' ||
        value.product !== 'AROME-OM' ||
        value.licence !== 'Etalab-2.0' ||
        value.width !== domain.width ||
        value.height !== domain.height ||
        value.stepDegrees !== AROME_STEP_DEGREES ||
        !equalArray(value.bounds, domain.region) ||
        value.hours !== 49 ||
        !equalArray(value.fields, AROME_STATIC_FIELDS) ||
        !equalArray(value.units, AROME_STATIC_UNITS) ||
        value.encoding !== 'gzip-f64le-v1' ||
        value.core !== AROME_TILE_CORE ||
        value.halo !== AROME_TILE_HALO ||
        !aromeHash(value.maskSha256) ||
        !aromeHash(value.nativeProofSha256) ||
        !aromeHash(value.catalogueSha256) ||
        !Array.isArray(value.packets) ||
        value.packets.length !== 49 ||
        !Array.isArray(value.tiles)
    )
        return null;
    let packetBytes = 0;
    for (let offset = 0; offset < 49; offset++) {
        const packet: unknown = value.packets[offset];
        if (
            !record(packet) ||
            packet.offsetHours !== offset ||
            !aromeHash(packet.sha256) ||
            !integer(packet.bytes, 16, 16 * 1024 * 1024)
        )
            return null;
        packetBytes += packet.bytes;
    }
    if (packetBytes > 512 * 1024 * 1024) return null;
    const nx = Math.ceil(domain.width / AROME_TILE_CORE);
    const ny = Math.ceil(domain.height / AROME_TILE_CORE);
    if (value.tiles.length !== nx * ny) return null;
    let outputBytes = 0;
    for (let index = 0; index < nx * ny; index++) {
        const tile: unknown = value.tiles[index];
        const shape = aromeTileShape(slot.model, index % nx, Math.floor(index / nx))!;
        const payloadBytes = shape.width * shape.height * (1 + 49 * AROME_STATIC_FIELDS.length) * 8;
        if (
            !record(tile) ||
            Object.entries(shape).some(([key, expected]) => tile[key] !== expected) ||
            !aromeHash(tile.sha256) ||
            !aromeHash(tile.rawSha256) ||
            !integer(tile.bytes, 20, AROME_TILE_BYTES) ||
            !integer(tile.rawBytes, payloadBytes + 13, Math.min(payloadBytes + 4108, AROME_TILE_BYTES))
        )
            return null;
        outputBytes += tile.bytes;
    }
    // Explicit new storage envelope; this is not a native/provider cap increase.
    if (outputBytes > 1024 * 1024 * 1024) return null;
    return value as unknown as AromeStaticManifest;
}

export function aromeTileAt(manifest: AromeStaticManifest, point: { lat: number; lon: number }): AromeTile | null {
    const domain = aromeDomain(manifest.model)!;
    const [south, north, west, east] = domain.region;
    if (
        !Number.isFinite(point.lat) ||
        !Number.isFinite(point.lon) ||
        point.lat < south ||
        point.lat > north ||
        point.lon < west ||
        point.lon > east
    )
        return null;
    const i = Math.min(domain.width - 1, Math.round((point.lon - west) / AROME_STEP_DEGREES));
    const j = Math.min(domain.height - 1, Math.round((point.lat - south) / AROME_STEP_DEGREES));
    const nx = Math.ceil(domain.width / AROME_TILE_CORE);
    return manifest.tiles[Math.floor(j / AROME_TILE_CORE) * nx + Math.floor(i / AROME_TILE_CORE)] ?? null;
}

export async function aromeSha256(raw: Uint8Array): Promise<string> {
    // Exact fresh buffer also satisfies both DOM and Deno ArrayBuffer contracts.
    const bytes = Uint8Array.from(raw);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function seaDistanceSquared(lat: number, lon: number, point: { lat: number; lon: number }) {
    const radians = Math.PI / 180;
    const dlat = (lat - point.lat) * radians;
    const dlon = (lon - point.lon) * radians;
    return Math.sin(dlat / 2) ** 2 + Math.cos(lat * radians) * Math.cos(point.lat * radians) * Math.sin(dlon / 2) ** 2;
}

/** Exact f64 native values; NaN is unknown, never a land-mask or calm zero.
 * Ranking uses the original mask only, before inspecting forecast availability.
 */
export function aromePointFromTile(
    raw: Uint8Array,
    manifest: AromeStaticManifest,
    slot: AromeSlot,
    tile: AromeTile,
    point: { lat: number; lon: number },
    now: number,
): AromePointForecast | null {
    if (
        raw.length !== tile.rawBytes ||
        raw.length > AROME_TILE_BYTES ||
        raw.length < 13 ||
        new TextDecoder().decode(raw.subarray(0, 8)) !== AROME_BINARY_MAGIC
    )
        return null;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const headerBytes = view.getUint32(8, true);
    if (headerBytes < 1 || headerBytes > 4096 || 12 + headerBytes > raw.length) return null;
    let header: unknown;
    try {
        header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(12, 12 + headerBytes)));
    } catch {
        return null;
    }
    if (
        !record(header) ||
        header.schema !== 1 ||
        header.model !== manifest.model ||
        header.runUtc !== manifest.runUtc ||
        header.maskSha256 !== manifest.maskSha256 ||
        header.nativeProofSha256 !== manifest.nativeProofSha256 ||
        header.id !== tile.id ||
        header.i0 !== tile.i0 ||
        header.j0 !== tile.j0 ||
        header.width !== tile.width ||
        header.height !== tile.height ||
        header.hours !== 49 ||
        !equalArray(header.fields, AROME_STATIC_FIELDS) ||
        !equalArray(header.units, AROME_STATIC_UNITS)
    )
        return null;
    const cells = tile.width * tile.height;
    const start = 12 + headerBytes;
    if (raw.length !== start + cells * (1 + 49 * AROME_STATIC_FIELDS.length) * 8) return null;
    const read = (index: number) => view.getFloat64(start + index * 8, true);
    const domain = aromeDomain(manifest.model)!;
    const [south, , west] = domain.region;
    let nearest: { index: number; i: number; j: number; latitude: number; longitude: number; distance: number } | null =
        null;
    for (let index = 0; index < cells; index++) {
        const mask = read(index);
        if (mask !== mask) continue;
        if (!Number.isFinite(mask) || mask < 0 || mask > 1) return null;
        if (mask !== 0) continue;
        const i = tile.i0 + (index % tile.width);
        const j = tile.j0 + Math.floor(index / tile.width);
        const latitude = south + j * AROME_STEP_DEGREES;
        const longitude = west + i * AROME_STEP_DEGREES;
        if (
            Math.abs(latitude - point.lat) > 3 * AROME_STEP_DEGREES + 1e-7 ||
            Math.abs(longitude - point.lon) > 3 * AROME_STEP_DEGREES + 1e-7
        )
            continue;
        const distance = seaDistanceSquared(latitude, longitude, point);
        if (!nearest || distance < nearest.distance) nearest = { index, i, j, latitude, longitude, distance };
    }
    if (!nearest) return null;
    const selected = nearest;
    const values = (field: number, hour: number) => read(cells + (field * 49 + hour) * cells + selected.index);
    const bounded = (value: number, low: number, high: number) =>
        Number.isNaN(value) ? null : Number.isFinite(value) && value >= low && value <= high ? value : undefined;
    const hourly: AromePointForecast['hourly'] = {
        time: Array.from({ length: 49 }, (_, hour) => Date.parse(manifest.runUtc) / 1000 + hour * 3600),
        wind_speed_10m: [],
        wind_direction_10m: [],
        wind_gusts_10m: Array(49).fill(null),
        pressure_msl: [],
        temperature_2m: [],
        relative_humidity_2m: [],
        precipitation: Array(49).fill(null),
    };
    for (let hour = 0; hour < 49; hour++) {
        const u = bounded(values(0, hour), -102, 102);
        const v = bounded(values(1, hour), -102, 102);
        const pressure = bounded(values(2, hour), 80000, 110000);
        const temperature = bounded(values(3, hour), 193.15, 338.15);
        const humidity = bounded(values(4, hour), 0, 100);
        if (
            u === undefined ||
            v === undefined ||
            pressure === undefined ||
            temperature === undefined ||
            humidity === undefined
        )
            return null;
        const speed = u === null || v === null ? null : Math.hypot(u, v) / 0.5144444444444445;
        hourly.wind_speed_10m.push(speed);
        hourly.wind_direction_10m.push(
            speed === null || speed === 0 || u === null || v === null
                ? null
                : ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360,
        );
        hourly.pressure_msl.push(pressure === null ? null : pressure / 100);
        hourly.temperature_2m.push(temperature === null ? null : temperature - 273.15);
        hourly.relative_humidity_2m.push(humidity);
    }
    return parseAromePoint(
        {
            schema: 1,
            model: manifest.model,
            provider: 'Météo-France',
            product: 'AROME-OM',
            licence: 'Etalab-2.0',
            runUtc: manifest.runUtc,
            cohortSha256: slot.manifestSha256,
            maskSha256: manifest.maskSha256,
            seaCell: {
                i: selected.i,
                j: selected.j,
                latitude: selected.latitude,
                longitude: selected.longitude,
                landFraction: 0,
                method: 'nearest-original-sea-cell',
            },
            hourly_units: AROME_HOURLY_UNITS,
            hourly,
        },
        manifest.model,
        point,
        now,
    );
}
