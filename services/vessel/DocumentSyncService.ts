/**
 * DocumentSyncService — Offline-first Cloud Backup for Ship's Documents
 *
 * ARCHITECTURE (Option C — Hybrid):
 *   1. SAVE INSTANTLY: Documents+files saved to local storage immediately
 *      (works offline at sea, no connectivity needed)
 *   2. BACKGROUND UPLOAD: When connectivity returns, files are uploaded to
 *      Supabase Storage (ship-documents bucket), metadata synced to DB
 *   3. RESTORE: On new device login, pull all docs+files from Supabase
 *
 * Storage:
 *   - Local: LocalDocumentService (Capacitor Filesystem JSON)
 *   - Cloud: Supabase `ship_documents` table + `ship-documents` Storage bucket
 *
 * File flow:
 *   file selected → data URI (local) → upload to Storage → public URL → update record
 */

import { supabase } from '../supabase';
import { LocalDocumentService } from './LocalDocumentService';
import { getAll, bulkUpsert } from './LocalDatabase';
import type { ShipDocument } from '../../types';

// ── Constants ──────────────────────────────────────────────────

const TABLE = 'ship_documents';
const STORAGE_BUCKET = 'ship-documents';
const SYNC_STATUS_KEY = 'thalassa_doc_sync_status';

// ── Types ──────────────────────────────────────────────────────

export type DocSyncStatus = 'synced' | 'pending' | 'uploading' | 'error';

interface SyncStatusMap {
    [docId: string]: {
        status: DocSyncStatus;
        error?: string;
        lastAttempt?: string;
    };
}

// ── Service ────────────────────────────────────────────────────

class DocumentSyncServiceClass {

    private _syncInProgress = false;
    private _statusCache: SyncStatusMap = {};

    constructor() {
        // Load sync status from localStorage
        this._loadStatus();

        // Auto-sync when connectivity resumes
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => {
                console.log('[DocSync] Online — triggering sync');
                this.syncAll();
            });
            // Attempt sync on init
            setTimeout(() => this.syncAll(), 8000);
        }
    }

    // ── Sync Status ────────────────────────────────────────────

    getStatus(docId: string): DocSyncStatus {
        return this._statusCache[docId]?.status || 'pending';
    }

    getAllStatuses(): SyncStatusMap {
        return { ...this._statusCache };
    }

    private _setStatus(docId: string, status: DocSyncStatus, error?: string): void {
        this._statusCache[docId] = {
            status,
            error,
            lastAttempt: new Date().toISOString(),
        };
        this._saveStatus();
    }

    private _loadStatus(): void {
        try {
            const raw = localStorage.getItem(SYNC_STATUS_KEY);
            this._statusCache = raw ? JSON.parse(raw) : {};
        } catch {
            this._statusCache = {};
        }
    }

    private _saveStatus(): void {
        try {
            localStorage.setItem(SYNC_STATUS_KEY, JSON.stringify(this._statusCache));
        } catch { /* localStorage full — ignore */ }
    }

    // ── Upload file to Supabase Storage ────────────────────────

    private async _uploadFileToStorage(
        dataUri: string,
        docId: string,
        fileName?: string
    ): Promise<string | null> {
        if (!supabase) return null;

        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!user) return null;

            // Convert data URI to blob
            const res = await fetch(dataUri);
            const blob = await res.blob();

            // Determine extension from data URI mime type
            const mimeMatch = dataUri.match(/^data:([^;]+);/);
            const mime = mimeMatch?.[1] || 'application/octet-stream';
            const extMap: Record<string, string> = {
                'application/pdf': 'pdf',
                'image/jpeg': 'jpg',
                'image/png': 'png',
                'image/heic': 'heic',
                'application/msword': 'doc',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
            };
            const ext = extMap[mime] || fileName?.split('.').pop() || 'dat';
            const storagePath = `${user.id}/${docId}.${ext}`;

            const { error } = await supabase.storage
                .from(STORAGE_BUCKET)
                .upload(storagePath, blob, {
                    contentType: mime,
                    upsert: true, // Allow re-upload if sync retries
                });

            if (error) {
                console.error('[DocSync] Storage upload failed:', error.message);
                return null;
            }

            // Get public URL
            const { data: urlData } = supabase.storage
                .from(STORAGE_BUCKET)
                .getPublicUrl(storagePath);

            return urlData?.publicUrl || null;
        } catch (e) {
            console.error('[DocSync] File upload error:', e);
            return null;
        }
    }

    // ── Delete file from Supabase Storage ──────────────────────

    private async _deleteFileFromStorage(fileUri: string): Promise<void> {
        if (!supabase || !fileUri) return;
        try {
            const match = fileUri.match(/ship-documents\/(.+)$/);
            if (match) {
                await supabase.storage.from(STORAGE_BUCKET).remove([match[1]]);
            }
        } catch { /* ignore cleanup errors */ }
    }

    // ── Sync single document to Supabase ───────────────────────

    private async _syncDocument(doc: ShipDocument): Promise<boolean> {
        if (!supabase) return false;

        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!user) return false;

            this._setStatus(doc.id, 'uploading');

            // 1. Upload file if it's a data URI (pending upload)
            let fileUrl = doc.file_uri;
            if (fileUrl && fileUrl.startsWith('data:')) {
                const uploadedUrl = await this._uploadFileToStorage(
                    fileUrl, doc.id, doc.document_name
                );
                if (uploadedUrl) {
                    fileUrl = uploadedUrl;
                    // Update local record with the cloud URL
                    await LocalDocumentService.update(doc.id, {
                        file_uri: uploadedUrl,
                        _pendingFile: undefined,
                    } as Partial<ShipDocument>);
                } else {
                    // File upload failed — leave as pending
                    this._setStatus(doc.id, 'error', 'File upload failed');
                    return false;
                }
            }

            // 2. Upsert metadata to Supabase
            const { error } = await supabase
                .from(TABLE)
                .upsert({
                    id: doc.id,
                    user_id: user.id,
                    document_name: doc.document_name,
                    category: doc.category,
                    issue_date: doc.issue_date,
                    expiry_date: doc.expiry_date,
                    file_uri: fileUrl,
                    notes: doc.notes,
                    created_at: doc.created_at,
                    updated_at: doc.updated_at,
                }, { onConflict: 'id' });

            if (error) {
                console.error('[DocSync] DB upsert failed:', error.message);
                this._setStatus(doc.id, 'error', error.message);
                return false;
            }

            this._setStatus(doc.id, 'synced');
            return true;
        } catch (e) {
            console.error('[DocSync] Sync failed for doc:', doc.id, e);
            this._setStatus(doc.id, 'error', String(e));
            return false;
        }
    }

    // ── Sync All — push local changes to cloud ─────────────────

    async syncAll(): Promise<{ synced: number; failed: number }> {
        if (this._syncInProgress || !navigator.onLine || !supabase) {
            return { synced: 0, failed: 0 };
        }

        this._syncInProgress = true;
        let synced = 0, failed = 0;

        try {
            const allDocs = LocalDocumentService.getAll();

            for (const doc of allDocs) {
                const status = this.getStatus(doc.id);

                // Skip already synced docs unless they have a pending file
                const hasPendingFile = doc.file_uri?.startsWith('data:');
                if (status === 'synced' && !hasPendingFile) continue;

                const success = await this._syncDocument(doc);
                if (success) synced++;
                else failed++;
            }

            // Also sync deletions — check cloud for docs not present locally
            await this._syncDeletions();

            console.log(`[DocSync] Sync complete: ${synced} synced, ${failed} failed`);
        } catch (e) {
            console.error('[DocSync] Sync error:', e);
        } finally {
            this._syncInProgress = false;
        }

        return { synced, failed };
    }

    // ── Sync Deletions — remove cloud docs deleted locally ─────

    private async _syncDeletions(): Promise<void> {
        if (!supabase) return;

        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!user) return;

            // Get cloud docs
            const { data: cloudDocs } = await supabase
                .from(TABLE)
                .select('id, file_uri')
                .eq('user_id', user.id);

            if (!cloudDocs || cloudDocs.length === 0) return;

            // Get local doc IDs
            const localIds = new Set(LocalDocumentService.getAll().map(d => d.id));

            // Delete cloud docs that no longer exist locally
            for (const cloudDoc of cloudDocs) {
                if (!localIds.has(cloudDoc.id)) {
                    // Delete file from storage
                    if (cloudDoc.file_uri) {
                        await this._deleteFileFromStorage(cloudDoc.file_uri);
                    }
                    // Delete metadata
                    await supabase.from(TABLE).delete().eq('id', cloudDoc.id);
                    delete this._statusCache[cloudDoc.id];
                }
            }
            this._saveStatus();
        } catch (e) {
            console.error('[DocSync] Deletion sync error:', e);
        }
    }

    // ── Pull from cloud — restore on new device ────────────────

    async pullFromCloud(): Promise<number> {
        if (!supabase || !navigator.onLine) return 0;

        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!user) return 0;

            const { data, error } = await supabase
                .from(TABLE)
                .select('*')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (error || !data || data.length === 0) return 0;

            // Merge with local — cloud wins for conflicts
            const localDocs = LocalDocumentService.getAll();
            const localIds = new Set(localDocs.map(d => d.id));

            let restored = 0;
            const toUpsert: ShipDocument[] = [];

            for (const cloudDoc of data) {
                if (!localIds.has(cloudDoc.id)) {
                    // New from cloud — restore
                    toUpsert.push(cloudDoc as ShipDocument);
                    this._setStatus(cloudDoc.id, 'synced');
                    restored++;
                } else {
                    // Exists locally — cloud wins if newer
                    const local = localDocs.find(d => d.id === cloudDoc.id);
                    if (local && new Date(cloudDoc.updated_at) > new Date(local.updated_at)) {
                        toUpsert.push(cloudDoc as ShipDocument);
                        this._setStatus(cloudDoc.id, 'synced');
                    }
                }
            }

            if (toUpsert.length > 0) {
                await bulkUpsert(TABLE.replace('ship_', ''), toUpsert);
            }

            console.log(`[DocSync] Pulled ${restored} documents from cloud`);
            return restored;
        } catch (e) {
            console.error('[DocSync] Pull error:', e);
            return 0;
        }
    }

    // ── Mark a document for sync (called after local create/update) ──

    markForSync(docId: string): void {
        this._setStatus(docId, 'pending');
        // Trigger immediate sync attempt if online
        if (navigator.onLine) {
            setTimeout(() => this.syncAll(), 500);
        }
    }

    // ── Mark deleted (cleanup status) ──────────────────────────

    markDeleted(docId: string): void {
        delete this._statusCache[docId];
        this._saveStatus();
        // Trigger sync to propagate deletion to cloud
        if (navigator.onLine) {
            setTimeout(() => this.syncAll(), 500);
        }
    }

    // ── Status helpers ─────────────────────────────────────────

    get pendingCount(): number {
        return Object.values(this._statusCache)
            .filter(s => s.status === 'pending' || s.status === 'uploading').length;
    }

    get isSyncing(): boolean {
        return this._syncInProgress;
    }
}

// Singleton
export const DocumentSyncService = new DocumentSyncServiceClass();
