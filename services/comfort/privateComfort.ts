import { supabase } from '../supabase';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { deleteLargeData, loadLargeData, saveLargeDataImmediate } from '../nativeStorage';
import { calculateDistance } from '../../utils/navigationCalculations';
import { qualifyComfortPreference, type PrivateComfortReport } from './qualifyPreference';
import type { ComfortPreference } from '../../utils/comfortPreference';
import { seaComfort } from '../../utils/seaComfort';
import { withTimeout } from '../../utils/deadline';
import { comfortCaptureCellFits } from './captureCell';

const KEY = 'thalassa_private_comfort_pending_v1';
const MAX_PENDING = 50,
    MAX_PENDING_AGE = 30 * 86400000;
interface Lease {
    boatId: string;
    context: string;
    epoch: string;
    revision: number;
}
export interface PrivateComfortState extends Lease {
    profile: ComfortPreference['profile'];
    reports: PrivateComfortReport[];
    preference: ComfortPreference;
}
interface Pending {
    owner: string;
    lease: Lease;
    operation: string;
    at: number;
    input: Record<string, unknown>;
    op: 'save' | 'delete';
    capture?: { voyageId: string; timestamp: string };
}
interface Context {
    auth: AuthIdentityScope;
    key: string;
    boat: string;
    revision: number;
    type: 'sail' | 'power';
    length: number;
}
let generation = 0,
    snapshot: PrivateComfortState | null = null,
    snapshotAt = 0;
let started = false,
    activeReads = 0,
    lane: Promise<unknown> = Promise.resolve();
let loading: { key: string; promise: Promise<PrivateComfortState | null> } | null = null;
const listeners = new Set<() => void>();
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function context(): Context | null {
    if (typeof useSettingsStore.getState !== 'function') return null;
    const auth = getAuthIdentityScope(),
        store = useSettingsStore.getState();
    const owned = Array.isArray(store.vesselFleet)
        ? store.vesselFleet.find(
              (v) => v.id === store.activeVesselId && v.owner_id === auth.userId && !v.archived_at && !v.releasedAt,
          )
        : null;
    if (
        !auth.userId ||
        !owned ||
        !store.settings ||
        store.vesselFleetStatus !== 'saved' ||
        !['sail', 'power'].includes(owned.profile.type) ||
        !Number.isSafeInteger(owned.revision) ||
        owned.revision < 1 ||
        !Number.isFinite(owned.profile.length) ||
        !(owned.profile.length > 0 && owned.profile.length <= 1000)
    )
        return null;
    return {
        auth,
        boat: owned.id,
        revision: owned.revision,
        type: owned.profile.type as 'sail' | 'power',
        length: owned.profile.length,
        key: `${auth.key}:${auth.generation}:${owned.id}:${owned.revision}:${JSON.stringify(owned.profile)}:${JSON.stringify(store.settings.vessel)}`,
    };
}
function current(c: Context, gen: number) {
    return generation === gen && isAuthIdentityScopeCurrent(c.auth) && context()?.key === c.key;
}
function notify() {
    for (const fn of listeners) fn();
}
function retire() {
    generation++;
    snapshot = null;
    snapshotAt = 0;
    loading = null;
    notify();
}
function start() {
    if (started) return;
    started = true;
    subscribeAuthIdentityScope(retire);
    let previous = context()?.key;
    if (typeof useSettingsStore.subscribe === 'function')
        useSettingsStore.subscribe(() => {
            const next = context()?.key;
            if (next !== previous) {
                previous = next;
                retire();
            }
        });
}
export function subscribePrivateComfort(fn: () => void) {
    start();
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}
export function privateComfortSnapshot() {
    return snapshot;
}
export function privateComfortViewKey() {
    const c = context();
    return c
        ? `${c.key}:${generation}:${snapshot?.epoch ?? ''}:${snapshot && snapshotAt + 60000 > Date.now() ? JSON.stringify(snapshot.preference) : ''}`
        : null;
}
export async function pendingPrivateComfort(): Promise<{
    key: string;
    rows: { operation: string; level: number; at: number }[];
} | null> {
    const c = context(),
        gen = generation;
    if (!c) return null;
    const rows = await pending(c.auth);
    if (!current(c, gen)) return null;
    return {
        key: privateComfortViewKey()!,
        rows: rows
            .filter((v) => v.lease.boatId === c.boat && v.op === 'save')
            .map((v) => ({ operation: v.operation, level: Number(v.input.level), at: v.at })),
    };
}
export function personalComfortPreference(): ComfortPreference | null {
    const c = context();
    return c &&
        snapshot &&
        snapshot.boatId === c.boat &&
        snapshot.revision === c.revision &&
        snapshotAt + 60000 > Date.now() &&
        snapshot.profile.type === c.type &&
        snapshot.profile.length === c.length
        ? snapshot.preference
        : null;
}
function decode(raw: unknown, c: Context): PrivateComfortState | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>,
        p = r.profile as Record<string, unknown> | null;
    if (
        r.boatId !== c.boat ||
        !uuid(r.context) ||
        !uuid(r.epoch) ||
        r.revision !== c.revision ||
        !p ||
        p.type !== c.type ||
        p.length !== c.length ||
        !Array.isArray(r.reports) ||
        r.reports.length > 120
    )
        return null;
    const reports: PrivateComfortReport[] = [];
    for (const value of r.reports) {
        if (!value || typeof value !== 'object') return null;
        const row = value as PrivateComfortReport;
        if (
            typeof row.operation !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(row.operation) ||
            typeof row.voyageId !== 'string' ||
            !row.voyageId ||
            row.voyageId.length > 256 ||
            !Number.isInteger(row.level) ||
            typeof row.qualified !== 'boolean' ||
            row.level < 0 ||
            row.level > 3 ||
            ![row.capturedAt, row.fetchedAt, row.validAt].every(
                (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)),
            ) ||
            !row.parts ||
            !('windSea' in row.parts) ||
            !('swell' in row.parts) ||
            !seaComfort(row.parts, { type: c.type, length: c.length })
        )
            return null;
        reports.push({
            qualified: row.qualified,
            operation: row.operation,
            voyageId: row.voyageId,
            capturedAt: row.capturedAt,
            level: row.level,
            parts: structuredClone(row.parts),
            fetchedAt: row.fetchedAt,
            validAt: row.validAt,
        });
    }
    const profile = { type: c.type, length: c.length, revision: c.revision };
    return {
        boatId: c.boat,
        context: r.context,
        epoch: r.epoch,
        revision: c.revision,
        profile,
        reports,
        preference: qualifyComfortPreference(profile, reports),
    };
}
async function rpc(action: string, input: Record<string, unknown>, c: Context, gen: number, timeoutMs = 6000) {
    if (!supabase || !current(c, gen) || activeReads >= 4) return null;
    activeReads++;
    let alive = true;
    const task = (async () => {
        const session = await supabase.auth.getSession();
        if (!alive || !current(c, gen) || session.data.session?.user.id !== c.auth.userId) return null;
        const response = await supabase.rpc('private_passage_comfort', { p_action: action, p_input: input });
        if (!alive || !current(c, gen)) return null;
        if (response.error) {
            const error = new Error('Private comfort is unavailable.') as Error & { code?: string };
            error.code = response.error.code;
            throw error;
        }
        return decode(response.data, c);
    })().finally(() => {
        activeReads--;
    });
    try {
        return await withTimeout(task, null, Math.min(6000, Math.max(1, timeoutMs)));
    } finally {
        alive = false;
    }
}
export async function loadPrivateComfort(): Promise<PrivateComfortState | null> {
    start();
    const c = context(),
        gen = generation;
    if (!c) return null;
    if (snapshot && personalComfortPreference()) return snapshot;
    const key = `${c.key}:${gen}`;
    if (loading?.key === key) return loading.promise;
    const promise = (async () => {
        const value = await rpc('state', {}, c, gen).catch(() => null);
        if (!current(c, gen) || !value) return null;
        snapshot = value;
        snapshotAt = Date.now();
        notify();
        return value;
    })().finally(() => {
        if (loading?.promise === promise) loading = null;
    });
    loading = { key, promise };
    return promise;
}
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = lane.catch(() => undefined).then(fn);
    lane = next;
    return next;
}
async function pending(scope: AuthIdentityScope): Promise<Pending[]> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return [];
    const raw = await loadLargeData(authScopedStorageKey(KEY, scope));
    if (!isAuthIdentityScopeCurrent(scope) || !raw || typeof raw !== 'object') return [];
    const data = raw as { version?: unknown; owner?: unknown; pending?: unknown };
    if (
        data.version !== 1 ||
        data.owner !== scope.userId ||
        !Array.isArray(data.pending) ||
        data.pending.length > MAX_PENDING
    )
        return [];
    return data.pending.filter(
        (v): v is Pending =>
            !!v &&
            typeof v === 'object' &&
            v.owner === scope.userId &&
            uuid(v.lease?.boatId) &&
            uuid(v.lease?.epoch) &&
            uuid(v.lease?.context) &&
            Number.isSafeInteger(v.lease?.revision) &&
            typeof v.operation === 'string' &&
            /^[A-Za-z0-9_-]{1,128}$/.test(v.operation) &&
            ['save', 'delete'].includes(v.op) &&
            (v.op === 'delete' ||
                (!!v.capture &&
                    typeof v.capture.voyageId === 'string' &&
                    v.capture.voyageId.length > 0 &&
                    v.capture.voyageId.length <= 256 &&
                    typeof v.capture.timestamp === 'string' &&
                    Number.isFinite(Date.parse(v.capture.timestamp)))) &&
            Number.isFinite(v.at) &&
            v.at <= Date.now() + 5000 &&
            v.at >= Date.now() - MAX_PENDING_AGE &&
            !!v.input &&
            typeof v.input === 'object' &&
            JSON.stringify(v.input).length <= 4096,
    );
}
async function persist(scope: AuthIdentityScope, rows: Pending[]) {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed.');
    await saveLargeDataImmediate(authScopedStorageKey(KEY, scope), { version: 1, owner: scope.userId, pending: rows });
}
const leaseInput = (s: Lease) => ({ context: s.context, epoch: s.epoch, revision: s.revision });
/** Explicit foreground action. Uses an actual retained capture, not the selected
 * Glass point or its cached weather, and does not upload the active voyage. */
export async function reportPrivateComfort(level: number): Promise<string> {
    start();
    const c = context(),
        gen = generation,
        reportedAt = Date.now();
    if (!c || !Number.isInteger(level) || level < 0 || level > 3 || document.visibilityState !== 'visible')
        throw new Error('Open this on the current owned vessel while recording a passage.');
    const { ShipLogService } = await import('../ShipLogService');
    const status = ShipLogService.getPublishedTrackingStatus(),
        original = ShipLogService.getLastAcceptedFix();
    const shoreEvidence = ShipLogService.getComfortShoreEvidence();
    const fix = original ? { ...original } : null;
    if (
        !current(c, gen) ||
        !status.isTracking ||
        status.isPaused ||
        status.boatId !== c.boat ||
        !status.currentVoyageId ||
        !fix ||
        !Number.isFinite(fix.timestamp) ||
        fix.timestamp > reportedAt + 5000 ||
        fix.timestamp < reportedAt - 45000
    )
        throw new Error('A fresh accepted GPS fix on this recording is required.');
    const { getOfflineEntries } = await import('../shiplog/OfflineQueue');
    const rows = await getOfflineEntries({ voyageId: status.currentVoyageId, expectedScope: c.auth });
    if (!current(c, gen)) throw new Error('Vessel or account changed.');
    const capture = rows
        .filter(
            (row) =>
                row.userId === c.auth.userId &&
                row.boatId === c.boat &&
                row.source === 'device' &&
                row.voyageId === status.currentVoyageId &&
                ['auto', 'manual', 'waypoint'].includes(row.entryType) &&
                Number.isFinite(Date.parse(row.timestamp)) &&
                Date.parse(row.timestamp) >= reportedAt - 300000 &&
                Date.parse(row.timestamp) <= reportedAt + 5000 &&
                calculateDistance(fix.latitude, fix.longitude, row.latitude, row.longitude) * 1.852 <= 0.5,
        )
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
    const operation = capture?.clientOperationId ?? (capture?.id.startsWith('offline_') ? capture.id.slice(8) : null);
    if (!capture || !operation || !/^[A-Za-z0-9_-]{1,128}$/.test(operation))
        throw new Error('Wait for an actual passage point to be recorded.');
    const state = await loadPrivateComfort();
    const { fetchMarineModelV2 } = await import('../weather/api/marineModel');
    const { assessShelterExactPoint } = await import('../weather/shelter');
    const [marine, shelter] = await Promise.all([
        fetchMarineModelV2(capture.latitude, capture.longitude),
        withTimeout(
            assessShelterExactPoint(capture.latitude, capture.longitude).catch(() => null),
            null,
            4500,
        ),
    ]);
    if (
        !current(c, gen) ||
        !state ||
        !marine ||
        !shelter ||
        shelter.enclosed ||
        !marine.waveCell?.local ||
        !comfortCaptureCellFits(shoreEvidence, capture, marine.waveCell.snappedKm) ||
        marine.waveCurrentAtMs === null ||
        !marine.currentParts.total ||
        !seaComfort(marine.currentParts, { type: c.type, length: c.length })?.word ||
        marine.fetchedAtMs < reportedAt - 1800000 ||
        marine.fetchedAtMs > reportedAt + 300000 ||
        marine.waveCurrentAtMs < reportedAt - 1800000 ||
        marine.waveCurrentAtMs > reportedAt + 300000
    )
        throw new Error('No contemporaneous local wave model; no qualified report was saved.');
    return serial(async () => {
        if (!current(c, gen)) throw new Error('Vessel or account changed.');
        const queue = await pending(c.auth);
        if (queue.some((v) => v.operation === operation && v.lease.boatId === c.boat && v.lease.epoch === state.epoch))
            throw new Error('This passage point already has a private report.');
        if (queue.length >= MAX_PENDING)
            throw new Error('50 private reports are pending. Finish ordinary log sync before adding more.');
        const input = {
            ...leaseInput(state),
            operation,
            reportedAt: new Date(reportedAt).toISOString(),
            fixAt: new Date(fix.timestamp).toISOString(),
            latitude: fix.latitude,
            longitude: fix.longitude,
            level,
            parts: marine.currentParts,
            fetchedAt: new Date(marine.fetchedAtMs).toISOString(),
            validAt: new Date(marine.waveCurrentAtMs).toISOString(),
        };
        queue.push({
            owner: c.auth.userId!,
            lease: { boatId: c.boat, ...leaseInput(state) },
            operation,
            at: reportedAt,
            input,
            op: 'save',
            capture: { voyageId: capture.voyageId, timestamp: capture.timestamp },
        });
        await persist(c.auth, queue);
        return 'Saved privately on this device. It will sync after the ordinary voyage log uploads.';
    });
}
/** Invoked after the ordinary log outbox only. A private failure never changes
 * the parent log's success and never forces a live voyage upload. */
export function drainPrivateComfortReports(): Promise<void> {
    return serial(async () => {
        start();
        const c = context(),
            gen = generation;
        if (!c) return;
        const deadline = performance.now() + 12000;
        let queue = await pending(c.auth);
        for (const row of queue.filter((v) => v.lease.boatId === c.boat).slice(0, 8)) {
            if (!current(c, gen) || performance.now() >= deadline) return;
            let remove = false;
            try {
                if (row.op === 'save') {
                    const { shipLogCaptureRetired } = await import('../shiplog/OfflineQueue');
                    if (!row.capture) return;
                    const retired = await shipLogCaptureRetired(
                        row.operation,
                        row.capture.voyageId,
                        row.capture.timestamp,
                        c.auth,
                    );
                    if (retired === null) return;
                    if (retired) {
                        if (!current(c, gen)) return;
                        row.op = 'delete';
                        row.input = { ...leaseInput(row.lease), operation: row.operation };
                        delete row.capture;
                        await persist(c.auth, queue);
                    }
                }
                if (!current(c, gen)) return;
                const remaining = deadline - performance.now();
                if (remaining <= 0) return;
                const value = await rpc(row.op, row.input, c, gen, remaining);
                if (value && current(c, gen)) {
                    snapshot = value;
                    snapshotAt = Date.now();
                    notify();
                    remove = true;
                }
            } catch (e) {
                remove = ['40001', '55000', '22023'].includes((e as { code?: string }).code ?? '');
            }
            if (!current(c, gen)) return;
            if (remove) {
                queue = queue.filter((v) => v !== row);
                await persist(c.auth, queue);
            }
        }
    });
}
export function deletePrivateComfort(operation: string): Promise<void> {
    return serial(async () => {
        const c = context(),
            s = snapshot;
        if (!c || !s || !/^[A-Za-z0-9_-]{1,128}$/.test(operation))
            throw new Error('Open the current private reports first.');
        retire();
        const gen = generation;
        const queue = (await pending(c.auth)).filter((v) => !(v.lease.boatId === c.boat && v.operation === operation));
        if (queue.length >= MAX_PENDING) throw new Error('Private report queue is full.');
        const input = { ...leaseInput(s), operation };
        queue.push({
            owner: c.auth.userId!,
            lease: { boatId: c.boat, ...leaseInput(s) },
            operation,
            at: Date.now(),
            input,
            op: 'delete',
        });
        await persist(c.auth, queue);
        const value = await rpc('delete', input, c, gen).catch(() => null);
        if (value && current(c, gen)) {
            await persist(
                c.auth,
                queue.filter((v) => v.operation !== operation || v.lease.boatId !== c.boat),
            );
            snapshot = value;
            snapshotAt = Date.now();
            notify();
        }
    });
}
export function resetPrivateComfort(): Promise<void> {
    return serial(async () => {
        const c = context(),
            s = snapshot;
        if (!c || !s) throw new Error('Open the current private reports first.');
        retire();
        const gen = generation;
        const value = await rpc('reset', leaseInput(s), c, gen);
        if (!current(c, gen) || !value)
            throw new Error('Reset could not be confirmed. Reopen before using a preference.');
        const queue = (await pending(c.auth)).filter((v) => v.lease.boatId !== c.boat);
        await persist(c.auth, queue);
        snapshot = value;
        snapshotAt = Date.now();
        notify();
    });
}
export async function purgePrivateComfortForUser(userId: string): Promise<void> {
    retire();
    await serial(() => deleteLargeData(authScopedStorageKey(KEY, { userId, key: `user:${userId}`, generation: -1 })));
}
