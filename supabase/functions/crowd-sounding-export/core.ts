import { decodeSeabedCsv } from '../_shared/seabedCore.ts';
import { CROWD_LIMITS, type CrowdSource, qualifyCrowdRow, requireCrowdRelease } from '../_shared/crowdPolicy.ts';

type Purpose = 'map' | 'dcdb';
export interface ExportPorts {
    candidate(id: string, purpose: Purpose, signal: AbortSignal): Promise<unknown>;
    object(path: string, signal: AbortSignal): Promise<Uint8Array>;
    inflate(bytes: Uint8Array, signal: AbortSignal): Promise<string>;
    now(): number;
}
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{64}$/.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const refuse = (): never => {
    throw Error('Current private sounding source is unavailable');
};
export function stable(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (record(value)) {
        return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    }
    const text = JSON.stringify(value);
    if (text === undefined) return refuse();
    return text;
}
export async function digest(bytes: Uint8Array): Promise<string> {
    return Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)),
        (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
}
/** Read-only private export. The token handler owns authentication; JSON never supplies source authority. */
export async function readExportedBatch(id: unknown, purpose: unknown, ports: ExportPorts, signal: AbortSignal) {
    if (!uuid(id) || !['map', 'dcdb'].includes(String(purpose)) || signal.aborted) return refuse();
    const opened = ports.now();
    const kind = purpose as Purpose;
    const first = await ports.candidate(id, kind, signal);
    if (
        !record(first) || first.schema !== 1 || first.purpose !== kind || first.batchId !== id ||
        !uuid(first.ownerId) || !uuid(first.boatId) || !uuid(first.csbUuid) || !uuid(first.consentRevision) ||
        !hash(first.sentSha256) || typeof first.objectPath !== 'string' || first.objectPath.length > 240 ||
        !first.objectPath.startsWith(first.ownerId + '/') || first.objectPath.includes('..') ||
        !Number.isSafeInteger(first.storedBytes) || (first.storedBytes as number) < 1 ||
        (first.storedBytes as number) > CROWD_LIMITS.batchBytes ||
        !Number.isInteger(first.rowCount) || (first.rowCount as number) < 1 ||
        (first.rowCount as number) > CROWD_LIMITS.rows ||
        !record(first.captureMeta) || !Array.isArray(first.privacyZones) || typeof first.platformRevision !== 'string'
    ) return refuse();
    const identity = stable(first);
    if (identity.length > 16384 || signal.aborted) return refuse();
    const raw = await ports.object(first.objectPath, signal);
    if (signal.aborted || !raw.length || raw.length !== first.storedBytes || raw.length > CROWD_LIMITS.batchBytes) {
        return refuse();
    }
    const originalStoredSha256 = await digest(raw);
    const text = await ports.inflate(raw, signal);
    if (signal.aborted || new TextEncoder().encode(text).length > CROWD_LIMITS.batchBytes) return refuse();
    const decoded = decodeSeabedCsv(text, ports.now());
    if (!decoded.ok || decoded.rows.length !== first.rowCount) return refuse();
    const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
    const source: CrowdSource = {
        ownerId: first.ownerId,
        boatId: first.boatId,
        batchId: id,
        originalStoredSha256,
        capturedStart: time(first.capturedStart),
        capturedEnd: time(first.capturedEnd),
        eligibleAfter: time(first.eligibleAfter),
        meta: first.captureMeta,
        privacyZones: first.privacyZones as CrowdSource['privacyZones'],
        consent: {
            ownerId: first.ownerId,
            boatId: first.boatId,
            revision: first.consentRevision,
            consentVersion: first.consentVersion as CrowdSource['consent']['consentVersion'],
            mapEnabled: first.mapEnabled as boolean,
            dcdbEnabled: first.dcdbEnabled as boolean,
            effectiveFrom: time(first.effectiveFrom),
            calibration: first.calibration as CrowdSource['consent']['calibration'],
        },
    };
    requireCrowdRelease(source, kind, ports.now());
    // Current exclusions are reapplied, including a grid-footprint privacy buffer.
    const rows = decoded.rows.filter((row) => {
        try {
            qualifyCrowdRow(source, row, kind, ports.now());
            return true;
        } catch {
            return false;
        }
    });
    if (!rows.length || signal.aborted) return refuse();
    const sourceKey = await digest(new TextEncoder().encode(identity + '\n' + originalStoredSha256));
    const second = await ports.candidate(id, kind, signal);
    if (signal.aborted || stable(second) !== identity) return refuse();
    const now = ports.now();
    if (!Number.isSafeInteger(opened) || now < opened) return refuse();
    requireCrowdRelease(source, kind, now);
    // The worker must recheck this receipt immediately before final emission; it is not a DB lock.
    return {
        schema: 1,
        purpose: kind,
        sourceKey,
        originalStoredSha256,
        sentSha256: first.sentSha256,
        checkedAt: now,
        expiresAt: now + 60000,
        source,
        csbUuid: first.csbUuid,
        rows,
        caveat: 'Private current-source snapshot; revocation is not transaction-locked across network publication.',
    };
}
