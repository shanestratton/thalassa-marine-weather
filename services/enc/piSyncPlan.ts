/**
 * Which of the Pi's charts this phone still needs — ONE answer, shared by the
 * ENC sheet's "Sync N charts from Pi" count and by syncEncFromPi itself.
 *
 * Two independent definitions of "already on this device" is how the sheet
 * and the service drifted apart before (2026-08-07, see encCellSyncKey). The
 * count and the sync must agree, so both read this plan.
 *
 * 2026-10-01 (Shane's "Sync 12 charts from Pi" that never reached 0): the
 * count included two kinds of chart a sync can never add.
 *
 *   - Charts the phone REJECTS: five Pi cells (OC-61-031514, OC-61-360864,
 *     OC-33-A/B/C94074) carry no DEPARE/DRGARE depth areas, and the phone's
 *     pack validator rightly refuses a chart that cannot verify water depths.
 *     Every sync downloaded them again, refused them again, and left the count
 *     where it was. The phone now remembers the refusal against the Pi's
 *     CONTENT identity, so the same bytes are not offered again while a
 *     corrected re-issue (new edition or new bytes) is.
 *   - Charts the phone ALREADY HOLDS under a legacy Pi entry: seven index rows
 *     from before the Pi stamped contentSha256 (US5GA22M, OC-61-0P0525,
 *     OC-61-1P4525, OC-61-1P8625, OC-61-2P4525, FR466870, GB501494) are keyed
 *     on id@edition@size. The Pi's size is the byte length of its own file —
 *     the {cells:[...]} wrapper and fields the phone drops (cellName, stats) —
 *     while the phone recorded the byte length of the cell IT re-serialised.
 *     Measured on OC-61-1P8625: Pi 1,085,565, phone 1,084,874. They can never
 *     be equal, so those seven read as missing forever and were re-downloaded
 *     on every sync. The phone now records the size the Pi REPORTED for the
 *     copy it pulled (`piSizeBytes`) and matches on that.
 */

import { encCellStorageIdentity } from './types';
import type { EncCell } from './types';

/**
 * The identity that decides whether a Pi cell is ALREADY on this device.
 *
 * Exported because the ENC Charts UI has to answer the same question, and
 * answering it differently is worse than not answering it at all. It keyed on
 * `cellId@edition` alone, so a cell the Pi had RE-EXTRACTED — same id, same
 * chart edition, different bytes — looked identical to one already held. The
 * sheet said "Pi charts already in sync", the Sync button never appeared, and
 * the per-chart picker is gated on the same flag, so there was no way to pull
 * it either. (Shane 2026-08-07, after the S-63 mesh fix re-extracted Noumea
 * and Port Vila: the improved charts sat on the Pi, unreachable, while the app
 * insisted everything was current.)
 *
 * `sizeBytes` is the re-extraction signal: the S-57 edition doesn't change
 * when OUR extractor improves, but the byte count does. Unknown size sorts as
 * its own value, so a legacy cell that predates the field re-imports once
 * rather than being pinned forever.
 */
export function encCellSyncKey(cellId: string, edition: number, sizeBytes?: number, contentSha256?: string): string {
    if (contentSha256 && /^[a-f0-9]{64}$/.test(contentSha256)) {
        return `${encCellStorageIdentity(cellId)}@${edition}@sha256:${contentSha256}`;
    }
    return `${encCellStorageIdentity(cellId)}@${edition}@${sizeBytes ?? 'unknown'}`;
}

/** A Pi index row, as far as deciding whether the phone needs it goes. */
export interface PiSyncCandidate {
    cellId: string;
    edition?: number;
    sizeBytes?: number;
    contentSha256?: string;
}

/** The fields of a phone-held chart that identify the Pi revision it came from. */
export type HeldCellIdentity = Pick<EncCell, 'id' | 'sizeBytes' | 'contentSha256' | 'piSizeBytes'> & {
    edition?: number;
};

/** The Pi's identity for one of its index rows. */
export function piCandidateSyncKey(cell: PiSyncCandidate): string {
    return encCellSyncKey(cell.cellId, cell.edition ?? 0, cell.sizeBytes, cell.contentSha256);
}

/**
 * Every Pi identity a phone-held copy answers to.
 *
 * The size compared is the one the PI reported for the copy we pulled
 * (`piSizeBytes`), falling back to the phone's own byte count for copies
 * written before that was recorded — those cannot be matched against a
 * legacy Pi row and are pulled once more, which records it (the same
 * "re-import once rather than be pinned forever" rule as an unknown size).
 *
 * A copy with a content hash answers to its hash AND to id + edition + size:
 * a Pi row with no contentSha256 has nothing else to offer, and matching it
 * on id + edition + size is the legacy rule.
 */
export function heldCellSyncKeys(cell: HeldCellIdentity): string[] {
    const edition = cell.edition ?? 0;
    const size = cell.piSizeBytes ?? cell.sizeBytes;
    const keys = [encCellSyncKey(cell.id, edition, size)];
    if (cell.contentSha256) keys.push(encCellSyncKey(cell.id, edition, size, cell.contentSha256));
    return keys;
}

// ── Charts this phone refused for want of depth areas ─────────────

/** `code` of the pack validator's EncMissingDepthAreaError. */
export const ENC_NO_DEPTH_AREAS_CODE = 'enc-no-depth-areas';

/** The phone refused a chart because it has no DEPARE/DRGARE depth areas. */
export function isEncMissingDepthAreaError(err: unknown): boolean {
    return err instanceof Error && (err as { code?: unknown }).code === ENC_NO_DEPTH_AREAS_CODE;
}

const DEPTHLESS_KEY = 'thalassa.enc.piDepthless.v1';
/** Bound the record: a Pi holds ~1,000 cells today, a handful of them bad. */
const DEPTHLESS_MAX = 500;

function readDepthless(): string[] {
    try {
        const raw = localStorage.getItem(DEPTHLESS_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

function writeDepthless(keys: string[]): void {
    try {
        localStorage.setItem(DEPTHLESS_KEY, JSON.stringify(keys.slice(-DEPTHLESS_MAX)));
    } catch {
        // Storage unavailable: the chart is simply offered again next time,
        // which is the pre-2026-10-01 behaviour — never a hidden chart.
    }
}

/** Remember that the phone refused THIS revision of a Pi chart for having no depth areas. */
export function rememberPiCellWithoutDepthAreas(cell: PiSyncCandidate): void {
    const key = piCandidateSyncKey(cell);
    const keys = readDepthless().filter((existing) => existing !== key);
    keys.push(key);
    writeDepthless(keys);
}

/** A chart imported cleanly: forget any refusal recorded for any revision of it. */
export function forgetPiCellWithoutDepthAreas(cellId: string): void {
    const prefix = `${encCellStorageIdentity(cellId)}@`;
    const keys = readDepthless();
    const kept = keys.filter((key) => !key.startsWith(prefix));
    if (kept.length !== keys.length) writeDepthless(kept);
}

export interface PiSyncPlan<T extends PiSyncCandidate> {
    /** Pi charts a sync would add or refresh on this phone. */
    pending: T[];
    /** Pi charts this phone already refused at exactly this revision: no depth areas. */
    withoutDepthAreas: T[];
}

/**
 * Split the Pi's index into what a sync can add and what it cannot.
 * Charts already held are in neither list.
 */
export function planPiCellSync<T extends PiSyncCandidate>(
    installed: readonly T[],
    held: readonly HeldCellIdentity[],
): PiSyncPlan<T> {
    const heldKeys = new Set(held.flatMap(heldCellSyncKeys));
    const refused = new Set(readDepthless());
    const pending: T[] = [];
    const withoutDepthAreas: T[] = [];
    for (const cell of installed) {
        const key = piCandidateSyncKey(cell);
        if (heldKeys.has(key)) continue;
        (refused.has(key) ? withoutDepthAreas : pending).push(cell);
    }
    return { pending, withoutDepthAreas };
}
