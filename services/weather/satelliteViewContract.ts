/** Fixed display-only satellite sources. Provider palettes are never decoded as physical measurements. */
export const SATELLITE_VIEW_PRODUCTS = {
    'himawari-ir': {
        label: 'Himawari · clean IR',
        layer: 'Himawari_AHI_Band13_Clean_Infrared',
        provider: 'gibs',
        credit: 'JMA Himawari-9 / AHI; NASA GIBS / ESDIS',
        detail: '10.3 µm Band 13 · regional disk · nominal 2 km imagery',
        daily: false,
        hourlyOnly: false,
        style: '',
    },
    'goes-east-ir': {
        label: 'GOES East · clean IR',
        layer: 'GOES-East_ABI_Band13_Clean_Infrared',
        provider: 'gibs',
        credit: 'NOAA GOES-East / ABI; NASA GIBS / ESDIS',
        detail: '10.3 µm Band 13 · regional disk · nominal 2 km imagery',
        daily: false,
        hourlyOnly: false,
        style: '',
    },
    'goes-west-ir': {
        label: 'GOES West · clean IR',
        layer: 'GOES-West_ABI_Band13_Clean_Infrared',
        provider: 'gibs',
        credit: 'NOAA GOES-West / ABI; NASA GIBS / ESDIS',
        detail: '10.3 µm Band 13 · regional disk · nominal 2 km imagery',
        daily: false,
        hourlyOnly: false,
        style: '',
    },
    'meteosat-ir': {
        label: 'Meteosat · hourly IR',
        layer: 'mtg_fd:ir105_hrfi',
        provider: 'eumet',
        credit: 'Contains modified EUMETSAT Meteosat FCI data · CC BY 4.0',
        detail: '10.5 µm FCI · nominal 1 km · hourly Core frames only · regional disk',
        daily: false,
        hourlyOnly: true,
        style: 'mtg_fd:mtg_fd_ir105_hrfi_grayscale',
    },
    'viirs-night': {
        label: 'Polar fallback · VIIRS night',
        layer: 'VIIRS_SNPP_Brightness_Temp_BandI5_Night',
        provider: 'gibs',
        credit: 'Suomi NPP / VIIRS; NASA GIBS / ESDIS',
        detail: 'Daily night swath composite · 375 m source · partial coverage · observation time within day unknown',
        daily: true,
        hourlyOnly: false,
        style: '',
    },
    'water-vapour': {
        label: 'Upper water vapour',
        layer: 'global_water_vapor_imagery_mosaic',
        provider: 'noaa',
        credit: 'NOAA/NESDIS GMGSI; NOAA GOES, EUMETSAT Meteosat, JMA Himawari',
        detail: 'Mid/upper-tropospheric moisture · hourly mosaic · nominal 3 km · typically 2–3 h latency · not surface fog',
        daily: false,
        hourlyOnly: false,
        style: 'reflectance',
    },
} as const;
export type SatelliteViewProduct = keyof typeof SATELLITE_VIEW_PRODUCTS;
export function satelliteViewCredit(product: SatelliteViewProduct, timeMs?: number): string {
    return `${SATELLITE_VIEW_PRODUCTS[product].credit}${timeMs !== undefined && Number.isFinite(timeMs) ? ' · ' + new Date(timeMs).getUTCFullYear() : ''}`;
}
export const SATELLITE_METADATA_MAX = 512 * 1024;
export const SATELLITE_IMAGE_MAX = 2 * 1024 * 1024;
export const SATELLITE_VIEW_MAX_EDGE = 1024;
export const SATELLITE_METADATA_LIFETIME_MS = 2 * 60_000;
export interface SatelliteViewFrame {
    readonly iso: string;
    readonly timeMs: number;
    readonly daily: boolean;
}
export interface SatelliteViewTimes {
    readonly product: SatelliteViewProduct;
    readonly metadataUrl: string;
    readonly readAtMs: number;
    readonly frames: readonly SatelliteViewFrame[];
}
export type SatelliteViewBox = readonly [west: number, south: number, east: number, north: number];
const GEO_WINDOW = 6 * 3600000,
    DAILY_WINDOW = 2 * 86400000;
const INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/;
function instant(value: string): number {
    if (!INSTANT.test(value)) throw new Error('Satellite time invalid');
    const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value.slice(0, 10))
        throw new Error('Satellite time invalid');
    return parsed;
}
export function satelliteViewProduct(value: unknown): SatelliteViewProduct | null {
    return typeof value === 'string' && Object.hasOwn(SATELLITE_VIEW_PRODUCTS, value)
        ? (value as SatelliteViewProduct)
        : null;
}
export function satelliteMetadataUrl(product: SatelliteViewProduct, nowMs: number): string {
    if (!Number.isFinite(nowMs)) throw new Error('Satellite clock unknown');
    const source = SATELLITE_VIEW_PRODUCTS[product];
    if (source.provider === 'eumet')
        return 'https://view.eumetsat.int/geoserver/wms?service=WMS&request=GetCapabilities&version=1.3.0&namespace=mtg_fd';
    if (source.provider === 'noaa')
        return 'https://nowcoast.noaa.gov/geoserver/satellite/wms?service=WMS&version=1.3.0&request=GetCapabilities';
    const start = new Date(nowMs - (source.daily ? DAILY_WINDOW : GEO_WINDOW)).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const stop = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    // GIBS currently rejects percent-encoded colons/slashes in this documented KVP parameter.
    return `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=${source.layer}&TILEMATRIXSET=${source.daily ? '250m' : '2km'}&TIME=${start}/${stop}`;
}

/** Expand only the recent intersection of original advertised periods, preserving every gap. */
export function parseSatelliteTimes(xml: string, product: SatelliteViewProduct, nowMs: number): SatelliteViewTimes {
    if (
        !Number.isFinite(nowMs) ||
        xml.length > SATELLITE_METADATA_MAX ||
        /<!DOCTYPE|<!ENTITY|ExceptionReport|ServiceException|<html/i.test(xml)
    )
        throw new Error('Satellite metadata refused');
    const source = SATELLITE_VIEW_PRODUCTS[product];
    let domain: string | undefined;
    if (source.provider === 'gibs') {
        if (!/<Domains(?:\s|>)/.test(xml)) throw new Error('Satellite domain missing');
        const dimensions = [...xml.matchAll(/<DimensionDomain\b[^>]*>([\s\S]*?)<\/DimensionDomain>/g)];
        const time = dimensions.filter((match) => /<(?:ows:)?Identifier>time<\/(?:ows:)?Identifier>/.test(match[1]));
        if (time.length !== 1) throw new Error('Satellite time domain ambiguous');
        domain = /<Domain>([^<]*)<\/Domain>/.exec(time[0][1])?.[1];
        const size = Number(/<Size>(\d+)<\/Size>/.exec(time[0][1])?.[1]);
        if (!domain || !Number.isSafeInteger(size) || size !== domain.split(',').length)
            throw new Error('Satellite domain count invalid');
    } else {
        const marker = `<Name>${source.layer}</Name>`,
            start = xml.indexOf(marker);
        if (start < 0 || xml.indexOf(marker, start + marker.length) >= 0)
            throw new Error('Satellite layer absent or ambiguous');
        const end = xml.indexOf('</Layer>', start);
        if (end < 0) throw new Error('Satellite layer incomplete');
        const block = xml.slice(start, end);
        domain = /<Dimension\b(?=[^>]*\bname="time")[^>]*>([^<]*)<\/Dimension>/.exec(block)?.[1];
    }
    if (!domain || domain.length > 65536) throw new Error('Satellite listed times missing');
    const periods = domain.split(',');
    if (periods.length > 1024) throw new Error('Satellite period bound exceeded');
    const lower = nowMs - (source.daily ? DAILY_WINDOW : GEO_WINDOW),
        frames = new Map<number, SatelliteViewFrame>();
    for (const period of periods) {
        const parts = period.trim().split('/');
        const start = instant(parts[0]);
        let end = start,
            step = 0;
        if (parts.length !== 1) {
            if (parts.length !== 3) throw new Error('Satellite time interval invalid');
            end = instant(parts[1]);
            const match = /^(?:P(1)D|PT(?:(\d{1,2})H)?(?:(\d{1,2})M)?)$/.exec(parts[2]);
            step = match
                ? Number(match[1] ?? 0) * 86400000 + Number(match[2] ?? 0) * 3600000 + Number(match[3] ?? 0) * 60000
                : 0;
            if (step < 5 * 60000 || step > 86400000 || end < start || (end - start) % step !== 0)
                throw new Error('Satellite cadence invalid');
        }
        if (end < lower || start > nowMs + 60000) continue;
        const first = step ? start + Math.max(0, Math.ceil((lower - start) / step)) * step : start;
        const last = Math.min(end, nowMs + 60000);
        for (let time = first; time <= last; time += step || 1) {
            if (source.daily && time % 86400000 !== 0) throw new Error('Daily satellite clock invalid');
            if (!source.hourlyOnly || time % 3600000 === 0)
                frames.set(time, {
                    iso: source.daily
                        ? new Date(time).toISOString().slice(0, 10)
                        : new Date(time).toISOString().replace('.000Z', 'Z'),
                    timeMs: time,
                    daily: source.daily,
                });
            if (frames.size > 80) throw new Error('Satellite frame bound exceeded');
            if (!step) break;
        }
    }
    const sorted = [...frames.values()].sort((a, b) => a.timeMs - b.timeMs);
    const latest = sorted.at(-1);
    if (
        !latest ||
        nowMs - latest.timeMs > (source.daily ? 48 * 3600000 : source.provider === 'noaa' ? 4 * 3600000 : 3 * 3600000)
    )
        throw new Error('Satellite frames stale or absent');
    return { product, metadataUrl: satelliteMetadataUrl(product, nowMs), readAtMs: nowMs, frames: sorted.slice(-6) };
}

export function satelliteImageTarget(
    product: SatelliteViewProduct,
    frame: SatelliteViewFrame,
    box: SatelliteViewBox,
    width: number,
    height: number,
): string {
    if (!Array.isArray(box) || box.length !== 4) throw new Error('Satellite image window invalid');
    const [west, south, east, north] = box;
    if (
        !box.every(Number.isFinite) ||
        west < -180 ||
        east > 180 ||
        west >= east ||
        south >= north ||
        south < -85 ||
        north > 85 ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 1024 ||
        height > 1024
    )
        throw new Error('Satellite image window invalid');
    const source = SATELLITE_VIEW_PRODUCTS[product];
    const time = instant(frame.iso);
    if (
        time !== frame.timeMs ||
        frame.daily !== source.daily ||
        (source.hourlyOnly && time % 3600000 !== 0) ||
        (source.daily && frame.iso.length !== 10)
    )
        throw new Error('Satellite image frame invalid');
    const radius = 6378137,
        mercator = (lat: number) => radius * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const bbox = [(west * Math.PI * radius) / 180, mercator(south), (east * Math.PI * radius) / 180, mercator(north)]
        .map((value) => value.toFixed(3))
        .join(',');
    const endpoint =
        source.provider === 'gibs'
            ? 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi'
            : source.provider === 'eumet'
              ? 'https://view.eumetsat.int/geoserver/wms'
              : 'https://nowcoast.noaa.gov/geoserver/satellite/wms';
    return `${endpoint}?service=WMS&version=1.3.0&request=GetMap&layers=${source.layer}&styles=${encodeURIComponent(source.style)}&format=image/png&transparent=true&crs=EPSG:3857&width=${width}&height=${height}&bbox=${bbox}&time=${frame.iso}`;
}

/** The metadata response is information from one fixed proxy read, never an authority claim supplied by a provider string. */
export function validateSatelliteViewTimes(
    value: unknown,
    expected: SatelliteViewProduct,
    nowMs: number,
): SatelliteViewTimes {
    if (!Number.isFinite(nowMs) || !value || typeof value !== 'object') throw new Error('Satellite times invalid');
    const candidate = value as SatelliteViewTimes;
    if (
        candidate.product !== expected ||
        !Number.isFinite(candidate.readAtMs) ||
        nowMs < candidate.readAtMs - 60000 ||
        nowMs - candidate.readAtMs > SATELLITE_METADATA_LIFETIME_MS ||
        candidate.metadataUrl !== satelliteMetadataUrl(expected, candidate.readAtMs) ||
        !Array.isArray(candidate.frames) ||
        candidate.frames.length < 1 ||
        candidate.frames.length > 6
    )
        throw new Error('Satellite times retired');
    let previous = -Infinity;
    for (const frame of candidate.frames) {
        if (
            !frame ||
            instant(frame.iso) !== frame.timeMs ||
            frame.timeMs <= previous ||
            frame.timeMs > candidate.readAtMs + 60000 ||
            frame.timeMs < candidate.readAtMs - (SATELLITE_VIEW_PRODUCTS[expected].daily ? DAILY_WINDOW : GEO_WINDOW) ||
            frame.daily !== SATELLITE_VIEW_PRODUCTS[expected].daily ||
            (SATELLITE_VIEW_PRODUCTS[expected].hourlyOnly && frame.timeMs % 3600000 !== 0) ||
            (frame.daily && frame.iso.length !== 10)
        )
            throw new Error('Satellite frame contract invalid');
        previous = frame.timeMs;
    }
    return candidate;
}
