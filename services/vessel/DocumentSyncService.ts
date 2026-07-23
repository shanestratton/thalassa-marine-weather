/**
 * DocumentSyncService — document-specific facade over the vessel sync engine.
 *
 * LocalDocumentService owns offline CRUD and writes every mutation to the
 * durable outbox. SyncService is the only component allowed to push or pull
 * document rows and upload pending files. This facade only:
 *   - tracks user-facing document sync status;
 *   - requests canonical outbox syncs and full pulls; and
 *   - refreshes signed download URLs for the private document bucket.
 *
 * In particular, the absence of a local document is never treated as proof
 * that its cloud copy should be deleted. Deletion is propagated exclusively
 * by the explicit DELETE mutation queued by LocalDocumentService.
 */

import { createLogger } from '../../utils/createLogger';
import { supabase } from '../supabase';
import { LocalDocumentService } from './LocalDocumentService';
import { getFullQueue, getLocalDatabaseIdentity } from './LocalDatabase';
import { forceFullPull, syncNow } from './SyncService';
import { safeDocumentNavigationUrl } from '../../utils/safeUrl';

const log = createLogger('DocSync');

const STORAGE_BUCKET = 'vessel_vault';
const SYNC_STATUS_KEY_PREFIX = 'thalassa_doc_sync_status';

export type DocSyncStatus = 'synced' | 'pending' | 'uploading' | 'error';

interface SyncStatusMap {
    [docId: string]: {
        status: DocSyncStatus;
        error?: string;
        lastAttempt?: string;
    };
}

type FacadeSyncResult = {
    synced: number;
    failed: number;
};

class DocumentSyncServiceClass {
    private _activeSync: Promise<FacadeSyncResult> | null = null;
    private _rerunRequested = false;
    private _statusCache: SyncStatusMap = {};
    private _statusIdentity: string | null | undefined;

    constructor() {
        // Identity-scoped status is hydrated lazily after LocalDatabase boot.
    }

    // ── Sync status ────────────────────────────────────────────

    getStatus(docId: string): DocSyncStatus {
        this._ensureIdentityStatus();
        return this._statusCache[docId]?.status || 'pending';
    }

    getAllStatuses(): SyncStatusMap {
        this._ensureIdentityStatus();
        return Object.fromEntries(Object.entries(this._statusCache).map(([docId, status]) => [docId, { ...status }]));
    }

    private _setStatus(docId: string, status: DocSyncStatus, error?: string): void {
        this._ensureIdentityStatus();
        this._statusCache[docId] = {
            status,
            ...(error ? { error } : {}),
            lastAttempt: new Date().toISOString(),
        };
        this._saveStatus();
    }

    private _currentIdentity(): string | null | undefined {
        try {
            return getLocalDatabaseIdentity();
        } catch {
            return undefined;
        }
    }

    private _ensureIdentityStatus(): void {
        const identity = this._currentIdentity();
        if (identity === this._statusIdentity) return;
        this._statusIdentity = identity;
        this._loadStatus();
    }

    private _statusStorageKey(): string | null {
        if (this._statusIdentity === undefined) return null;
        return `${SYNC_STATUS_KEY_PREFIX}:${encodeURIComponent(this._statusIdentity ?? 'anonymous')}`;
    }

    private _loadStatus(): void {
        if (typeof localStorage === 'undefined') return;
        const storageKey = this._statusStorageKey();
        if (!storageKey) {
            this._statusCache = {};
            return;
        }

        try {
            const raw = localStorage.getItem(storageKey);
            const stored = raw ? (JSON.parse(raw) as SyncStatusMap) : {};

            // An interrupted upload is pending again on the next app launch.
            this._statusCache = Object.fromEntries(
                Object.entries(stored).map(([docId, status]) => [
                    docId,
                    status.status === 'uploading' ? { ...status, status: 'pending' as const } : status,
                ]),
            );
        } catch (error) {
            log.warn('[DocumentSync] Could not load status cache:', error);
            this._statusCache = {};
        }
    }

    private _saveStatus(): void {
        if (typeof localStorage === 'undefined') return;
        const storageKey = this._statusStorageKey();
        if (!storageKey) return;

        try {
            localStorage.setItem(storageKey, JSON.stringify(this._statusCache));
        } catch (error) {
            log.warn('[DocumentSync] Could not persist status cache:', error);
        }
    }

    // ── Canonical sync facade ──────────────────────────────────

    /**
     * Ask the generic vessel sync engine to drain its durable outbox.
     *
     * Concurrent callers share this facade promise. If a new document mutation
     * arrives while that cycle is running, exactly one sequential follow-up is
     * requested so the mutation cannot be stranded behind the earlier snapshot.
     */
    syncAll(): Promise<FacadeSyncResult> {
        this._ensureIdentityStatus();
        if (this._activeSync) {
            this._rerunRequested = true;
            return this._activeSync;
        }

        const cycle = this._runCanonicalSync();
        this._activeSync = cycle;

        const finish = () => {
            if (this._activeSync !== cycle) return;
            this._activeSync = null;

            if (this._rerunRequested) {
                this._rerunRequested = false;
                this._triggerSync();
            }
        };
        void cycle.then(finish, finish);

        return cycle;
    }

    private async _runCanonicalSync(): Promise<FacadeSyncResult> {
        this._ensureIdentityStatus();
        const syncIdentity = this._statusIdentity;
        const trackedIds = Object.entries(this._statusCache)
            .filter(([, entry]) => entry.status !== 'synced')
            .map(([docId]) => docId);

        trackedIds.forEach((docId) => this._setStatus(docId, 'uploading'));

        try {
            const result = await syncNow();
            if (this._currentIdentity() !== syncIdentity) {
                return { synced: 0, failed: 0 };
            }
            const documentQueue = getFullQueue().filter((item) => item.table_name === 'ship_documents');
            let synced = 0;
            let failed = 0;

            for (const docId of trackedIds) {
                const outstanding = documentQueue.filter((item) => item.record_id === docId);
                const failure = outstanding.find((item) => item.status === 'failed');
                if (failure) {
                    this._setStatus(docId, 'error', failure.error_message || 'Document sync failed');
                    failed += 1;
                } else if (outstanding.length > 0) {
                    // Includes a newer same-document edit queued while this
                    // cycle was active. Never let the older generation label it
                    // synced simply because the aggregate cycle completed.
                    this._setStatus(docId, 'pending');
                } else {
                    this._setStatus(docId, 'synced');
                    synced += 1;
                }
            }

            // Errors from another vessel table must not falsely mark every
            // document as failed. The per-document outbox is authoritative.
            if (result.errors.length > 0 && failed === 0) {
                log.warn('[DocumentSync] Sync completed with unrelated table errors:', result.errors);
            }
            return { synced, failed };
        } catch (error) {
            if (this._currentIdentity() !== syncIdentity) {
                return { synced: 0, failed: 0 };
            }
            const message = error instanceof Error ? error.message : String(error);
            trackedIds.forEach((docId) => this._setStatus(docId, 'error', message));
            log.error('[DocumentSync] Canonical sync failed:', error);
            return { synced: 0, failed: trackedIds.length };
        }
    }

    /**
     * Restore cloud data through SyncService's canonical `ship_documents`
     * table pull. Newly appearing local IDs determine the document restore
     * count; the generic engine's aggregate row count spans several tables.
     */
    async pullFromCloud(): Promise<number> {
        this._ensureIdentityStatus();
        const pullIdentity = this._statusIdentity;
        try {
            const beforeDocuments = LocalDocumentService.getAll();
            const beforeIds = new Set(beforeDocuments.map((document) => document.id));
            const beforeCount = beforeDocuments.length;
            await forceFullPull();
            if (this._currentIdentity() !== pullIdentity) return 0;

            const afterDocuments = LocalDocumentService.getAll();
            const restoredIds = afterDocuments
                .map((document) => document.id)
                .filter((documentId) => !beforeIds.has(documentId));

            restoredIds.forEach((documentId) => this._setStatus(documentId, 'synced'));

            // The ID comparison is authoritative. The count comparison is a
            // defensive fallback for corrupt legacy data containing duplicates.
            const countIncrease = Math.max(0, afterDocuments.length - beforeCount);
            const restored = Math.max(new Set(restoredIds).size, countIncrease);
            log.info(`Pulled ${restored} document${restored === 1 ? '' : 's'} from cloud`);
            return restored;
        } catch (error) {
            log.error('[DocumentSync] Pull failed:', error);
            return 0;
        }
    }

    /**
     * The local write has already queued the mutation. Record its visible
     * status and ask the canonical engine to process that queue.
     */
    markForSync(docId: string): void {
        this._setStatus(docId, 'pending');
        this._triggerSync();
    }

    /**
     * The local delete has already queued an explicit DELETE mutation. Remove
     * stale UI status and ask the canonical engine to process it; never scan
     * cloud rows or infer deletion from local absence.
     */
    markDeleted(docId: string): void {
        this._ensureIdentityStatus();
        delete this._statusCache[docId];
        this._saveStatus();
        this._triggerSync();
    }

    private _triggerSync(): void {
        void this.syncAll().catch((error) => {
            // `_runCanonicalSync` normally absorbs failures, but keep a terminal
            // guard so a future engine regression cannot create an unhandled
            // rejection from these fire-and-forget compatibility methods.
            log.error('[DocumentSync] Sync request failed:', error);
        });
    }

    // ── Download URL refresh ───────────────────────────────────

    /**
     * Resolve a fresh download URL while preserving local data URIs and normal
     * third-party URLs exactly as supplied.
     */
    async getDownloadUrl(fileUri: string): Promise<string> {
        if (fileUri.startsWith('data:')) return fileUri;

        if (fileUri.startsWith('supabase-storage://')) {
            const path = fileUri.replace(`supabase-storage://${STORAGE_BUCKET}/`, '');
            return (await this._signStoragePath(path)) ?? fileUri;
        }

        if (fileUri.includes(STORAGE_BUCKET)) {
            const match = fileUri.match(new RegExp(`${STORAGE_BUCKET}/([^?]+)`));
            if (match?.[1]) {
                const freshUrl = await this._signStoragePath(match[1]);
                if (freshUrl) return freshUrl;
            }
        }

        return fileUri;
    }

    /**
     * Reserve the browser tab synchronously while user activation is present,
     * then navigate it after a private storage URL has been signed.
     */
    async openDownload(fileUri: string): Promise<void> {
        const pendingWindow = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null;
        if (pendingWindow) {
            // We need the handle so an async signed-URL lookup does not lose
            // the original user activation. Sever the opener synchronously,
            // and make the reserved document explicitly no-referrer.
            pendingWindow.opener = null;
            const referrerPolicy = pendingWindow.document.createElement('meta');
            referrerPolicy.name = 'referrer';
            referrerPolicy.content = 'no-referrer';
            pendingWindow.document.head.appendChild(referrerPolicy);
        }

        try {
            const url = await this.getDownloadUrl(fileUri);
            const safeUrl = safeDocumentNavigationUrl(
                url,
                typeof window !== 'undefined' ? window.location.href : undefined,
                { allowLocalNetworkHttp: true },
            );
            if (!safeUrl) throw new Error('Unsafe document URL');
            if (pendingWindow) {
                pendingWindow.location.replace(safeUrl);
            } else if (typeof window !== 'undefined') {
                window.location.assign(safeUrl);
            }
        } catch (error) {
            pendingWindow?.close();
            throw error;
        }
    }

    private async _signStoragePath(path: string): Promise<string | null> {
        if (!supabase) return null;

        try {
            const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(path, 60 * 60);
            if (error || !data?.signedUrl) return null;
            return data.signedUrl;
        } catch {
            return null;
        }
    }

    get pendingCount(): number {
        this._ensureIdentityStatus();
        return Object.values(this._statusCache).filter((entry) => {
            return entry.status === 'pending' || entry.status === 'uploading';
        }).length;
    }

    get isSyncing(): boolean {
        return this._activeSync !== null;
    }
}

export const DocumentSyncService = new DocumentSyncServiceClass();
