/** Original sampled predictions only. This contract is informational and is
 * deliberately not a routing TideField or an overhead/sounding datum tie. */
export type SampledTideProvider = 'NOAA' | 'MSQ' | 'LINZ' | 'WorldTides';
export interface SampledTideSeries {
    schema: 1;
    kind: 'sampled-prediction';
    provider: SampledTideProvider;
    productId: string;
    stationId: string;
    stationName: string;
    lat: number;
    lon: number;
    datumId: string;
    datumLabel: string;
    datumEpoch: string | null;
    /** Original provider issue clock; null stays unknown, never receivedAt. */
    sourceAtMs: number | null;
    receivedAtMs: number;
    expiresAtMs: number;
    sourceUrl: string;
    licenceUrl: string;
    units: 'm';
    samples: { timeMs: number; heightM: number }[];
}
export interface InformationalTideSample {
    kind: 'station-prediction';
    heightM: number;
    atMs: number;
    datumId: string;
    datumLabel: string;
    datumEpoch: string | null;
    stationId: string;
    sourceAtMs: number | null;
    interpolated: boolean;
    /** A source label cannot create legal permission or a chart datum tie. */
    navigationEligible: false;
}
export const SAMPLED_TIDE_POINTS_MAX = 673; // Fourteen days at 30-minute resolution plus endpoint.
const DAY = 86400000,
    HOUR = 3600000;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clock = (n: unknown): n is number => finite(n) && n >= 946684800000 && n <= 4102444800000;
const text = (s: unknown, max: number): s is string =>
    typeof s === 'string' && s.length > 0 && s.length <= max && !/\p{Cc}/u.test(s);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function publicReference(value: unknown, provider: string): value is string {
    if (!text(value, 512)) return false;
    try {
        const url = new URL(value);
        const hosts: Record<string, string[]> = {
            NOAA: ['tidesandcurrents.noaa.gov', 'www.tidesandcurrents.noaa.gov'],
            MSQ: ['msq.qld.gov.au', 'www.msq.qld.gov.au'],
            LINZ: ['linz.govt.nz', 'www.linz.govt.nz'],
            WorldTides: ['worldtides.info', 'www.worldtides.info'],
        };
        return (
            url.protocol === 'https:' &&
            !url.port &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            !!hosts[provider]?.includes(url.hostname)
        );
    } catch {
        return false;
    }
}
/** Strict, separate protocol. Existing official extrema tables do not match
 * this schema and are not upgraded or relabelled into sampled predictions. */
export function parseSampledTideSeries(value: unknown, nowMs: number): SampledTideSeries | null {
    if (
        !record(value) ||
        !clock(nowMs) ||
        Object.keys(value).sort().join(',') !==
            'datumEpoch,datumId,datumLabel,expiresAtMs,kind,lat,licenceUrl,lon,productId,provider,receivedAtMs,samples,schema,sourceAtMs,sourceUrl,stationId,stationName,units' ||
        value.schema !== 1 ||
        value.kind !== 'sampled-prediction' ||
        value.units !== 'm' ||
        !['NOAA', 'MSQ', 'LINZ', 'WorldTides'].includes(String(value.provider)) ||
        !text(value.productId, 100) ||
        !text(value.stationId, 80) ||
        !text(value.stationName, 120) ||
        !text(value.datumId, 160) ||
        !text(value.datumLabel, 100) ||
        !(value.datumEpoch === null || text(value.datumEpoch, 80)) ||
        !finite(value.lat) ||
        Math.abs(value.lat) > 90 ||
        !finite(value.lon) ||
        Math.abs(value.lon) > 180 ||
        !(value.sourceAtMs === null || (clock(value.sourceAtMs) && value.sourceAtMs <= nowMs + 120000)) ||
        !clock(value.receivedAtMs) ||
        value.receivedAtMs > nowMs + 120000 ||
        !clock(value.expiresAtMs) ||
        value.expiresAtMs <= nowMs ||
        value.expiresAtMs > value.receivedAtMs + 36 * HOUR ||
        !publicReference(value.sourceUrl, String(value.provider)) ||
        !publicReference(value.licenceUrl, String(value.provider)) ||
        !Array.isArray(value.samples) ||
        value.samples.length < 2 ||
        value.samples.length > SAMPLED_TIDE_POINTS_MAX
    )
        return null;
    const samples: SampledTideSeries['samples'] = [];
    for (const raw of value.samples) {
        if (
            !record(raw) ||
            Object.keys(raw).sort().join(',') !== 'heightM,timeMs' ||
            !clock(raw.timeMs) ||
            !finite(raw.heightM) ||
            Math.abs(raw.heightM) > 100 ||
            (samples.length && raw.timeMs <= samples.at(-1)!.timeMs)
        )
            return null;
        samples.push({ timeMs: raw.timeMs, heightM: raw.heightM });
    }
    if (samples.at(-1)!.timeMs - samples[0].timeMs > 14 * DAY) return null;
    // Independent primitive copies; retaining a source DTO cannot mutate the
    // accepted samples after validation or cause an account's old data to grow.
    return {
        schema: 1,
        kind: 'sampled-prediction',
        provider: value.provider as SampledTideProvider,
        productId: value.productId,
        stationId: value.stationId,
        stationName: value.stationName,
        lat: value.lat,
        lon: value.lon,
        datumId: value.datumId,
        datumLabel: value.datumLabel,
        datumEpoch: value.datumEpoch,
        sourceAtMs: value.sourceAtMs,
        receivedAtMs: value.receivedAtMs,
        expiresAtMs: value.expiresAtMs,
        sourceUrl: value.sourceUrl,
        licenceUrl: value.licenceUrl,
        units: 'm',
        samples,
    };
}
/** Exact provider knots or a linear interpolation within an original <=1h
 * bracket. No nearest endpoint, extrema curve, gap filling or extrapolation. */
export function sampleStationPrediction(
    series: SampledTideSeries,
    atMs: number,
    nowMs: number,
): InformationalTideSample | null {
    const current = parseSampledTideSeries(series, nowMs);
    if (!current || !clock(atMs)) return null;
    const samples = current.samples;
    let lo = 0,
        hi = samples.length - 1;
    if (atMs < samples[lo].timeMs || atMs > samples[hi].timeMs) return null;
    while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].timeMs <= atMs) lo = mid;
        else hi = mid;
    }
    const exact = samples[lo].timeMs === atMs ? samples[lo] : samples[hi].timeMs === atMs ? samples[hi] : null;
    if (!exact && samples[hi].timeMs - samples[lo].timeMs > HOUR) return null;
    const heightM = exact
        ? exact.heightM
        : samples[lo].heightM +
          (samples[hi].heightM - samples[lo].heightM) *
              ((atMs - samples[lo].timeMs) / (samples[hi].timeMs - samples[lo].timeMs));
    return {
        kind: 'station-prediction',
        heightM,
        atMs,
        datumId: current.datumId,
        datumLabel: current.datumLabel,
        datumEpoch: current.datumEpoch,
        stationId: current.stationId,
        sourceAtMs: current.sourceAtMs,
        interpolated: !exact,
        navigationEligible: false,
    };
}
