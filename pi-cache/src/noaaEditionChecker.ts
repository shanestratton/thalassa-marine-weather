/** Update8 candidate only. Fixed public metadata, no chart bytes or vendor queries. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeChartFileAtomic } from './encChartStore.js';
import { piChartLicence } from './chartLicence.js';
import { parseNoaaIndex } from './noaaEdition/noaaCatalogueContract.js';
import {
    NOAA_CATALOGUE_BASE,
    noaaEditionChanges,
    parseNoaaRevisions,
    type NoaaInstalledRevision,
    type NoaaEditionChange,
} from './noaaEdition/noaaEditionPolicy.js';
export interface NoaaEditionOwner {
    ownerId: string;
    piDeviceId: string;
    pairingId: string;
    revision: string;
}
export interface NoaaEditionNotice {
    schema: 1;
    owner: NoaaEditionOwner;
    generation: string;
    sourceSha256: string;
    sourceAt: string;
    checkedAt: string;
    more: boolean;
    changes: NoaaEditionChange[];
}
export interface NoaaEditionState {
    schema: 1;
    namespace: string;
    lastAttemptAt: number;
    lastCheckedAt: number;
    sourceAt: string | null;
    checkedAt: string | null;
    day: string;
    sent: number;
    pending: number;
    incomplete: boolean;
    notified: Array<{ id: string; edition: number; update: number }>;
}
export interface NoaaEditionStateStore {
    load(namespace: string): Promise<NoaaEditionState>;
    save(state: NoaaEditionState): Promise<void>;
}
const MAX_STATE = 1024 * 1024,
    DAY = 86400000,
    RETRY = 3600000;
const ID = /^US[1-6][A-Z0-9]{5}$/,
    UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function owner(value: NoaaEditionOwner | null): NoaaEditionOwner | null {
    return value &&
        Object.keys(value).sort().join(',') === 'ownerId,pairingId,piDeviceId,revision' &&
        [value.ownerId, value.piDeviceId, value.pairingId, value.revision].every(
            (n) => typeof n === 'string' && UUID.test(n),
        )
        ? { ...value }
        : null;
}
const namespace = (value: NoaaEditionOwner) =>
    createHash('sha256')
        .update(JSON.stringify([value.ownerId, value.piDeviceId, value.pairingId, value.revision]))
        .digest('hex');
const empty = (ns: string): NoaaEditionState => ({
    schema: 1,
    namespace: ns,
    lastAttemptAt: 0,
    lastCheckedAt: 0,
    sourceAt: null,
    checkedAt: null,
    day: '',
    sent: 0,
    pending: 0,
    incomplete: false,
    notified: [],
});
function state(value: unknown, ns: string): NoaaEditionState {
    const r = value as NoaaEditionState;
    if (
        !r ||
        r.schema !== 1 ||
        typeof r.namespace !== 'string' ||
        !/^[a-f0-9]{64}$/.test(r.namespace) ||
        !Array.isArray(r.notified) ||
        r.notified.length > 10000 ||
        !Number.isFinite(r.lastAttemptAt) ||
        r.lastAttemptAt < 0 ||
        !Number.isFinite(r.lastCheckedAt) ||
        r.lastCheckedAt < 0 ||
        r.lastCheckedAt > r.lastAttemptAt ||
        !Number.isInteger(r.sent) ||
        r.sent < 0 ||
        r.sent > 2 ||
        !Number.isInteger(r.pending) ||
        r.pending < 0 ||
        r.pending > 10000 ||
        typeof r.incomplete !== 'boolean' ||
        typeof r.day !== 'string' ||
        (r.day !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(r.day))
    )
        throw Error('Edition state unavailable; held notices preserved.');
    const seen = new Set<string>();
    for (const n of r.notified) {
        if (
            !n ||
            !ID.test(n.id) ||
            seen.has(n.id) ||
            !Number.isInteger(n.edition) ||
            n.edition < 1 ||
            n.edition > 9999 ||
            !Number.isInteger(n.update) ||
            n.update < 0 ||
            n.update > 9999
        )
            throw Error('Invalid edition dedupe state.');
        seen.add(n.id);
    }
    for (const stamp of [r.sourceAt, r.checkedAt])
        if (
            stamp !== null &&
            (typeof stamp !== 'string' || !stamp.endsWith('Z') || !Number.isFinite(Date.parse(stamp)))
        )
            throw Error('Invalid edition source clock.');
    return r.namespace === ns ? r : empty(ns);
}
export class NoaaEditionFileState implements NoaaEditionStateStore {
    private filename: string;
    constructor(directory: string) {
        this.filename = path.join(directory, 'noaa-editions-v1.json');
    }
    async load(ns: string): Promise<NoaaEditionState> {
        let file;
        try {
            file = await fs.open(this.filename, 'r');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(ns);
            throw error;
        }
        try {
            const info = await file.stat();
            if (!info.isFile() || info.size > MAX_STATE) throw Error('Edition state exceeds cap');
            const buffer = Buffer.alloc(MAX_STATE + 1),
                { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead > MAX_STATE) throw Error('Edition state exceeds cap');
            return state(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))),
                ns,
            );
        } finally {
            await file.close();
        }
    }
    async save(value: NoaaEditionState): Promise<void> {
        const validated = state(value, value.namespace),
            body = JSON.stringify(validated);
        if (Buffer.byteLength(body) > MAX_STATE) throw Error('Edition state exceeds cap');
        await writeChartFileAtomic(this.filename, body);
    }
}
/** Fixed installed metadata reader. Protected blob paths/geometry are never opened. */
export async function installedNoaaEditions(directory: string): Promise<NoaaInstalledRevision[]> {
    let file;
    try {
        file = await fs.open(path.join(directory, 'index.json'), 'r');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    let index: { version: number; cells: NoaaInstalledRevision[] };
    try {
        const cap = 2 * 1024 * 1024,
            info = await file.stat();
        if (!info.isFile() || info.size > cap) throw Error('Chart metadata exceeds edition-check cap');
        const buffer = Buffer.alloc(cap + 1),
            { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > cap) throw Error('Chart metadata exceeds edition-check cap');
        index = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
        ) as typeof index;
    } finally {
        await file.close();
    }
    if (index.version !== 1 || !Array.isArray(index.cells) || index.cells.length > 10000)
        throw Error('Chart metadata exceeds edition-check cap');
    const seen = new Set<string>();
    for (const n of index.cells) {
        if (
            !n ||
            typeof n.cellId !== 'string' ||
            n.cellId.length > 120 ||
            seen.has(n.cellId) ||
            !Number.isInteger(n.edition) ||
            n.edition < 0 ||
            n.edition > 9999 ||
            (n.updateNumber !== undefined &&
                (!Number.isInteger(n.updateNumber) || n.updateNumber < 0 || n.updateNumber > 9999))
        )
            throw Error('Ambiguous installed chart metadata');
        seen.add(n.cellId);
    }
    return index.cells
        .filter((n) => piChartLicence(n) === 'open' && n.sourceHO === 'US' && ID.test(n.cellId))
        .map((n) => ({
            cellId: n.cellId,
            sourceHO: n.sourceHO,
            source: n.source,
            licence: 'open',
            edition: n.edition,
            ...(n.updateNumber === undefined ? {} : { updateNumber: n.updateNumber }),
        }));
}
export class NoaaEditionChecker {
    private busy = false;
    private stopped = false;
    private controller: AbortController | null = null;
    private activeNamespace: string | null = null;
    private view: {
        state: 'held' | 'waiting' | 'checking' | 'unavailable' | 'incomplete' | 'checked';
        checkedAt: string | null;
        pending: number;
        deliveryHeld: boolean;
    } = { state: 'held', checkedAt: null, pending: 0, deliveryHeld: true };
    get status() {
        try {
            const context = owner(this.deps.context());
            if (context && namespace(context) === this.activeNamespace) return { ...this.view };
        } catch {
            /* Owner truth unavailable. */
        }
        return { state: 'held' as const, checkedAt: null, pending: 0, deliveryHeld: true };
    }
    constructor(
        private deps: {
            context: () => NoaaEditionOwner | null;
            internetAllowed: () => boolean;
            installed: () => Promise<NoaaInstalledRevision[]>;
            store: NoaaEditionStateStore;
            notify?: (packet: NoaaEditionNotice, signal: AbortSignal) => Promise<boolean>;
            fetch?: typeof fetch;
            now?: () => number;
        },
    ) {}
    stop() {
        this.stopped = true;
        this.controller?.abort();
        this.view = { state: 'held', checkedAt: null, pending: 0, deliveryHeld: true };
    }
    async tick(): Promise<void> {
        if (this.busy || this.stopped) return;
        const snapshot = owner(this.deps.context()),
            now = this.deps.now ?? Date.now,
            stamp = now();
        if (!snapshot || !Number.isFinite(stamp) || stamp <= 0 || !this.deps.internetAllowed()) {
            this.view = { state: 'held', checkedAt: null, pending: 0, deliveryHeld: true };
            return;
        }
        const ns = namespace(snapshot),
            controller = new AbortController(),
            deadline = performance.now() + 30000;
        this.busy = true;
        this.controller = controller;
        this.activeNamespace = ns;
        const current = () => {
            let context: NoaaEditionOwner | null;
            try {
                context = owner(this.deps.context());
            } catch {
                return false;
            }
            return (
                !this.stopped &&
                !controller.signal.aborted &&
                performance.now() < deadline &&
                !!context &&
                namespace(context) === ns &&
                this.deps.internetAllowed()
            );
        };
        const timer = setTimeout(() => controller.abort(), 30000);
        const cancelled = new Promise<never>((_resolve, reject) =>
            controller.signal.addEventListener('abort', () => reject(Error('Edition check cancelled or expired')), {
                once: true,
            }),
        );
        void cancelled.catch(() => undefined);
        const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, cancelled]);
        let budget = 1280 * 1024;
        const read = async (key: string, cap: number) => {
            if (!current() || !/^(?:index\.json|generations\/[a-f0-9]{24}\/revisions\.json)$/.test(key))
                throw Error('Edition context changed');
            const response = await bounded(
                (this.deps.fetch ?? fetch)(NOAA_CATALOGUE_BASE + key, {
                    redirect: 'error',
                    credentials: 'omit',
                    signal: controller.signal,
                }),
            );
            if (!response.ok || !response.body) throw Error('Catalogue unavailable');
            const reader = response.body.getReader(),
                chunks: Uint8Array[] = [];
            let size = 0;
            try {
                for (;;) {
                    const part = await bounded(reader.read());
                    if (part.done) break;
                    size += part.value.byteLength;
                    budget -= part.value.byteLength;
                    if (size > cap || budget < 0 || !current()) throw Error('Edition request exceeded bounds');
                    chunks.push(part.value);
                }
            } finally {
                void reader.cancel().catch(() => undefined);
                reader.releaseLock();
            }
            if (!current()) throw Error('Edition context changed');
            return Buffer.concat(chunks);
        };
        try {
            const saved = state(await bounded(this.deps.store.load(ns)), ns);
            if (!current()) return;
            if (stamp < saved.lastAttemptAt) throw Error('Edition clock moved backward');
            if (
                saved.lastAttemptAt &&
                stamp - saved.lastAttemptAt < (saved.lastCheckedAt === saved.lastAttemptAt ? DAY : RETRY)
            ) {
                this.view = {
                    state: 'waiting',
                    checkedAt: saved.checkedAt,
                    pending: saved.pending,
                    deliveryHeld: saved.pending > 0 || !this.deps.notify,
                };
                return;
            }
            const installed = await bounded(this.deps.installed());
            if (!current()) return;
            if (installed.length > 10000) throw Error('Installed edition cohort exceeds bound');
            if (!installed.length) {
                this.view = {
                    state: 'waiting',
                    checkedAt: saved.checkedAt,
                    pending: 0,
                    deliveryHeld: !this.deps.notify,
                };
                return;
            }
            saved.lastAttemptAt = stamp;
            await bounded(this.deps.store.save(saved));
            if (!current()) return;
            this.view = {
                state: 'checking',
                checkedAt: saved.checkedAt,
                pending: 0,
                deliveryHeld: !this.deps.notify,
            };
            const index = parseNoaaIndex(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read('index.json', 256 * 1024))),
            );
            if (!index.revisions) {
                this.view = { state: 'incomplete', checkedAt: saved.checkedAt, pending: 0, deliveryHeld: true };
                return;
            }
            if (
                (saved.sourceAt && Date.parse(index.sourceAt) < Date.parse(saved.sourceAt)) ||
                (saved.checkedAt && Date.parse(index.checkedAt) < Date.parse(saved.checkedAt))
            )
                throw Error('Older catalogue cannot replace checked metadata');
            const raw = await read(index.revisions.key, index.revisions.bytes);
            if (
                raw.length !== index.revisions.bytes ||
                createHash('sha256').update(raw).digest('hex') !== index.revisions.sha256
            )
                throw Error('Edition index integrity failed');
            const rows = parseNoaaRevisions(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
                index,
                now(),
            );
            const availableRows = new Map(rows.map((n) => [n.id, n]));
            const incomplete = installed.some((n) => {
                const available = availableRows.get(n.cellId);
                return (
                    !available ||
                    available.edition < n.edition ||
                    !Number.isInteger(n.edition) ||
                    n.edition < 1 ||
                    (available.edition === n.edition && !Number.isInteger(n.updateNumber))
                );
            });
            const prior = new Map(saved.notified.map((n) => [n.id, n]));
            const changes = noaaEditionChanges(installed, rows).filter((n) => {
                const p = prior.get(n.cellId);
                return (
                    !p ||
                    n.available.edition > p.edition ||
                    (n.available.edition === p.edition && n.available.update > p.update)
                );
            });
            const day = new Date(stamp).toISOString().slice(0, 10);
            if (saved.day !== day) {
                saved.day = day;
                saved.sent = 0;
            }
            let accepted = 0;
            if (changes.length && this.deps.notify && saved.sent < 2) {
                const batch = changes.slice(0, 8);
                if (prior.size + batch.filter((n) => !prior.has(n.cellId)).length > 10000)
                    throw Error('Edition dedupe capacity reached; held notices preserved');
                if (!current()) return;
                const queued = await bounded(
                    this.deps.notify(
                        {
                            schema: 1,
                            owner: snapshot,
                            generation: index.generation,
                            sourceSha256: index.sourceSha256,
                            sourceAt: index.sourceAt,
                            checkedAt: index.checkedAt,
                            more: changes.length > batch.length,
                            changes: batch,
                        },
                        controller.signal,
                    ),
                );
                if (!current()) return;
                if (queued) {
                    for (const n of batch)
                        prior.set(n.cellId, { id: n.cellId, edition: n.available.edition, update: n.available.update });
                    accepted = batch.length;
                    saved.sent++;
                }
            }
            saved.notified = [...prior.values()];
            saved.pending = changes.length - accepted;
            saved.incomplete = incomplete;
            saved.lastCheckedAt = stamp;
            saved.sourceAt = index.sourceAt;
            saved.checkedAt = index.checkedAt;
            if (!current()) return;
            await bounded(this.deps.store.save(saved));
            if (!current()) return;
            this.view = {
                state: incomplete ? 'incomplete' : 'checked',
                checkedAt: index.checkedAt,
                pending: changes.length - accepted,
                deliveryHeld: changes.length > accepted,
            };
        } catch {
            if (!this.stopped)
                this.view = {
                    state: 'unavailable',
                    checkedAt: this.view.checkedAt,
                    pending: this.view.pending,
                    deliveryHeld: true,
                };
        } finally {
            clearTimeout(timer);
            controller.abort();
            this.busy = false;
            if (this.controller === controller) this.controller = null;
        }
    }
}
