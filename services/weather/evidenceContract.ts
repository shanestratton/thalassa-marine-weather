/** Bounded immutable public-station evidence. Never chart, routing or alarm authority. */
import {
    decodeIssuedSkill,
    evidenceKeys,
    evidenceRecord,
    evidenceRequire,
    ISSUED_WAVE_MODELS,
    SKILL_LEADS,
    type IssuedSkill,
    type SkillLead,
    type SkillMetric,
} from './modelSkill';

export type EvidenceKind = 'buoys' | 'skill';
export const EVIDENCE_PREFIX = { buoys: 'buoys/v1', skill: 'skill/issued-v1' } as const;
export const EVIDENCE_LIMITS = {
    pointer: 1024,
    index: 256 * 1024,
    detail: 128 * 1024,
    session: 2 * 1024 * 1024,
} as const;
export interface EvidencePointer {
    readonly kind: EvidenceKind;
    readonly generatedAt: number;
    readonly expiresAt: number;
    readonly generation: string;
    readonly indexBytes: number;
    readonly indexPath: string;
}
export interface EvidenceStation {
    readonly key: string;
    readonly stationId: string;
    readonly label: string;
    readonly network: 'ndbc' | 'qld-des';
    readonly dataset: string;
    readonly lat: number;
    readonly lon: number;
    readonly owner: string;
    readonly sourceUrl: string;
    readonly licenceUrl: string;
    readonly expiresAt: number;
    readonly detailSha256: string;
    readonly detailBytes: number;
    readonly observedAt?: number;
    readonly hsM?: number;
    readonly quality?: 'quality-controlled' | 'provisional';
    readonly qcBasis?: string;
    readonly status?: 'ready' | 'warming';
}
export interface EvidenceIndex extends EvidencePointer {
    readonly registrySha256: string;
    readonly stations: readonly EvidenceStation[];
    readonly heldNetworks: Readonly<Record<'aodn' | 'cmems-insitu', string>>;
}
export interface IssuedWaveLine {
    readonly model: string;
    readonly lead: '0-6h';
    readonly points: readonly (readonly [number, number, number, number])[];
}
export interface MeasuredBuoyDetail {
    readonly station: EvidenceStation;
    readonly receivedAt: number;
    readonly rawSha256: string;
    readonly measured: readonly (readonly [number, number])[];
    readonly issuedForecasts: readonly IssuedWaveLine[];
}
export interface StationSkillDetail {
    readonly station: EvidenceStation;
    readonly metrics: Readonly<Record<SkillMetric, Readonly<Record<SkillLead, IssuedSkill>>>>;
}
const META = [
    'key',
    'stationId',
    'label',
    'network',
    'dataset',
    'lat',
    'lon',
    'owner',
    'sourceUrl',
    'licenceUrl',
] as const;
const SHA = /^[0-9a-f]{64}$/;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const bounded = (value: unknown, lo: number, hi: number): value is number =>
    finite(value) && value >= lo && value <= hi;
const integer = (value: unknown, lo: number, hi: number): value is number =>
    bounded(value, lo, hi) && Number.isInteger(value);
const clock = (value: unknown): value is number => integer(value, 1577836800, 4102444800);
const text = (value: unknown, maximum: number): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    Array.from(value).every((letter) => letter.charCodeAt(0) >= 32 && letter.charCodeAt(0) !== 127);

export function decodeEvidencePointer(value: unknown, kind: EvidenceKind, nowSeconds: number): EvidencePointer {
    const row = evidenceRecord(value);
    evidenceKeys(row, [
        'schema',
        'kind',
        'generatedAt',
        'expiresAt',
        'generation',
        'indexSha256',
        'indexBytes',
        'indexPath',
    ]);
    evidenceRequire(
        row.schema === 1 &&
            row.kind === kind &&
            clock(nowSeconds) &&
            clock(row.generatedAt) &&
            clock(row.expiresAt) &&
            row.generatedAt <= nowSeconds &&
            nowSeconds < row.expiresAt &&
            row.expiresAt <= row.generatedAt + (kind === 'buoys' ? 5400 : 6 * 3600) &&
            typeof row.generation === 'string' &&
            SHA.test(row.generation) &&
            row.indexSha256 === row.generation &&
            row.indexPath === `generations/${row.generation}/index.json` &&
            integer(row.indexBytes, 1, EVIDENCE_LIMITS.index),
    );
    return Object.freeze({
        kind,
        generatedAt: row.generatedAt,
        expiresAt: row.expiresAt,
        generation: row.generation,
        indexBytes: row.indexBytes,
        indexPath: row.indexPath as string,
    });
}
function metadata(row: Record<string, unknown>): void {
    evidenceRequire(
        (row.network === 'ndbc' || row.network === 'qld-des') &&
            text(row.stationId, 80) &&
            /^[A-Za-z0-9-]+$/.test(row.stationId) &&
            row.key === `${row.network}:${row.stationId}` &&
            text(row.label, 200) &&
            bounded(row.lat, -90, 90) &&
            bounded(row.lon, -180, 180),
    );
    if (row.network === 'ndbc')
        evidenceRequire(
            /^[0-9]{5}$/.test(row.stationId) &&
                row.dataset === 'noaa-operated-realtime' &&
                row.owner === 'NOAA National Data Buoy Center' &&
                row.sourceUrl === 'https://www.ndbc.noaa.gov/faq/rt_data_access.shtml' &&
                row.licenceUrl === 'https://www.noaa.gov/office-education/outreach-communication/faq',
        );
    else
        evidenceRequire(
            row.dataset === 'coastal-data-system-near-real-time-wave-data' &&
                row.owner === 'Queensland Government' &&
                row.sourceUrl === 'https://www.data.qld.gov.au/dataset/coastal-data-system-near-real-time-wave-data' &&
                row.licenceUrl === 'https://creativecommons.org/licenses/by/4.0/',
        );
}
function sameStation(row: Record<string, unknown>, station: EvidenceStation): void {
    evidenceRequire(META.every((key) => row[key] === station[key]) && row.expiresAt === station.expiresAt);
}
function quality(row: Record<string, unknown>): void {
    evidenceRequire(text(row.qcBasis, 300));
    if (row.network === 'ndbc')
        evidenceRequire(
            row.quality === 'quality-controlled' &&
                row.qcBasis === 'NOAA NDBC automated realtime screening; preliminary; nominal mooring position',
        );
    else
        evidenceRequire(
            row.quality === 'provisional' && row.qcBasis === 'QLD operational Hs; provisional, range screened',
        );
}
export function decodeEvidenceIndex(value: unknown, pointer: EvidencePointer): EvidenceIndex {
    const row = evidenceRecord(value);
    evidenceKeys(row, [
        'schema',
        'kind',
        'generatedAt',
        'expiresAt',
        'registrySha256',
        'coverage',
        'heldNetworks',
        'stations',
    ]);
    evidenceRequire(
        row.schema === 1 &&
            row.kind === pointer.kind &&
            row.generatedAt === pointer.generatedAt &&
            row.expiresAt === pointer.expiresAt &&
            typeof row.registrySha256 === 'string' &&
            SHA.test(row.registrySha256) &&
            row.coverage === 'reviewed-fixed-stations' &&
            Array.isArray(row.stations) &&
            row.stations.length >= 1 &&
            row.stations.length <= (pointer.kind === 'skill' ? 64 : 256),
    );
    const held = evidenceRecord(row.heldNetworks);
    evidenceKeys(held, ['aodn', 'cmems-insitu']);
    evidenceRequire(text(held.aodn, 200) && text(held['cmems-insitu'], 200));
    let previous = '';
    let declaredBytes = pointer.indexBytes;
    const stations = row.stations.map((value): EvidenceStation => {
        const station = evidenceRecord(value);
        evidenceKeys(station, [
            ...META,
            'expiresAt',
            'detailSha256',
            'detailBytes',
            ...(pointer.kind === 'buoys' ? ['observedAt', 'hsM', 'quality', 'qcBasis'] : ['status']),
        ]);
        metadata(station);
        evidenceRequire(
            typeof station.key === 'string' &&
                station.key > previous &&
                clock(station.expiresAt) &&
                station.expiresAt > pointer.generatedAt &&
                typeof station.detailSha256 === 'string' &&
                SHA.test(station.detailSha256) &&
                integer(station.detailBytes, 1, EVIDENCE_LIMITS.detail),
        );
        previous = station.key;
        declaredBytes += station.detailBytes;
        evidenceRequire(declaredBytes <= EVIDENCE_LIMITS.session);
        if (pointer.kind === 'buoys') {
            evidenceRequire(
                clock(station.observedAt) &&
                    station.observedAt <= pointer.generatedAt &&
                    pointer.generatedAt - station.observedAt <= 3 * 3600 &&
                    station.expiresAt <= station.observedAt + 3 * 3600 &&
                    bounded(station.hsM, 0, 40),
            );
            quality(station);
        } else
            evidenceRequire(
                station.network === 'ndbc' &&
                    (station.status === 'warming' || station.status === 'ready') &&
                    station.expiresAt >= pointer.expiresAt &&
                    station.expiresAt <= pointer.generatedAt + 6 * 3600,
            );
        return Object.freeze({ ...station }) as unknown as EvidenceStation;
    });
    return Object.freeze({
        ...pointer,
        registrySha256: row.registrySha256,
        stations: Object.freeze(stations),
        heldNetworks: Object.freeze({ aodn: held.aodn, 'cmems-insitu': held['cmems-insitu'] }),
    });
}

export function decodeMeasuredBuoy(value: unknown, station: EvidenceStation, generatedAt: number): MeasuredBuoyDetail {
    const row = evidenceRecord(value);
    evidenceKeys(row, [
        'schema',
        ...META,
        'receivedAt',
        'rawSha256',
        'qcBasis',
        'quality',
        'expiresAt',
        'measured',
        'issuedForecasts',
    ]);
    sameStation(row, station);
    quality(row);
    evidenceRequire(
        row.schema === 1 &&
            clock(row.receivedAt) &&
            row.receivedAt <= generatedAt &&
            typeof row.rawSha256 === 'string' &&
            SHA.test(row.rawSha256) &&
            Array.isArray(row.measured) &&
            row.measured.length >= 1 &&
            row.measured.length <= 4096 &&
            Array.isArray(row.issuedForecasts) &&
            row.issuedForecasts.length <= 4,
    );
    const receivedAt = row.receivedAt;
    let previous = 0;
    const measured = row.measured.map((raw): readonly [number, number] => {
        evidenceRequire(
            Array.isArray(raw) &&
                raw.length === 2 &&
                clock(raw[0]) &&
                raw[0] > previous &&
                raw[0] >= generatedAt - 72 * 3600 &&
                raw[0] <= receivedAt &&
                bounded(raw[1], 0, 40),
        );
        previous = raw[0];
        return Object.freeze([raw[0], raw[1]] as const);
    });
    evidenceRequire(
        measured.at(-1)![0] === station.observedAt &&
            measured.at(-1)![1] === station.hsM &&
            row.quality === station.quality &&
            row.qcBasis === station.qcBasis,
    );
    const seen = new Set<string>();
    const issuedForecasts = row.issuedForecasts.map((raw): IssuedWaveLine => {
        const line = evidenceRecord(raw);
        evidenceKeys(line, ['model', 'lead', 'points']);
        evidenceRequire(
            typeof line.model === 'string' &&
                (ISSUED_WAVE_MODELS as readonly string[]).includes(line.model) &&
                !seen.has(line.model) &&
                line.lead === '0-6h' &&
                Array.isArray(line.points) &&
                line.points.length <= 73,
        );
        seen.add(line.model);
        let at = 0;
        const points = line.points.map((p): readonly [number, number, number, number] => {
            evidenceRequire(
                Array.isArray(p) &&
                    p.length === 4 &&
                    clock(p[0]) &&
                    p[0] > at &&
                    p[0] >= generatedAt - 72 * 3600 &&
                    p[0] <= generatedAt &&
                    bounded(p[1], 0, 40) &&
                    clock(p[2]) &&
                    clock(p[3]) &&
                    p[2] < p[3] &&
                    p[3] < p[0] &&
                    p[0] - p[2] <= 6 * 3600,
            );
            at = p[0];
            return Object.freeze([p[0], p[1], p[2], p[3]] as const);
        });
        return Object.freeze({ model: line.model, lead: '0-6h', points: Object.freeze(points) });
    });
    return Object.freeze({
        station,
        receivedAt: row.receivedAt,
        rawSha256: row.rawSha256,
        measured: Object.freeze(measured),
        issuedForecasts: Object.freeze(issuedForecasts),
    });
}

export function decodeStationSkill(value: unknown, station: EvidenceStation, generatedAt: number): StationSkillDetail {
    const row = evidenceRecord(value);
    evidenceKeys(row, ['schema', ...META, 'generatedAt', 'expiresAt', 'basis', 'metrics', 'automaticModelSelection']);
    sameStation(row, station);
    evidenceRequire(
        row.schema === 1 &&
            row.generatedAt === generatedAt &&
            row.basis === 'forward-captured' &&
            row.automaticModelSelection === false &&
            station.network === 'ndbc',
    );
    const raw = evidenceRecord(row.metrics);
    evidenceKeys(raw, ['wind_speed_mps', 'wave_hs_m']);
    const metrics = {} as Record<SkillMetric, Readonly<Record<SkillLead, IssuedSkill>>>;
    let anyReady = false;
    for (const metric of ['wind_speed_mps', 'wave_hs_m'] as const) {
        const group = evidenceRecord(raw[metric]);
        evidenceKeys(group, SKILL_LEADS);
        const parsed = {} as Record<SkillLead, IssuedSkill>;
        for (const lead of SKILL_LEADS) {
            parsed[lead] = decodeIssuedSkill(group[lead], station.key, metric, lead, generatedAt);
            anyReady ||= parsed[lead].status === 'ready';
        }
        metrics[metric] = Object.freeze(parsed);
    }
    evidenceRequire(station.status === (anyReady ? 'ready' : 'warming'));
    return Object.freeze({ station, metrics: Object.freeze(metrics) });
}
