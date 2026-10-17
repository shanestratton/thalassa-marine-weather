/** Public-phase policy. It never changes the private capture core or grants authority by itself. */
import {
    insideAnyZone,
    parseSeabedZones,
    SEABED_FLAG,
    SEABED_FLAG_MAX,
    SEABED_HOLD_DAYS,
    type SeabedRow,
    type SeabedZone,
} from './seabedCore.ts';

export const CROWD_CONSENT_VERSION = '2026-10-17-public-1';
export const CROWD_LABEL = 'Crowd soundings · unverified · not for navigation';
export const CROWD_LIMITS = {
    rows: 7200,
    batchBytes: 2 * 1024 * 1024,
    batches: 32,
    holdDays: SEABED_HOLD_DAYS,
    cellMetres: 100,
    contourIntervalMetres: 0.5,
    independentBoats: 3,
    independentUtcDays: 3,
} as const;
export interface CrowdCalibration {
    schema: 1;
    /** Explicitly checked instrument output; vessel draft is not this calibration. */
    depthReference: 'T' | 'W';
    depthSource: string;
    sounderProduct: string;
    measuredAt: number;
    waterlineToTransducerM: number;
    offsetUncertaintyM: number;
    sounderUncertaintyM: number;
    checkedDepthLimitM: number;
    method: 'measured-offset-and-sounder-check';
}
export interface CrowdConsent {
    ownerId: string;
    boatId: string;
    revision: string;
    consentVersion: typeof CROWD_CONSENT_VERSION;
    mapEnabled: boolean;
    dcdbEnabled: boolean;
    /** Server confirmation time. Only later-captured rows are eligible. */
    effectiveFrom: number;
    calibration: CrowdCalibration | null;
}
export interface CrowdSource {
    ownerId: string;
    boatId: string;
    batchId: string;
    originalStoredSha256: string;
    capturedStart: number;
    capturedEnd: number;
    eligibleAfter: number;
    meta: Readonly<Record<string, unknown>>;
    privacyZones: readonly SeabedZone[];
    /** Actual current DB reader supplies these identities, never a request JSON flag. */
    consent: CrowdConsent;
}
export interface CrowdTide {
    schema: 1;
    source: 'noaa-coops-observed' | 'reviewed-official-observed';
    originalSha256: string;
    station: string;
    /** Region/datum are explicitly reviewed, never inferred from nearby coordinates. */
    hydroRegion: string;
    datumId: string;
    datumName: 'MLLW' | 'LAT' | 'MSL';
    verticalUnit: 'm';
    publiclyReusable: true;
    rightsReviewedAt: number;
    rightsExpiresAt: number;
    qc: 'verified';
    uncertaintyM: number;
    /** Original UTC observations, not a provider receipt or a WorldTides prediction. */
    samples: readonly [readonly [utc: number, heightM: number], readonly [utc: number, heightM: number]];
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown, lo: number, hi: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const utc = (v: unknown): v is number =>
    Number.isSafeInteger(v) && (v as number) >= Date.UTC(2020, 0, 1) && (v as number) <= Date.UTC(2100, 0, 1);
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{64}$/.test(v);
const text = (v: unknown, cap = 120): v is string =>
    typeof v === 'string' &&
    v.trim() === v &&
    v.length > 0 &&
    v.length <= cap &&
    !Array.from(v).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const refuse = (why: string): never => {
    throw new Error(`Crowd sounding unavailable: ${why}`);
};

export function parseCrowdCalibration(value: unknown, now: number): CrowdCalibration {
    const keys = [
        'schema',
        'depthReference',
        'depthSource',
        'sounderProduct',
        'measuredAt',
        'waterlineToTransducerM',
        'offsetUncertaintyM',
        'sounderUncertaintyM',
        'checkedDepthLimitM',
        'method',
    ];
    if (
        !utc(now) ||
        !record(value) ||
        Object.keys(value).length !== keys.length ||
        keys.some((key) => !(key in value)) ||
        value.schema !== 1 ||
        !['T', 'W'].includes(String(value.depthReference)) ||
        !text(value.depthSource) ||
        !text(value.sounderProduct) ||
        !utc(value.measuredAt) ||
        value.measuredAt > now ||
        now - value.measuredAt > 366 * 86400000 ||
        !finite(value.waterlineToTransducerM, 0, 10) ||
        !finite(value.offsetUncertaintyM, 0.01, 1) ||
        !finite(value.sounderUncertaintyM, 0.01, 1) ||
        !finite(value.checkedDepthLimitM, 0.5, 200) ||
        value.method !== 'measured-offset-and-sounder-check'
    ) {
        return refuse('explicit measured waterline/sounder calibration required');
    }
    return value as unknown as CrowdCalibration;
}

export function requireCrowdRelease(source: CrowdSource, purpose: 'map' | 'dcdb', now: number): CrowdCalibration {
    const consent = source.consent;
    if (
        !utc(now) ||
        !['map', 'dcdb'].includes(purpose) ||
        !uuid(source.ownerId) ||
        !uuid(source.boatId) ||
        !uuid(source.batchId) ||
        !hash(source.originalStoredSha256) ||
        !utc(source.capturedStart) ||
        !utc(source.capturedEnd) ||
        source.capturedStart > source.capturedEnd ||
        !utc(source.eligibleAfter) ||
        source.eligibleAfter < source.capturedEnd + CROWD_LIMITS.holdDays * 86400000 ||
        now < source.eligibleAfter ||
        !consent ||
        consent.ownerId !== source.ownerId ||
        consent.boatId !== source.boatId ||
        !uuid(consent.revision) ||
        consent.consentVersion !== CROWD_CONSENT_VERSION ||
        typeof consent.mapEnabled !== 'boolean' ||
        typeof consent.dcdbEnabled !== 'boolean' ||
        (purpose === 'map' ? !consent.mapEnabled : !consent.dcdbEnabled) ||
        !utc(consent.effectiveFrom) ||
        source.capturedStart < consent.effectiveFrom ||
        !consent.calibration
    ) {
        return refuse('fresh separate owner permission and thirty-day hold required');
    }
    const calibration = parseCrowdCalibration(consent.calibration, now);
    if (calibration.measuredAt > consent.effectiveFrom) return refuse('calibration postdates permission scope');
    return calibration;
}

/** Qualified input only: callers must retain actual ownership/privacy/source leases over all awaits. */
export function qualifyCrowdRow(
    source: CrowdSource,
    row: SeabedRow,
    purpose: 'map' | 'dcdb',
    now: number,
): CrowdCalibration {
    const calibration = requireCrowdRelease(source, purpose, now);
    const zones = parseSeabedZones(source.privacyZones);
    const benign = SEABED_FLAG.GAP_BEFORE | SEABED_FLAG.DEPTH_DERIVED;
    if (
        !record(source.meta) ||
        source.meta.time_source !== 'gnss' ||
        source.meta.depth_source !== calibration.depthSource ||
        !finite(row.lon, -180, 180) ||
        !finite(row.lat, -85, 85) ||
        !utc(row.timeMs) ||
        row.timeMs < source.capturedStart ||
        row.timeMs > source.capturedEnd ||
        row.depthRef !== calibration.depthReference ||
        !finite(row.depth, 0.5, calibration.checkedDepthLimitM) ||
        !Number.isSafeInteger(row.flags) ||
        row.flags < 0 ||
        row.flags > SEABED_FLAG_MAX ||
        (row.flags & ~benign) !== 0 ||
        ![1, 2, 4, 5].includes(row.fixQ ?? -1) ||
        !finite(row.hdop, 0.1, 2.5) ||
        !finite(row.sats, 5, 100) ||
        !Number.isSafeInteger(row.sats) ||
        !finite(row.posAgeMs, 0, 2000) ||
        !finite(row.sogKn, 1.5, 12) ||
        !finite(row.heelDeg, -10, 10) ||
        !zones ||
        insideAnyZone(
            row.lat,
            row.lon,
            zones.map((zone) => ({ ...zone, radius_m: zone.radius_m + Math.SQRT2 * CROWD_LIMITS.cellMetres })),
        )
    ) {
        return refuse('original UTC, reference, quality or current privacy check failed');
    }
    const reported = source.meta.surface_to_transducer_m;
    if (
        reported !== undefined &&
        (!finite(reported, 0, 10) ||
            Math.abs(reported - calibration.waterlineToTransducerM) > calibration.offsetUncertaintyM)
    ) {
        return refuse('instrument offset differs from explicit calibration');
    }
    return calibration;
}

export function reduceCrowdRow(source: CrowdSource, row: SeabedRow, tide: CrowdTide, region: string, now: number) {
    const calibration = qualifyCrowdRow(source, row, 'map', now);
    if (
        !tide ||
        tide.schema !== 1 ||
        !['noaa-coops-observed', 'reviewed-official-observed'].includes(tide.source) ||
        !hash(tide.originalSha256) ||
        !text(tide.station, 80) ||
        !text(region, 80) ||
        tide.hydroRegion !== region ||
        !text(tide.datumId, 120) ||
        !['MLLW', 'LAT', 'MSL'].includes(tide.datumName) ||
        tide.verticalUnit !== 'm' ||
        tide.publiclyReusable !== true ||
        tide.qc !== 'verified' ||
        !utc(tide.rightsReviewedAt) ||
        !utc(tide.rightsExpiresAt) ||
        tide.rightsReviewedAt > now ||
        tide.rightsExpiresAt <= now ||
        !finite(tide.uncertaintyM, 0.01, 0.5) ||
        !Array.isArray(tide.samples) ||
        tide.samples.length !== 2
    ) {
        return refuse('qualified original tide and explicit datum/region required');
    }
    const [a, b] = tide.samples;
    if (
        !Array.isArray(a) ||
        !Array.isArray(b) ||
        a.length !== 2 ||
        b.length !== 2 ||
        !utc(a[0]) ||
        !utc(b[0]) ||
        !finite(a[1], -20, 20) ||
        !finite(b[1], -20, 20) ||
        !(a[0] <= row.timeMs && row.timeMs <= b[0]) ||
        b[0] <= a[0] ||
        b[0] - a[0] > 3600000
    ) {
        return refuse('original tide UTC does not bracket the sounding');
    }
    const level = a[1] + ((b[1] - a[1]) * (row.timeMs - a[0])) / (b[0] - a[0]);
    // T is below the transducer; W is already below the waterline. Draft is
    // never added and a waterline offset is never applied twice.
    const waterlineDepth = row.depth + (row.depthRef === 'T' ? calibration.waterlineToTransducerM : 0);
    const depthM = waterlineDepth - level;
    if (!finite(depthM, 0.5, 200)) return refuse('reduced depth outside display limits');
    return {
        longitude: row.lon,
        latitude: row.lat,
        observedAt: row.timeMs,
        depthM,
        datumId: tide.datumId,
        datumName: tide.datumName,
        tideOriginalSha256: tide.originalSha256,
        uncertaintyM: Math.max(1, calibration.offsetUncertaintyM + calibration.sounderUncertaintyM + tide.uncertaintyM),
        contourIntervalM: CROWD_LIMITS.contourIntervalMetres,
        navigationAuthority: false as const,
    };
}
