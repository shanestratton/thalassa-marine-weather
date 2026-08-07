/**
 * Personal ENC cell store — the skipper's OWN charts, following their account
 * to whatever device they sign in on.
 *
 * The gap this closes
 * ───────────────────
 * Until now the chart flow was one-way and one-shelf: the Pi extracts cells,
 * the phone imports them over the pinned LAN transport, and they stop there.
 * `cloudCellSync` only ever DOWNLOADS, from a curated bucket uploaded once in
 * July 2026. So Shane's 345 cells — including the two S-63 titles he bought,
 * FR466870 Nouméa and GB501494 Port Vila — were perfect on the boat and
 * invisible on thalassawx.app/plan. Nothing was broken; there was simply no
 * device → cloud path in the codebase at all.
 *
 * Why this is not redistribution
 * ──────────────────────────────
 * The ENC page promises the app never uploads or redistributes imported cells,
 * and that promise is kept: objects land under `u/<auth.uid()>/`, and the
 * storage policies in 20260807093000_personal_enc_cells.sql make that prefix
 * readable by exactly one account — the one that put them there. Same
 * licensee, same vessel, second device. If those policies are ever relaxed the
 * promise breaks, so they are the security boundary for this whole module.
 *
 * Separate from cloudCellSync ON PURPOSE
 * ──────────────────────────────────────
 * The curated manifest enforces publisher continuity: monotonic versions,
 * signature stability, and a reconcile sweep that RETIRES any cell marked
 * `cloudManifestVersion` but missing from the shared manifest. Two publishers
 * writing through one set of those rules would fight — every personal cell
 * would be swept on the next curated sync. Hence a parallel module, a
 * `personalManifestVersion` marker the curated sweep ignores, and continuity
 * keys scoped per user id so switching accounts can't trip a false rollback.
 *
 * Downstream is unchanged: blobs go through the same validated
 * EncHazardService.importCell transaction as Pi and curated cells, so the
 * router, tracer and renderer stay source-agnostic.
 */
import { supabase, isSupabaseConfigured, getCurrentUserId } from '../supabase';
import { listRegisteredCells, putCell, resumeNotifications, suspendNotifications } from './EncCellMetadata';
import {
    canonicalEncCellId,
    ENC_CELL_BLOB_MAX_BYTES,
    ENC_CELL_ID_PATTERN,
    encCellStorageIdentity,
    type EncCell,
    type EncConversionResult,
    utf8ByteLength,
} from './types';
import { createLogger } from '../../utils/createLogger';
import { withTimeout } from '../../utils/deadline';

const log = createLogger('personalCellSync');

const BUCKET = 'enc-cells';

/** Personal objects are namespaced by owner; the storage policies key on
 *  exactly this shape, so it must not drift. */
const ownerPrefix = (userId: string): string => `u/${userId}`;
const manifestPath = (userId: string): string => `${ownerPrefix(userId)}/manifest.json`;
const cellPath = (userId: string, cellId: string): string => `${ownerPrefix(userId)}/${cellId}.json`;

const DOWNLOAD_DEADLINE_MS = 30_000;
/** Uploads get a longer rope than downloads: the biggest cell here is ~15 MB
 *  and boat/marina upstream is habitually a fraction of downstream. */
const UPLOAD_DEADLINE_MS = 180_000;
/** Three at a time. Enough to keep a link busy, few enough that a phone isn't
 *  holding three multi-megabyte serialized blobs in memory at once. */
const UPLOAD_CONCURRENCY = 3;

/** A real chart collection is much larger than the 20-cell curated set —
 *  Shane's is 345 and grows with every ChartWorld purchase. */
const PERSONAL_MANIFEST_MAX_CELLS = 4096;
const PERSONAL_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const PERSONAL_CELL_MAX_BYTES = Math.min(16 * 1024 * 1024, ENC_CELL_BLOB_MAX_BYTES);

const versionKey = (userId: string): string => `thalassa_enc_personal_manifest_version_${userId}`;

/**
 * Upload one object, bounded. Returns null on success or a reason string on
 * failure, so a timeout and a rejected upload are the same shape to callers —
 * both mean "this blob is not up there".
 */
async function uploadObject(path: string, text: string): Promise<string | null> {
    const attempt = (async (): Promise<string | null> => {
        const { error } = await supabase!.storage
            .from(BUCKET)
            .upload(path, new Blob([text], { type: 'application/json' }), {
                upsert: true,
                contentType: 'application/json',
            });
        return error ? error.message : null;
    })();
    return withTimeout(attempt, 'upload timed out', UPLOAD_DEADLINE_MS);
}

interface PersonalManifestCell {
    cellId: string;
    bbox: [number, number, number, number];
    /** Registry `sizeBytes` of the LOCAL blob at publish time — the same
     *  content-change signal `syncEncFromPi` uses. Compared against the local
     *  registry to decide "already published"; comparing uploaded bytes
     *  instead would mean re-serializing every cell just to answer the
     *  question. */
    sourceBytes?: number;
    edition?: number;
}

interface PersonalManifest {
    version: number;
    cells: PersonalManifestCell[];
}

interface ActivePersonalManifest {
    userId: string;
    manifest: PersonalManifest;
    fetchedAt: number;
}

let activeManifest: ActivePersonalManifest | null = null;
let manifestFetch: Promise<ActivePersonalManifest | null> | null = null;
const inflightCells = new Map<string, Promise<boolean>>();

const MANIFEST_FRESH_MS = 5 * 60 * 1000;

function parsePersonalManifest(value: unknown): PersonalManifest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as { version?: unknown; cells?: unknown };
    if (
        typeof candidate.version !== 'number' ||
        !Number.isInteger(candidate.version) ||
        candidate.version < 0 ||
        !Array.isArray(candidate.cells) ||
        candidate.cells.length > PERSONAL_MANIFEST_MAX_CELLS
    ) {
        return null;
    }
    const cells: PersonalManifestCell[] = [];
    const identities = new Set<string>();
    for (const raw of candidate.cells) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const item = raw as { cellId?: unknown; bbox?: unknown; sourceBytes?: unknown; edition?: unknown };
        if (typeof item.cellId !== 'string') return null;
        const cellId = canonicalEncCellId(item.cellId);
        if (!ENC_CELL_ID_PATTERN.test(cellId)) return null;
        const identity = encCellStorageIdentity(cellId);
        // A duplicate identity would make "which blob is authoritative for this
        // cell" ambiguous, and the answer would depend on array order.
        if (identities.has(identity)) return null;
        identities.add(identity);
        if (!Array.isArray(item.bbox) || item.bbox.length !== 4) return null;
        const bbox = item.bbox as unknown[];
        if (!bbox.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))) return null;
        const typedBbox = bbox as [number, number, number, number];
        if (
            typedBbox[0] < -180 ||
            typedBbox[2] > 180 ||
            typedBbox[1] < -90 ||
            typedBbox[3] > 90 ||
            typedBbox[0] >= typedBbox[2] ||
            typedBbox[1] >= typedBbox[3]
        ) {
            return null;
        }
        cells.push({
            cellId,
            bbox: typedBbox,
            sourceBytes: typeof item.sourceBytes === 'number' && item.sourceBytes >= 0 ? item.sourceBytes : undefined,
            edition: typeof item.edition === 'number' && item.edition >= 0 ? item.edition : undefined,
        });
    }
    return { version: candidate.version, cells };
}

function readStoredVersion(userId: string): number | null {
    try {
        const raw = localStorage.getItem(versionKey(userId));
        if (raw === null) return null;
        const value = Number(raw);
        return Number.isInteger(value) && value >= 0 ? value : null;
    } catch {
        return null;
    }
}

function writeStoredVersion(userId: string, version: number): void {
    try {
        localStorage.setItem(versionKey(userId), String(version));
    } catch {
        /* in-memory continuity below still holds for this session */
    }
}

function sameBBox(a: [number, number, number, number], b: [number, number, number, number]): boolean {
    return a.every((coordinate, index) => Math.abs(coordinate - b[index]) <= 1e-9);
}

async function fetchPersonalManifest(userId: string): Promise<PersonalManifest | null> {
    if (!isSupabaseConfigured() || !supabase) return null;
    try {
        const { data, error } = await supabase.storage.from(BUCKET).download(manifestPath(userId));
        // A skipper who has never published has no manifest object. That is the
        // normal empty state, not a failure.
        if (error || !data) return null;
        if (data.size > PERSONAL_MANIFEST_MAX_BYTES) {
            log.warn(`personal manifest rejected: ${(data.size / 1024).toFixed(1)} KB exceeds the size limit`);
            return null;
        }
        const text = await data.text();
        if (utf8ByteLength(text, PERSONAL_MANIFEST_MAX_BYTES) > PERSONAL_MANIFEST_MAX_BYTES) return null;
        const manifest = parsePersonalManifest(JSON.parse(text));
        if (!manifest) log.warn('personal manifest rejected: invalid version, cell ID, bbox or duplicate identity');
        return manifest;
    } catch (err) {
        log.warn(`personal manifest fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

async function ensureActiveManifest(forceRefresh: boolean): Promise<ActivePersonalManifest | null> {
    const userId = await getCurrentUserId();
    if (!userId) return null;
    if (
        !forceRefresh &&
        activeManifest &&
        activeManifest.userId === userId &&
        Date.now() - activeManifest.fetchedAt < MANIFEST_FRESH_MS
    ) {
        return activeManifest;
    }
    if (manifestFetch) return manifestFetch;
    const run = (async (): Promise<ActivePersonalManifest | null> => {
        const manifest = await fetchPersonalManifest(userId);
        if (!manifest) return null;
        const stored = readStoredVersion(userId);
        if (stored !== null && manifest.version < stored) {
            // Only this account writes this manifest, so a rollback means a
            // stale CDN copy or a replay — never a legitimate publish.
            log.warn(`personal manifest rejected: rollback v${stored} → v${manifest.version}`);
            return null;
        }
        const next: ActivePersonalManifest = { userId, manifest, fetchedAt: Date.now() };
        activeManifest = next;
        writeStoredVersion(userId, manifest.version);
        return next;
    })();
    manifestFetch = run;
    try {
        return await run;
    } finally {
        if (manifestFetch === run) manifestFetch = null;
    }
}

/**
 * Register every cell in the owner's personal manifest, as `pending` records
 * whose blobs hydrate on demand. Idempotent, and a quiet no-op when signed out
 * or when nothing has ever been published. Returns how many NEW cells were
 * registered.
 */
export async function syncPersonalCells(): Promise<number> {
    const active = await ensureActiveManifest(true);
    if (!active) return 0;
    const { manifest } = active;
    let added = 0;
    suspendNotifications();
    try {
        const known = new Map(listRegisteredCells().map((cell) => [encCellStorageIdentity(cell.id), cell]));
        for (const manifestCell of manifest.cells) {
            const identity = encCellStorageIdentity(manifestCell.cellId);
            const existing = known.get(identity);
            // A cell already held locally with real bytes (Pi import, curated
            // download) needs nothing: the personal copy is the same chart.
            if (existing && existing.usage !== 'pending') continue;
            putCell({
                id: manifestCell.cellId,
                sourceHO: existing?.sourceHO ?? 'personal',
                edition: manifestCell.edition ?? existing?.edition ?? 0,
                issued: existing?.issued ?? '',
                importedAt: existing?.importedAt ?? new Date().toISOString(),
                bbox: manifestCell.bbox,
                geojsonPath: `personal-enc-cells/${manifestCell.cellId}.geojson`,
                hazardCount: 0,
                usage: 'pending',
                personalManifestVersion: manifest.version,
            });
            if (!existing) added++;
        }
    } finally {
        resumeNotifications();
    }
    if (added > 0) log.warn(`registered ${added} personal ENC cells (of ${manifest.cells.length})`);
    return added;
}

/**
 * Download one cell blob from the owner's personal folder into the local
 * store. Deduped per cell. Returns true when the blob is saved locally.
 */
export async function downloadPersonalCell(rawCellId: string): Promise<boolean> {
    if (!isSupabaseConfigured() || !supabase) return false;
    const cellId = canonicalEncCellId(rawCellId);
    if (!ENC_CELL_ID_PATTERN.test(cellId)) return false;
    const snapshot = await ensureActiveManifest(false);
    if (!snapshot) return false;
    const identity = encCellStorageIdentity(cellId);
    const manifestCell = snapshot.manifest.cells.find(
        (candidate) => encCellStorageIdentity(candidate.cellId) === identity,
    );
    if (!manifestCell) return false;

    const existing = inflightCells.get(identity);
    if (existing) return existing;

    const run = (async (): Promise<boolean> => {
        try {
            const { data, error } = await supabase!.storage
                .from(BUCKET)
                .download(cellPath(snapshot.userId, manifestCell.cellId));
            if (error || !data) return false;
            if (data.size > PERSONAL_CELL_MAX_BYTES) {
                log.warn(`personal cell ${cellId}: ${(data.size / 1048576).toFixed(1)} MB exceeds the limit`);
                return false;
            }
            const text = await data.text();
            const textBytes = utf8ByteLength(text, PERSONAL_CELL_MAX_BYTES);
            if (textBytes > PERSONAL_CELL_MAX_BYTES) return false;
            // Off-thread parse for the same reason the curated path does it: a
            // main-thread JSON.parse of a multi-megabyte blob is an indivisible
            // stall, and hydration runs several wide.
            const { parseJsonOffThread } = await import('./EncCellStore');
            const parsed = (await parseJsonOffThread(text)) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
            const parsedId = (parsed as { cellId?: unknown }).cellId;
            if (
                typeof parsedId !== 'string' ||
                !ENC_CELL_ID_PATTERN.test(canonicalEncCellId(parsedId)) ||
                encCellStorageIdentity(parsedId) !== identity
            ) {
                log.warn(`personal cell ${cellId}: payload identity does not match its manifest path`);
                return false;
            }
            // Same validator the Pi and curated imports run. Own-account bytes
            // are not a reason to skip validation: this is what stops a corrupt
            // or truncated upload becoming a routing-grade chart.
            const { validateLocalEncPack } = await import('./localEncPackImport');
            const validated = validateLocalEncPack(parsed).cells[0];
            if (encCellStorageIdentity(validated.cellId) !== identity) return false;
            if (!sameBBox(validated.bbox, manifestCell.bbox)) {
                log.warn(`personal cell ${cellId}: payload bbox does not match the manifest`);
                return false;
            }
            const { importCell } = await import('./EncHazardService');
            await importCell(validated as EncConversionResult, {
                usage: 'navigation',
                personalManifestVersion: snapshot.manifest.version,
            });
            log.warn(`personal cell ${cellId} downloaded (${(textBytes / 1048576).toFixed(1)} MB)`);
            return true;
        } catch (err) {
            log.warn(`personal cell ${cellId} failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        } finally {
            inflightCells.delete(identity);
        }
    })();

    const bounded = withTimeout(run, false, DOWNLOAD_DEADLINE_MS);
    inflightCells.set(identity, bounded);
    return bounded;
}

// ── Publishing ────────────────────────────────────────────────────────────

/** One cell the local device holds and the personal store does not (or holds
 *  at a different edition/size). */
export interface PublishCandidate {
    cellId: string;
    sizeBytes: number;
}

export interface PublishPlan {
    /** Cells that would upload. */
    candidates: PublishCandidate[];
    /** Approximate total upload in bytes. */
    bytes: number;
    /** Cells already in the personal store at this edition and size. */
    alreadyPublished: number;
    /** False when signed out or Supabase isn't configured — the caller should
     *  say "sign in", not "nothing to publish". */
    available: boolean;
}

/**
 * A cell is publishable when it is the SKIPPER'S OWN and actually has bytes on
 * this device. Curated cells are excluded: they are already in the bucket at
 * the root, and copying 55 MB of them into a personal folder would burn quota
 * to duplicate what the account can already read.
 */
function isPublishable(cell: EncCell): boolean {
    if (cell.usage === 'pending' || cell.usage === 'demo') return false;
    if (cell.cloudManifestVersion !== undefined) return false;
    return true;
}

function needsPublish(cell: EncCell, published: Map<string, PersonalManifestCell>): boolean {
    const entry = published.get(encCellStorageIdentity(cell.id));
    if (!entry) return true;
    // Same signal syncEncFromPi uses: a re-extraction keeps cellId+edition and
    // changes the byte count, so edition alone would pin a stale blob forever.
    if (entry.edition !== undefined && entry.edition !== cell.edition) return true;
    if (entry.sourceBytes === undefined || cell.sizeBytes === undefined) return true;
    return entry.sourceBytes !== cell.sizeBytes;
}

/**
 * What a publish would do, without doing it. Drives the confirmation the UI
 * shows before spending several hundred megabytes of someone's data plan.
 */
export async function getPublishPlan(): Promise<PublishPlan> {
    const userId = await getCurrentUserId();
    if (!userId || !isSupabaseConfigured() || !supabase) {
        return { candidates: [], bytes: 0, alreadyPublished: 0, available: false };
    }
    const active = await ensureActiveManifest(true);
    const published = new Map(
        (active?.manifest.cells ?? []).map((cell) => [encCellStorageIdentity(cell.cellId), cell]),
    );
    const local = listRegisteredCells().filter(isPublishable);
    const candidates: PublishCandidate[] = [];
    for (const cell of local) {
        if (!needsPublish(cell, published)) continue;
        candidates.push({ cellId: cell.id, sizeBytes: cell.sizeBytes ?? 0 });
    }
    return {
        candidates,
        bytes: candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
        alreadyPublished: local.length - candidates.length,
        available: true,
    };
}

export interface PublishProgress {
    done: number;
    total: number;
    cellId: string;
    uploadedBytes: number;
}

export interface PublishResult {
    uploaded: number;
    failed: string[];
    /** True when the run stopped early because the caller aborted. */
    cancelled: boolean;
    available: boolean;
}

/**
 * Upload every local cell the personal store is missing, then rewrite the
 * manifest.
 *
 * The manifest is written LAST and only over cells that actually landed. A
 * manifest naming a blob that failed to upload would leave the browser
 * registering a pending cell whose download 404s forever — visible to the
 * skipper as a chart that exists in the list and never draws.
 */
export async function publishPersonalCells(
    options: {
        onProgress?: (progress: PublishProgress) => void;
        signal?: AbortSignal;
    } = {},
): Promise<PublishResult> {
    const { onProgress, signal } = options;
    const userId = await getCurrentUserId();
    if (!userId || !isSupabaseConfigured() || !supabase) {
        return { uploaded: 0, failed: [], cancelled: false, available: false };
    }

    const active = await ensureActiveManifest(true);
    const publishedEntries = new Map(
        (active?.manifest.cells ?? []).map((cell) => [encCellStorageIdentity(cell.cellId), cell]),
    );
    const local = listRegisteredCells().filter(isPublishable);
    const queue = local.filter((cell) => needsPublish(cell, publishedEntries));

    if (queue.length === 0) {
        return { uploaded: 0, failed: [], cancelled: false, available: true };
    }
    if (publishedEntries.size + queue.length > PERSONAL_MANIFEST_MAX_CELLS) {
        log.warn(`personal publish refused: ${publishedEntries.size + queue.length} cells exceeds the manifest cap`);
        return { uploaded: 0, failed: [], cancelled: false, available: true };
    }

    const { loadCellGeoJSON } = await import('./EncCellStore');
    const failed: string[] = [];
    const landed = new Map<string, PersonalManifestCell>();
    let done = 0;
    let uploadedBytes = 0;
    let cursor = 0;

    const uploadOne = async (cell: EncCell): Promise<void> => {
        // remoteFallback=false: publishing must never trigger a DOWNLOAD to
        // satisfy itself. A cell without local bytes is simply not ours to
        // publish.
        const blob = await loadCellGeoJSON(cell.id, false);
        if (!blob) {
            failed.push(cell.id);
            return;
        }
        const text = JSON.stringify(blob);
        const bytes = utf8ByteLength(text, PERSONAL_CELL_MAX_BYTES);
        if (bytes > PERSONAL_CELL_MAX_BYTES) {
            log.warn(`personal publish skipped ${cell.id}: ${(bytes / 1048576).toFixed(1)} MB exceeds the limit`);
            failed.push(cell.id);
            return;
        }
        const failure = await uploadObject(cellPath(userId, cell.id), text);
        if (failure) {
            log.warn(`personal publish failed ${cell.id}: ${failure}`);
            failed.push(cell.id);
            return;
        }
        uploadedBytes += bytes;
        landed.set(encCellStorageIdentity(cell.id), {
            cellId: cell.id,
            bbox: cell.bbox,
            sourceBytes: cell.sizeBytes,
            edition: cell.edition,
        });
    };

    const worker = async (): Promise<void> => {
        while (cursor < queue.length) {
            if (signal?.aborted) return;
            const cell = queue[cursor++];
            try {
                await uploadOne(cell);
            } catch (err) {
                log.warn(`personal publish threw for ${cell.id}: ${err instanceof Error ? err.message : String(err)}`);
                failed.push(cell.id);
            }
            done++;
            onProgress?.({ done, total: queue.length, cellId: cell.id, uploadedBytes });
        }
    };

    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, () => worker()));

    // Merge, don't replace: cells published on an earlier run (or from another
    // device) must survive a partial run here.
    const merged = new Map(publishedEntries);
    for (const [identity, entry] of landed) merged.set(identity, entry);

    if (landed.size > 0) {
        const nextVersion = (active?.manifest.version ?? 0) + 1;
        const manifest: PersonalManifest = { version: nextVersion, cells: Array.from(merged.values()) };
        const failure = await uploadObject(manifestPath(userId), JSON.stringify(manifest));
        if (failure) {
            // The blobs are up but unreferenced. Harmless — the next publish
            // re-uploads them (upsert) and rewrites the manifest.
            log.warn(`personal manifest publish failed: ${failure}`);
            return { uploaded: landed.size, failed, cancelled: Boolean(signal?.aborted), available: true };
        }
        activeManifest = { userId, manifest, fetchedAt: Date.now() };
        writeStoredVersion(userId, nextVersion);
        log.warn(`published ${landed.size} personal ENC cells (${(uploadedBytes / 1048576).toFixed(1)} MB)`);
    }

    return { uploaded: landed.size, failed, cancelled: Boolean(signal?.aborted), available: true };
}

// ── Staying in sync after the first publish ───────────────────────────────

const AUTO_PUBLISH_KEY = 'thalassa_enc_auto_publish';

export function isAutoPublishEnabled(): boolean {
    try {
        return localStorage.getItem(AUTO_PUBLISH_KEY) === '1';
    } catch {
        return false;
    }
}

export function setAutoPublishEnabled(enabled: boolean): void {
    try {
        localStorage.setItem(AUTO_PUBLISH_KEY, enabled ? '1' : '0');
    } catch {
        /* the manual publish button still works */
    }
}

/**
 * Publish anything new, but only once the skipper has opted in by completing a
 * first publish. Fire-and-forget from the end of a Pi sync.
 *
 * Deliberately NOT a first-run trigger: the opt-in exists because run one is
 * ~400 MB on an unknown connection. Incremental runs are a few cells.
 */
export async function publishNewCellsIfEnabled(): Promise<void> {
    if (!isAutoPublishEnabled()) return;
    try {
        const result = await publishPersonalCells();
        if (result.uploaded > 0) log.warn(`auto-published ${result.uploaded} newly imported cells`);
    } catch (err) {
        log.warn(`auto-publish failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Test/sign-out seam: drop the cached manifest so the next call re-reads it
 *  for whoever is signed in now. */
export function resetPersonalCellSync(): void {
    activeManifest = null;
    manifestFetch = null;
    inflightCells.clear();
}
