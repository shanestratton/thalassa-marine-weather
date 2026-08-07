/**
 * Cloud ENC cell sync — the DESKTOP PASSAGE BUILDER's chart source
 * (masterplan Phase 5.2).
 *
 * On the boat, ENC cells arrive from the Pi (calypso.local). A browser on
 * the beach can't reach the Pi — so the Pi's extracted cell GeoJSON lives in
 * the private `enc-cells` Supabase Storage bucket (uploaded 2026-07-08:
 * 20 cells, ~55 MB, plus manifest.json) and this module mirrors them into
 * the SAME local stores the Pi sync fills:
 *   • manifest → EncCellMetadata.putCell()  (cell registry, localStorage)
 *   • blobs    → EncHazardService.importCell() (validated, serialized trust transaction)
 * Everything downstream (router, tracer, ENC render) is source-agnostic.
 *
 * GATED: the bucket is authenticated-read (the extracts are licensed) — a
 * signed-out browser simply gets no charts, and the tracer says so honestly.
 * Blobs download ON DEMAND (loadCellGeoJSON miss → fetch), so opening the
 * builder doesn't pull 55 MB up front.
 */
import { supabase, isSupabaseConfigured } from '../supabase';
import {
    getRegisteredCell,
    listRegisteredCells,
    putCell,
    resumeNotifications,
    suspendNotifications,
} from './EncCellMetadata';
import {
    canonicalEncCellId,
    ENC_CELL_BLOB_MAX_BYTES,
    ENC_CELL_ID_PATTERN,
    encCellStorageIdentity,
    type EncConversionResult,
    utf8ByteLength,
} from './types';
import { createLogger } from '../../utils/createLogger';
import { withTimeout } from '../../utils/deadline';

const log = createLogger('cloudCellSync');

const BUCKET = 'enc-cells';

/** JS-side wall-clock bound per blob download. CapacitorHttp ignores
 *  AbortSignal (utils/deadline.ts), so a stalled marina-wifi socket
 *  held the sequential hydration walk — and everything queued behind
 *  it — for up to the 600 s native timeout (2026-07-12 audit). The
 *  awaiter unblocks at the deadline; the in-flight dedup entry stays
 *  until the native request actually settles, so we never double-fetch
 *  a stalled cell. */
const DOWNLOAD_DEADLINE_MS = 30_000;

/** Last manifest version whose blobs this browser downloaded. When the
 *  bucket is re-uploaded under a bumped version (extractor output
 *  changed — e.g. the 2026-07 sounding explosion), every cached cloud
 *  blob is silently stale FOREVER without this: blobs only download on
 *  a local miss, so a returning browser kept rendering pre-sounding
 *  cells while a fresh one got the new data (Shane 2026-07-12: "we
 *  need more depth numbers??" — Mooloolaba's 200 in-view soundings were
 *  in the bucket, not in his IndexedDB). */
const MANIFEST_VERSION_KEY = 'thalassa_enc_cloud_manifest_version';
const MANIFEST_SIGNATURE_KEY = 'thalassa_enc_cloud_manifest_signature';

interface CloudManifest {
    version: number;
    cells: Array<{ cellId: string; bbox: [number, number, number, number] }>;
}

interface ActiveManifest {
    manifest: CloudManifest;
    signature: string;
    fetchedAt: number;
}

interface InflightCellDownload {
    token: symbol;
    manifestSignature: string;
    promise: Promise<boolean>;
}

let manifestSyncPromise: Promise<ActiveManifest | null> | null = null;
const inflightCells = new Map<string, InflightCellDownload>();
let activeManifest: ActiveManifest | null = null;

const CLOUD_MANIFEST_MAX_BYTES = 512 * 1024;
const CLOUD_MANIFEST_MAX_CELLS = 512;
const CLOUD_MANIFEST_FRESH_MS = 5 * 60 * 1000;
const CLOUD_CELL_MAX_BYTES = Math.min(16 * 1024 * 1024, ENC_CELL_BLOB_MAX_BYTES);

function parseCloudManifest(value: unknown): CloudManifest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as { version?: unknown; cells?: unknown };
    if (
        typeof candidate.version !== 'number' ||
        !Number.isInteger(candidate.version) ||
        candidate.version < 0 ||
        !Array.isArray(candidate.cells) ||
        candidate.cells.length > CLOUD_MANIFEST_MAX_CELLS
    ) {
        return null;
    }
    const cells: CloudManifest['cells'] = [];
    const identities = new Set<string>();
    for (const raw of candidate.cells) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const item = raw as { cellId?: unknown; bbox?: unknown };
        if (typeof item.cellId !== 'string') return null;
        const cellId = canonicalEncCellId(item.cellId);
        if (!ENC_CELL_ID_PATTERN.test(cellId)) return null;
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
        const identity = encCellStorageIdentity(cellId);
        if (identities.has(identity)) return null;
        identities.add(identity);
        cells.push({ cellId, bbox: typedBbox });
    }
    cells.sort((a, b) => a.cellId.localeCompare(b.cellId));
    return { version: candidate.version, cells };
}

function manifestSignature(manifest: CloudManifest): string {
    // Persist the canonical normalized payload, not a short non-cryptographic
    // hash. At <=512 entries this is small, collision-free, and lets us reject
    // a publisher/CDN accidentally reusing a version for different contents.
    return JSON.stringify(manifest);
}

function readStoredManifestVersion(): number | null {
    try {
        const raw = localStorage.getItem(MANIFEST_VERSION_KEY);
        if (raw === null) return null;
        const value = Number(raw);
        return Number.isInteger(value) && value >= 0 ? value : null;
    } catch {
        return null;
    }
}

function manifestContinuityIsValid(manifest: CloudManifest, signature: string): boolean {
    const storedVersion = readStoredManifestVersion();
    if (storedVersion !== null && manifest.version < storedVersion) {
        log.warn(`manifest rejected: rollback v${storedVersion} → v${manifest.version}`);
        return false;
    }
    try {
        const storedSignature = localStorage.getItem(MANIFEST_SIGNATURE_KEY);
        if (storedVersion === manifest.version && storedSignature && storedSignature !== signature) {
            log.warn(`manifest rejected: v${manifest.version} contents changed without a version bump`);
            return false;
        }
    } catch {
        /* continuity still has the in-memory check below */
    }
    if (
        activeManifest &&
        (manifest.version < activeManifest.manifest.version ||
            (manifest.version === activeManifest.manifest.version && signature !== activeManifest.signature))
    ) {
        log.warn(`manifest rejected: stale or rewritten active v${activeManifest.manifest.version}`);
        return false;
    }
    return true;
}

async function fetchManifest(): Promise<CloudManifest | null> {
    if (!isSupabaseConfigured() || !supabase) return null;
    try {
        const { data, error } = await supabase.storage.from(BUCKET).download('manifest.json');
        if (error || !data) return null;
        if (data.size > CLOUD_MANIFEST_MAX_BYTES) {
            log.warn(`manifest rejected: ${(data.size / 1024).toFixed(1)} KB exceeds the size limit`);
            return null;
        }
        const text = await data.text();
        if (utf8ByteLength(text, CLOUD_MANIFEST_MAX_BYTES) > CLOUD_MANIFEST_MAX_BYTES) {
            log.warn('manifest rejected: decoded body exceeds the size limit');
            return null;
        }
        const manifest = parseCloudManifest(JSON.parse(text));
        if (!manifest) log.warn('manifest rejected: invalid version, cell ID, bbox or duplicate identity');
        return manifest;
    } catch (err) {
        log.warn(`manifest fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

function sameBBox(a: [number, number, number, number], b: [number, number, number, number]): boolean {
    return a.every((coordinate, index) => Math.abs(coordinate - b[index]) <= 1e-9);
}

async function reconcileManifest(manifest: CloudManifest, signature: string): Promise<number> {
    const byIdentity = new Map(manifest.cells.map((cell) => [encCellStorageIdentity(cell.cellId), cell]));
    const { invalidateCloudCellBlob, retireCloudCell } = await import('./EncHazardService');
    let added = 0;
    suspendNotifications();
    try {
        // Anything explicitly supplied by an older cloud manifest must either
        // be revalidated against this version or disappear. Local/Pi/reference
        // cells have no cloud marker and are never swept by this walk.
        for (const stored of listRegisteredCells().filter((cell) => cell.cloudManifestVersion !== undefined)) {
            const manifestCell = byIdentity.get(encCellStorageIdentity(stored.id));
            if (!manifestCell) {
                await retireCloudCell(stored.id);
                continue;
            }
            const needsRefresh =
                stored.cloudManifestVersion !== manifest.version ||
                (stored.usage !== 'reference' && stored.usage !== 'demo' && stored.hazardCount === 0) ||
                !sameBBox(stored.bbox, manifestCell.bbox);
            if (needsRefresh && stored.usage !== 'reference' && stored.usage !== 'demo') {
                const invalidated = await invalidateCloudCellBlob(
                    stored.id,
                    manifest.version,
                    true,
                    stored.cloudManifestVersion,
                    stored.importedAt,
                );
                const pending = getRegisteredCell(stored.id);
                if (invalidated && pending?.usage === 'pending') {
                    putCell({
                        ...pending,
                        bbox: manifestCell.bbox,
                        geojsonPath: `enc-cells/${manifestCell.cellId}.geojson`,
                        usage: 'pending',
                        cloudManifestVersion: manifest.version,
                    });
                }
            }
        }

        const known = new Map(listRegisteredCells().map((cell) => [encCellStorageIdentity(cell.id), cell]));
        for (const manifestCell of manifest.cells) {
            const identity = encCellStorageIdentity(manifestCell.cellId);
            const existing = known.get(identity);
            if (existing) {
                if (existing.usage === 'pending') {
                    putCell({
                        ...existing,
                        bbox: manifestCell.bbox,
                        geojsonPath: `enc-cells/${manifestCell.cellId}.geojson`,
                        usage: 'pending',
                        cloudManifestVersion: manifest.version,
                    });
                }
                continue;
            }
            const pending = {
                id: manifestCell.cellId,
                sourceHO: 'cloud',
                edition: 0,
                issued: '',
                importedAt: new Date().toISOString(),
                bbox: manifestCell.bbox,
                geojsonPath: `enc-cells/${manifestCell.cellId}.geojson`,
                hazardCount: 0,
                usage: 'pending' as const,
                cloudManifestVersion: manifest.version,
            };
            putCell(pending);
            known.set(identity, pending);
            added++;
        }
    } finally {
        resumeNotifications();
    }
    try {
        localStorage.setItem(MANIFEST_VERSION_KEY, String(manifest.version));
        localStorage.setItem(MANIFEST_SIGNATURE_KEY, signature);
    } catch {
        /* in-memory continuity and pending authority still fail closed */
    }
    return added;
}

async function ensureActiveManifest(forceRefresh: boolean): Promise<ActiveManifest | null> {
    if (!forceRefresh && activeManifest && Date.now() - activeManifest.fetchedAt < CLOUD_MANIFEST_FRESH_MS) {
        return activeManifest;
    }
    if (manifestSyncPromise) return manifestSyncPromise;
    const sync = (async (): Promise<ActiveManifest | null> => {
        const manifest = await fetchManifest();
        if (!manifest) return null;
        const signature = manifestSignature(manifest);
        if (!manifestContinuityIsValid(manifest, signature)) return null;
        // Publish the snapshot before reconciliation. Any older blob request
        // completing concurrently now sees a changed signature and discards
        // its bytes before the import lock is entered.
        const next = { manifest, signature, fetchedAt: Date.now() };
        activeManifest = next;
        try {
            await reconcileManifest(manifest, signature);
            return next;
        } catch (error) {
            if (activeManifest === next) activeManifest = null;
            log.warn(`manifest reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    })();
    manifestSyncPromise = sync;
    try {
        return await sync;
    } finally {
        if (manifestSyncPromise === sync) manifestSyncPromise = null;
    }
}

/**
 * Register every cloud cell in the local metadata registry (idempotent —
 * cells already present, e.g. from a Pi sync, are left alone). Returns how
 * many NEW cells were registered. Safe to call opportunistically; requires
 * a signed-in user or quietly does nothing.
 */
export async function registerCloudCells(): Promise<number> {
    const before = new Set(listRegisteredCells().map((cell) => encCellStorageIdentity(cell.id)));
    const active = await ensureActiveManifest(true);
    if (!active) return 0;
    const manifest = active.manifest;
    let added = manifest.cells.filter((cell) => !before.has(encCellStorageIdentity(cell.cellId))).length;
    // A collision is promoted only by verified cloud BYTES through the shared
    // EncHazardService transaction. If offline/malformed, the reference record
    // stays reference and the next register call can retry safely.
    const registered = new Map(listRegisteredCells().map((cell) => [encCellStorageIdentity(cell.id), cell]));
    for (const manifestCell of manifest.cells) {
        const existing = registered.get(encCellStorageIdentity(manifestCell.cellId));
        if (existing?.usage !== 'reference' && existing?.usage !== 'demo') continue;
        if (await downloadCloudCell(manifestCell.cellId, manifest.version)) added++;
    }
    if (added > 0) log.warn(`registered ${added} cloud ENC cells (of ${manifest.cells.length})`);
    return added;
}

/**
 * Download one cell blob from the bucket into the local store. Deduped per
 * cell. Returns true when the blob is saved locally.
 */
export async function downloadCloudCell(rawCellId: string, expectedManifestVersion?: number): Promise<boolean> {
    if (!isSupabaseConfigured() || !supabase) return false;
    const cellId = canonicalEncCellId(rawCellId);
    if (!ENC_CELL_ID_PATTERN.test(cellId)) return false;
    const snapshot = await ensureActiveManifest(false);
    if (!snapshot || (expectedManifestVersion !== undefined && expectedManifestVersion !== snapshot.manifest.version)) {
        return false;
    }
    const inflightKey = encCellStorageIdentity(cellId);
    const manifestCell = snapshot.manifest.cells.find(
        (candidate) => encCellStorageIdentity(candidate.cellId) === inflightKey,
    );
    if (!manifestCell) {
        log.warn(`cloud cell ${cellId}: not present in active manifest v${snapshot.manifest.version}`);
        return false;
    }
    const existing = inflightCells.get(inflightKey);
    if (existing?.manifestSignature === snapshot.signature) return existing.promise;
    // A newer manifest may legitimately overtake an old stalled request. They
    // use separate network promises; the old completion cannot import because
    // its exact signature snapshot is rechecked below, and the per-cell import
    // lock serializes the one completion that remains authoritative.
    const token = Symbol(cellId);
    const p = (async () => {
        try {
            const { data, error } = await supabase!.storage.from(BUCKET).download(`${cellId}.json`);
            if (error || !data) return false;
            if (data.size > CLOUD_CELL_MAX_BYTES) {
                log.warn(`cloud cell ${cellId}: ${(data.size / 1024 / 1024).toFixed(1)} MB exceeds the cloud limit`);
                return false;
            }
            const text = await data.text();
            const textBytes = utf8ByteLength(text, CLOUD_CELL_MAX_BYTES);
            if (textBytes > CLOUD_CELL_MAX_BYTES) {
                log.warn(`cloud cell ${cellId}: decoded body exceeds the cloud limit`);
                return false;
            }
            // The Pi endpoint wraps cells as { cells: [RawCell] }; the local
            // store expects the EncConversionResult shape ({ cellId, layers }).
            // Parse OFF-THREAD (closing audit 2026-07-18): a bare main-thread
            // JSON.parse of every 2-8 MB blob, 3-wide during hydration, was the
            // exact indivisible-stall the load path already moved to the worker.
            const { parseJsonOffThread } = await import('./EncCellStore');
            const parsed = (await parseJsonOffThread(text)) as unknown;
            const parsedRecord =
                parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? (parsed as { cells?: unknown; cellId?: unknown })
                    : null;
            const rawCandidates = Array.isArray(parsedRecord?.cells)
                ? parsedRecord.cells
                : parsedRecord
                  ? [parsed]
                  : [];
            if (rawCandidates.length !== 1) {
                log.warn(`cloud cell ${cellId}: bucket payload must contain exactly one cell`);
                return false;
            }
            const rawCandidate = rawCandidates[0];
            if (!rawCandidate || typeof rawCandidate !== 'object' || Array.isArray(rawCandidate)) return false;
            const rawCandidateId = (rawCandidate as { cellId?: unknown }).cellId;
            if (
                typeof rawCandidateId !== 'string' ||
                !ENC_CELL_ID_PATTERN.test(canonicalEncCellId(rawCandidateId)) ||
                encCellStorageIdentity(rawCandidateId) !== inflightKey
            ) {
                log.warn(`cloud cell ${cellId}: payload identity does not match its manifest path`);
                return false;
            }
            const { validateLocalEncPack } = await import('./localEncPackImport');
            const validated = validateLocalEncPack(rawCandidate).cells[0];
            if (encCellStorageIdentity(validated.cellId) !== inflightKey) return false;
            if (!sameBBox(validated.bbox, manifestCell.bbox)) {
                log.warn(
                    `cloud cell ${cellId}: payload bbox does not match active manifest v${snapshot.manifest.version}`,
                );
                return false;
            }
            // Bind completion to the exact normalized manifest, not just its
            // version number. A stale request (or illegal same-version rewrite)
            // can never land after a newer snapshot is active.
            if (
                !activeManifest ||
                activeManifest.signature !== snapshot.signature ||
                activeManifest.manifest.version !== snapshot.manifest.version
            ) {
                log.warn(`cloud cell ${cellId}: discarded stale manifest v${snapshot.manifest.version} download`);
                return false;
            }
            const { importCell } = await import('./EncHazardService');
            await importCell(validated as EncConversionResult, {
                usage: 'navigation',
                cloudManifestVersion: snapshot.manifest.version,
            });
            log.warn(`cloud cell ${cellId} downloaded (${(textBytes / 1024 / 1024).toFixed(1)} MB)`);
            return true;
        } catch (err) {
            log.warn(`cloud cell ${cellId} failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        } finally {
            if (inflightCells.get(inflightKey)?.token === token) inflightCells.delete(inflightKey);
        }
    })();
    const bounded = withTimeout(p, false, DOWNLOAD_DEADLINE_MS);
    inflightCells.set(inflightKey, {
        token,
        manifestSignature: snapshot.signature,
        promise: bounded,
    });
    return bounded;
}

/**
 * Outcome of a corridor cloud-fill: what was fetched and whether the bucket
 * was even reachable (sign-in / config), so the caller can tell "everything's
 * already local" apart from "you're not signed in / offline".
 */
export interface CloudBBoxFillResult {
    /** Cells freshly downloaded this call (routing-grade after — retry routing). */
    downloaded: number;
    /** Cloud cells covering the bbox that still need a blob (0 = fully local). */
    needed: number;
    /** False when Supabase isn't configured/reachable at all. */
    bucketAvailable: boolean;
}

/**
 * Download every CLOUD cell whose bbox intersects `bbox` that the router would
 * reject for lack of a real feature count (hazardCount 0 = registered-but-not-
 * downloaded, or a pre-2026-07-15 blob that never got its count). Registers the
 * manifest first so bboxes are known. Works over HTTPS from a browser — the
 * path ⚡ Auto route uses to fill a corridor coverage gap on the WEB, where the
 * Pi (http://…:3001) is unreachable behind the page's HTTPS origin.
 */
export async function downloadCloudCellsForBBox(bbox: [number, number, number, number]): Promise<CloudBBoxFillResult> {
    if (!isSupabaseConfigured() || !supabase) return { downloaded: 0, needed: 0, bucketAvailable: false };
    await registerCloudCells(); // ensure the manifest is registered (bboxes known)
    let downloaded = 0;
    let needed = 0;
    // A curated manifest may legitimately be absent now — an account whose only
    // charts are its OWN published cells has nothing in the shared bucket. The
    // old unconditional early return here reported "no bucket" for exactly that
    // case, which reads to the caller as "sign in / you're offline".
    if (activeManifest) {
        const [west, south, east, north] = bbox;
        const covering = listRegisteredCells().filter((cell) => {
            if (cell.usage !== 'pending' || cell.cloudManifestVersion === undefined) return false;
            const [cellWest, cellSouth, cellEast, cellNorth] = cell.bbox;
            return !(cellEast < west || cellWest > east || cellNorth < south || cellSouth > north);
        });
        needed += covering.length;
        for (const c of covering) {
            if (await downloadCloudCell(c.id)) downloaded++;
        }
    }
    // Then the skipper's own cells, which the curated filter above can never
    // match (they carry personalManifestVersion, not cloudManifestVersion).
    const { downloadPersonalCellsForBBox } = await import('./personalCellSync');
    const personal = await downloadPersonalCellsForBBox(bbox);
    downloaded += personal.downloaded;
    needed += personal.needed;
    return { downloaded, needed, bucketAvailable: Boolean(activeManifest) || personal.available };
}
