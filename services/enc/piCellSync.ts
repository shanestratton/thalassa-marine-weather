/**
 * piCellSync — the boat's licensed charts, opened from her Pi (127-C-c).
 *
 * Licensed cells live in this phone's memory only (boatCellVault), so the Pi
 * is where they come from, every launch: o-charts (Roberto, 2026-10-10):
 * "Storing unencrypted data on any medium, and especially in the cloud, is
 * strictly prohibited by the terms of the licenses signed with the chart
 * providers." Over the boat's LAN only: never over remote access (C-d's rule;
 * this is the client's belt).
 *
 *  - The boat registry: `ensureBoatRegistry()` reads the Pi's index (metadata,
 *    no blobs) and registers every licensed cell in one batch, so the tracer,
 *    the background check and Auto know her charts before any blob arrives
 *    (decision 7a). Its state — 'none' (not paired, Pi off in this build, or
 *    the switch off), 'pending', 'loaded' or 'away' — changes only on
 *    transitions, never per cell (the kill #41 lesson).
 *  - `ensureBoatCells(bbox)` = the registry, then the box's licensed cells the
 *    vault lacks (Auto and Plan Your Day, before their gates).
 *  - `downloadPiCell(id)` pulls ONE cell (the load ladder, the chart's
 *    hydration walk). Every pull shares one limiter of 3, kind to a Pi that
 *    decrypts on demand.
 *
 * Fetch shape mirrors syncEncFromPi's per-cell pull: GET
 * /api/enc/installed/:cellId/data → { cells: [EncConversionResult] } →
 * EncHazardService.importCell. Fails fast and silent when the Pi isn't there.
 */

import { piCache } from '../PiCacheService';
import { fetchVerifiedFromPi, getPairing, getPiEquipmentReadRevision } from '../PiPairingService';
import { subscribeAuthIdentityScope, getAuthIdentityScope } from '../authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { canonicalEncCellId, ENC_CELL_BLOB_MAX_BYTES, ENC_CELL_ID_PATTERN, encCellStorageIdentity } from './types';
import type { EncCell, EncConversionBatch } from './types';
import { encCellContentIdentity } from './cellContentIdentity';
import { createLogger } from '../../utils/createLogger';
import { withTimeout } from '../../utils/deadline';
import { PI_INTEGRATION_ENABLED } from '../piPublicBetaBoundary';
import { BOAT_CELLS_ON_PHONE } from './boatCellVault';
import * as vault from './boatCellVault';
import { isProtectedChart } from './chartLicence';
import {
    cellsForBBox,
    clearBoatRecords,
    getCell,
    getRegisteredCell,
    subscribe as subscribeCells,
} from './EncCellMetadata';
import type { BoatChartsState } from './boatChartsWords';

const log = createLogger('piCellSync');

/** JS-side bound on one cell pull — CapacitorHttp's own readTimeout applies
 *  natively, but the web fetch fallback needs a deadline too. A detail cell is
 *  a few MB over boat wifi; 30 s is generous without hanging a route forever. */
const PI_PULL_DEADLINE_MS = 30_000;

/** Transport evidence only: this is neither tide/datum authority nor proof that
 * the chart blob is still held. A route must retain and check its real cohort. */
export interface PiChartReadEvidence {
    readonly cellContentKey: string;
    readonly readAtMs: number;
    readonly expiresAtMs: number;
}

interface ReadContext {
    ownerKey: string;
    ownerGeneration: number;
    boatId: string;
    boatGeneration: number;
    pairingKey: string;
    pairingRevision: number;
}
interface PendingRead {
    context: ReadContext;
    id: string;
    signedKey: string;
    deadlineMs: number;
    retired: boolean;
}
const READ_EVIDENCE_TTL_MS = 5 * 60_000;
const readEvidence = new Map<string, { evidence: PiChartReadEvidence; context: ReadContext; signedKey: string }>();
const pendingReads = new Set<PendingRead>();
let boatGeneration = 0;

// No record is restored from storage, serialized JSON or a caller's hash. Only
// the successful verified download/import transaction below can issue one.
function readContext(): ReadContext | null {
    const owner = getAuthIdentityScope();
    const boatId = useSettingsStore.getState().activeVesselId;
    const pairing = getPairing();
    if (!owner.userId || !boatId || !pairing?.deviceId || !pairing.publicKeySpki) return null;
    return {
        ownerKey: owner.key,
        ownerGeneration: owner.generation,
        boatId,
        boatGeneration,
        pairingKey: JSON.stringify([pairing.deviceId, pairing.publicKeySpki, pairing.fingerprint, pairing.pairedAt]),
        pairingRevision: getPiEquipmentReadRevision(),
    };
}
function sameReadContext(a: ReadContext, b: ReadContext | null): boolean {
    return b !== null && Object.keys(a).every((key) => a[key as keyof ReadContext] === b[key as keyof ReadContext]);
}
function signedCellKey(cell: EncCell | null): string | null {
    if (!cell || !/^[a-f0-9]{64}$/i.test(cell.contentSha256 ?? '')) return null;
    return JSON.stringify([
        encCellStorageIdentity(cell.id),
        cell.sourceHO,
        cell.edition,
        cell.updateNumber,
        cell.issued,
        cell.contentSha256?.toLowerCase(),
        cell.bbox,
        cell.usage ?? 'navigation',
        cell.licence,
    ]);
}
function retireReadEvidence(): void {
    readEvidence.clear();
    for (const pending of pendingReads) pending.retired = true;
}
function beginCellRead(cell: EncCell | null): PendingRead | null {
    wire();
    const context = readContext();
    const signedKey = signedCellKey(cell);
    if (!context || !signedKey || !cell || pendingReads.size >= 128) return null;
    const pending: PendingRead = {
        context,
        signedKey,
        id: canonicalEncCellId(cell.id),
        deadlineMs: Date.now() + PI_PULL_DEADLINE_MS * 2,
        retired: false,
    };
    pendingReads.add(pending);
    return pending;
}
function completeCellRead(pending: PendingRead | null, imported: EncCell): void {
    if (!pending || !pendingReads.delete(pending)) return;
    const now = Date.now();
    const current = getCell(pending.id);
    if (
        pending.retired ||
        now > pending.deadlineMs ||
        !sameReadContext(pending.context, readContext()) ||
        signedCellKey(imported) !== pending.signedKey ||
        signedCellKey(current) !== pending.signedKey ||
        !current
    )
        return;
    const evidence = Object.freeze({
        cellContentKey: encCellContentIdentity(current),
        readAtMs: now,
        expiresAtMs: now + READ_EVIDENCE_TTL_MS,
    });
    const identity = encCellStorageIdentity(current.id);
    readEvidence.delete(identity);
    readEvidence.set(identity, { evidence, context: pending.context, signedKey: pending.signedKey });
    while (readEvidence.size > 128) readEvidence.delete(readEvidence.keys().next().value!);
}

/** No I/O, refresh or persistence. Missing/legacy/expired evidence stays unknown. */
export function readPiChartReadEvidence(cell: EncCell, now = Date.now()): PiChartReadEvidence | null {
    wire();
    const record = readEvidence.get(encCellStorageIdentity(cell.id));
    if (!record) return null;
    const current = getCell(cell.id);
    if (
        !Number.isFinite(now) ||
        now < record.evidence.readAtMs ||
        now >= record.evidence.expiresAtMs ||
        !sameReadContext(record.context, readContext()) ||
        !current ||
        signedCellKey(current) !== record.signedKey ||
        signedCellKey(cell) !== record.signedKey ||
        encCellContentIdentity(current) !== record.evidence.cellContentKey ||
        encCellContentIdentity(cell) !== record.evidence.cellContentKey
    ) {
        readEvidence.delete(encCellStorageIdentity(cell.id));
        return null;
    }
    return record.evidence;
}

/** Identity comparison rejects a spread, parsed or fabricated receipt. */
export function isPiChartReadEvidenceCurrent(evidence: PiChartReadEvidence, cell: EncCell, now = Date.now()): boolean {
    return readPiChartReadEvidence(cell, now) === evidence;
}

// ── The boat registry (decision 7a) ───────────────────────────────

export type BoatRegistryState = 'none' | 'pending' | 'loaded' | 'away';
export type BoatAwayWhy = 'away' | 'tailnet' | 'off';

let state: 'idle' | 'pending' | 'loaded' | 'away' = 'idle';
let why: BoatAwayWhy | null = null;
let registering: Promise<BoatRegistryState> | null = null;
const subscribers = new Set<() => void>();

/** Paired, Pi integration on (never the web), and the Roberto switch on. */
const eligible = (): boolean => PI_INTEGRATION_ENABLED && BOAT_CELLS_ON_PHONE && getPairing() !== null;

export function boatRegistryState(): BoatRegistryState {
    if (state === 'idle') return eligible() ? 'pending' : 'none';
    return eligible() ? state : 'none';
}

/** Why the charts are not open here, when they are not. */
export function boatRegistryWhy(): BoatAwayWhy | null {
    if (!BOAT_CELLS_ON_PHONE && PI_INTEGRATION_ENABLED && getPairing()) return 'off';
    return boatRegistryState() === 'away' ? why : null;
}

/** Transitions only. */
export function subscribeBoatRegistry(fn: () => void): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

function setState(next: typeof state, reason: BoatAwayWhy | null = null): void {
    if (state === next && why === reason) return;
    state = next;
    why = reason;
    for (const fn of [...subscribers]) {
        try {
            fn();
        } catch (err) {
            log.warn('boat registry listener threw', err);
        }
    }
}

/** syncEncFromPi registered the Pi's index itself: the same transition, and the account flag. */
export function noteBoatRegistered(licensed: boolean): void {
    wire();
    setState('loaded');
    vault.logStats();
    // 127-DESKMAP C1: one boolean in user_settings, written only when it changes.
    writeBoatChartsFlag({ licensed });
}

/** The account flag, for a signed-in account only, and only when it changes. */
function writeBoatChartsFlag(value: { licensed: boolean } | null): void {
    if (!getAuthIdentityScope().userId) return;
    try {
        const store = useSettingsStore.getState();
        const now = store.settings?.boatCharts ?? null;
        if ((now?.licensed ?? null) !== (value?.licensed ?? null)) store.updateSettings({ boatCharts: value });
    } catch {
        /* settings not ready: re-asserted at the next registration */
    }
}

/** The index was asked for and did not come (Pi off the boat's Wi-Fi, refused, too slow). */
export function noteBoatAway(reason: BoatAwayWhy): void {
    wire();
    if (state !== 'loaded') setState('away', reason);
}

let wired = false;
function wire(): void {
    if (wired) return;
    wired = true;
    // Sign-out (decision 9): her licensed charts leave this phone's memory.
    subscribeAuthIdentityScope(() => {
        retireReadEvidence();
        if (!getAuthIdentityScope().userId) forgetBoatCharts();
    });
    useSettingsStore.subscribe((next, previous) => {
        if (next.activeVesselId === previous.activeVesselId) return;
        boatGeneration++;
        retireReadEvidence();
    });
    subscribeCells(() => {
        // A cell's A→B→A transition must retire A, while opening a different
        // member of a complete cohort must leave its earlier members intact.
        for (const pending of pendingReads) {
            if (signedCellKey(getRegisteredCell(pending.id)) !== pending.signedKey) pending.retired = true;
        }
        for (const [identity, record] of readEvidence) {
            const cell = getCell(identity);
            if (
                !cell ||
                signedCellKey(cell) !== record.signedKey ||
                encCellContentIdentity(cell) !== record.evidence.cellContentKey
            )
                readEvidence.delete(identity);
        }
    });
    // The charts come back without a tap when the Pi does (Wi-Fi on again).
    try {
        piCache.onStatusChange?.(() => {
            if (state === 'away' && piCache.isAvailable()) void ensureBoatRegistry();
        });
    } catch {
        /* no status feed: the next tracer open or poll asks again */
    }
}

/**
 * Register the boat's licensed charts from the Pi's index, if this session
 * hasn't: switch, pairing, mirror, ping (≤ 3 s), tailnet, the index, then one
 * batch. Pulls no blob, and is never deferred by plotting.
 */
export function ensureBoatRegistry(): Promise<BoatRegistryState> {
    if (!eligible()) return Promise.resolve('none');
    if (state === 'loaded') return Promise.resolve('loaded');
    wire();
    if (registering) return registering;
    // Stored before it can settle: an answer that comes back without an
    // await (over the tailnet) must not leave a settled promise behind.
    const run = registerBoat();
    registering = run;
    const done = (): void => {
        if (registering === run) registering = null;
    };
    void run.then(done, done);
    return run;
}

async function registerBoat(): Promise<BoatRegistryState> {
    // Pending once per session: a retry from 'away' stays 'away' until it
    // lands, so the tracer keeps its legs while the Pi is asked again.
    if (state === 'idle') setState('pending');
    try {
        if (!piCache.isAvailable()) await withTimeout<unknown>(piCache.ping(), null, 3_000);
        if (!piCache.isAvailable()) return away('away');
        // Answering, but not on her LAN: remote access.
        if (!piCache.lanBaseUrlNow()) return away('tailnet');
        const { listPiInstalledCharts, registerFromPiIndex } = await import('../EncImportService');
        const rows = await listPiInstalledCharts();
        if (!eligible()) return 'none'; // unpaired while the index came
        // An empty list from a Pi that just dropped off is not "no licensed charts".
        if (!rows.length && !piCache.isAvailable()) return away('away');
        registerFromPiIndex(rows);
        setState('loaded');
        return 'loaded';
    } catch (err) {
        log.warn(`boat registry: the Pi's chart index did not come (${err instanceof Error ? err.message : 'error'})`);
        return away('away');
    }
}

function away(reason: BoatAwayWhy): BoatRegistryState {
    noteBoatAway(reason);
    return boatRegistryState();
}

/** The registry, or whatever it is after `capMs` (the background check, decision 7a). */
export function whenBoatRegistrySettled(capMs: number): Promise<BoatRegistryState> {
    return withTimeout<BoatRegistryState | null>(ensureBoatRegistry(), null, capMs).then(
        (settled) => settled ?? boatRegistryState(),
    );
}

/** "Has licensed charts": unknown counts as yes while paired (decision 7a). */
export const boatHasLicensedCharts = (): boolean =>
    getPairing() !== null && useSettingsStore.getState().settings?.boatCharts?.licensed !== false;

/** The pairing's boat, else the vessel profile's, else null ("your boat"). */
export const boatName = (): string | null =>
    getPairing()?.boatName?.trim() || useSettingsStore.getState().settings?.vessel?.name?.trim() || null;

/** The words state for the map notice and the Charts card; null when there is nothing to say. */
export function boatChartsNow(): BoatChartsState | null {
    const reason = boatRegistryWhy();
    if (reason) return reason;
    return boatRegistryState() === 'pending' ? 'opening' : null;
}

/** Unpair or sign-out (decision 9): her licensed charts leave this phone's memory. Unpair also
 *  clears the account flag; another paired device re-asserts it at its next registration. */
export function forgetBoatCharts(unpaired = false): void {
    retireReadEvidence();
    clearBoatRecords();
    void import('./EncCellStore').then(({ clearProtectedBlobs }) => clearProtectedBlobs());
    vault.clear();
    registering = null;
    setState('idle');
    if (unpaired) writeBoatChartsFlag(null);
}

// ── Pulls ──────────────────────────────────────────────────────────

/**
 * Where a licensed cell may be pulled from, read in one tick at the moment of
 * the pull: the Pi's boat-LAN address, or null over remote access, with the
 * switch off or with no Pi. Never the live base, which turns to the tailnet
 * whenever a health check does (127-C-c review).
 */
export function boatLanBaseNow(): string | null {
    if (!PI_INTEGRATION_ENABLED || !BOAT_CELLS_ON_PHONE) return null;
    return piCache.lanBaseUrlNow();
}

/** One limiter of 3 concurrent Pi cell pulls across hydration, prewarm, corridor prefetch and ensure. */
const PULL_SLOTS = 3;
let pullsRunning = 0;
const pullQueue: Array<() => void> = [];

export async function withPiPullSlot<T>(job: () => Promise<T>): Promise<T> {
    if (pullsRunning >= PULL_SLOTS) await new Promise<void>((resolve) => pullQueue.push(resolve));
    pullsRunning += 1;
    try {
        return await job();
    } finally {
        pullsRunning -= 1;
        pullQueue.shift()?.();
    }
}

const inflight = new Map<string, Promise<boolean>>();

/**
 * Download one cell from the Pi into the local store. Deduped per cell.
 * Returns true when the blob is held (importCell succeeded). A licensed cell
 * comes from the boat's LAN address only, checked again when its slot comes
 * up, and is refused over remote access and with the switch off.
 */
export async function downloadPiCell(cellId: string): Promise<boolean> {
    if (!PI_INTEGRATION_ENABLED || !piCache.isAvailable()) return false;
    const canonicalId = canonicalEncCellId(cellId);
    if (!ENC_CELL_ID_PATTERN.test(canonicalId)) return false;
    const held = getRegisteredCell(canonicalId);
    const licensed = isProtectedChart(held ?? { id: canonicalId });
    if (licensed && !boatLanBaseNow()) return false;
    const identity = encCellStorageIdentity(canonicalId);
    const existing = inflight.get(identity);
    if (existing) return existing;
    const read = beginCellRead(held);
    const p = withPiPullSlot(async () => {
        try {
            // Asked again in the slot: the queue can outlast a turn to the tailnet.
            const base = licensed ? boatLanBaseNow() : piCache.baseUrl;
            if (!base) return false;
            // Signature-verified: this blob is imported straight into the
            // hazard model and routed over. The connect-time identity
            // challenge does NOT cover response bytes — an on-path attacker
            // can relay it and still tamper — so per-payload verification is
            // the defence. See PiPairingService.fetchVerifiedFromPi. The
            // registered revision's sha (from the Pi's signed index) binds
            // the bytes too, so the identity kept below is the truth.
            const blob = await fetchVerifiedFromPi<EncConversionBatch>({
                url: `${base}/api/enc/installed/${encodeURIComponent(canonicalId)}/data`,
                connectTimeout: 5_000,
                readTimeout: PI_PULL_DEADLINE_MS,
                maxResponseBytes: ENC_CELL_BLOB_MAX_BYTES + 1024 * 1024,
                expectedSha256: held?.contentSha256,
            });
            if (!blob || !Array.isArray(blob.cells) || blob.cells.length !== 1) return false;
            const { validateLocalEncPack } = await import('./localEncPackImport');
            const validated = validateLocalEncPack(blob).cells;
            if (validated.length !== 1 || encCellStorageIdentity(validated[0].cellId) !== identity) {
                log.warn(`pi cell ${canonicalId}: response identity did not match the requested path`);
                return false;
            }
            // Dynamic import breaks the would-be cycle EncCellStore → piCellSync
            // → EncHazardService → EncCellStore (same pattern as the cloud rung).
            const { importCell } = await import('./EncHazardService');
            // No index row here: keep the held record's Pi identity when these
            // are the same revision (2026-10-01 review; 127-C-c decision 7).
            const imported = await importCell(validated[0], { keepPiRevisionWhenUnchanged: true });
            completeCellRead(read, imported);
            log.warn(`pi cell ${canonicalId} pulled on demand`);
            return true;
        } catch (err) {
            log.warn(`pi cell ${canonicalId} pull failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        } finally {
            if (read) pendingReads.delete(read);
            inflight.delete(identity);
        }
    });
    const bounded = withTimeout(p, false, PI_PULL_DEADLINE_MS * 2);
    inflight.set(identity, bounded);
    return bounded;
}

export interface BoatCellsResult {
    state: BoatRegistryState;
    why?: BoatAwayWhy;
    pulled: number;
    ms: number;
    missing: number;
}

/**
 * The boat's licensed cells for a box, before a route's gates (decision 8b):
 * the registry, then the box's licensed cells the vault lacks, finest first,
 * at most `maxCells`. One warn line with counts, never a position.
 */
export async function ensureBoatCells(
    bbox: [number, number, number, number],
    { maxCells = 24 }: { maxCells?: number } = {},
): Promise<BoatCellsResult> {
    const t0 = Date.now();
    const registry = await ensureBoatRegistry();
    const reason = boatRegistryWhy() ?? undefined;
    if (registry !== 'loaded')
        return { state: registry, ...(reason ? { why: reason } : {}), pulled: 0, ms: Date.now() - t0, missing: 0 };
    const area = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1]);
    const want = cellsForBBox(bbox)
        .filter((cell) => isProtectedChart(cell) && !vault.has(cell.id))
        .sort((a, b) => area(a.bbox) - area(b.bbox));
    const results = await Promise.all(want.slice(0, maxCells).map((cell) => downloadPiCell(cell.id)));
    const pulled = results.filter(Boolean).length;
    const ms = Date.now() - t0;
    if (want.length) log.warn(`boat cells: opened ${pulled} of ${want.length} from the Pi in ${ms} ms`);
    return { state: 'loaded', pulled, ms, missing: want.length - pulled };
}
