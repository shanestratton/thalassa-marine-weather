/**
 * DocumentSyncService — document-specific facade over the vessel sync engine.
 *
 * LocalDocumentService owns offline CRUD and writes every mutation to the
 * durable outbox. SyncService is the only component allowed to push or pull
 * document rows and upload pending files: a local write pushes within seconds
 * (its outbox signal), and an open Documents page catches up the way every
 * binder does (its realtime channel's join, useBinderSource). This facade only:
 *   - says which papers have not uploaded yet, and why one was refused, read
 *     from the outbox itself (131-B9, binder audit DOC-8 and DOC-9);
 *   - asks the engine to try refused uploads again now; and
 *   - refreshes signed download URLs for the private document bucket.
 *
 * Until 131 it kept its own copy of each paper's status in localStorage
 * (thalassa_doc_sync_status), set only when this page saved, so a paper that
 * uploaded on a later cycle stayed "pending" and a refused one never said so;
 * and every visit forced a full pull of every binder. Neither is read now;
 * account deletion still clears the old key.
 *
 * In particular, the absence of a local document is never treated as proof
 * that its cloud copy should be deleted. Deletion is propagated exclusively
 * by the explicit DELETE mutation queued by LocalDocumentService.
 */

import { supabase } from '../supabase';
import { getFullQueue, onOutboxAppended } from './LocalDatabase';
import { getSyncStatus, onSyncComplete, syncNow } from './SyncService';
import { safeDocumentNavigationUrl } from '../../utils/safeUrl';

const TABLE = 'ship_documents';
const STORAGE_BUCKET = 'vessel_vault';

/** A paper whose change the outbox still holds (131-B9). */
export interface DocUpload {
    /** The cloud refused it. The engine tries it again at every sync. */
    failed: boolean;
    /** Why, in the skipper's words: only for a refused one. */
    reason?: string;
}

/**
 * Why an upload was refused, in plain words, from the engine's own message
 * (SyncService pushMutations). Shown after "Upload failed: " on the card.
 * Nothing it cannot tell from the message is claimed.
 */
export function uploadFailureReason(message: string | undefined): string {
    const text = message ?? '';
    if (/exceeded the maximum allowed size|too large|\b413\b/i.test(text)) return 'the file is too big for the cloud';
    if (/local attachment missing/i.test(text)) return 'its file is no longer on this phone';
    if (/local attachment/i.test(text)) return "its file on this phone couldn't be read";
    if (/failed to fetch|load failed|network|timed? ?out|offline/i.test(text)) return 'the connection dropped';
    if (/jwt|not authenticated|auth session|authenticated (user|identity)/i.test(text)) {
        return 'you need to sign in again';
    }
    // An edit the cloud found no row for: deleted elsewhere, or not this
    // account's to change. It cannot tell which, so neither is said.
    if (/record not found/i.test(text)) return "the cloud didn't accept it";
    if (/row-level security|permission denied|not authorized/i.test(text)) {
        return "the cloud didn't allow it for this account";
    }
    if (/attachment cleanup/i.test(text)) return "the cloud's old copy of the file couldn't be cleared";
    return "the cloud didn't accept it";
}

class DocumentSyncServiceClass {
    // ── What has not uploaded yet (131-B9) ─────────────────────

    /**
     * Each paper whose change the outbox still holds, by id: waiting to go
     * (saved with no signal, or not pushed yet), or refused, with why. A paper
     * not listed has nothing waiting. The outbox is this account's own, so a
     * switch of account can never show another sailor's.
     */
    uploadStates(): Record<string, DocUpload> {
        let queue: ReturnType<typeof getFullQueue>;
        try {
            queue = getFullQueue();
        } catch {
            // The database is switching accounts: the next load asks again.
            return {};
        }
        const states: Record<string, DocUpload> = {};
        for (const item of queue) {
            if (item.table_name !== TABLE || states[item.record_id]?.failed) continue;
            // A refused change fences every later one of the same paper, so
            // the first refusal is the reason.
            states[item.record_id] =
                item.status === 'failed'
                    ? { failed: true, reason: uploadFailureReason(item.error_message) }
                    : { failed: false };
        }
        return states;
    }

    /**
     * Call `listener` whenever that may have changed: a sync cycle ended (it
     * pushed, or was refused), or a paper's change was queued on this phone.
     */
    onUploadsChanged(listener: () => void): () => void {
        const offSync = onSyncComplete(() => listener());
        const offOutbox = onOutboxAppended((table) => {
            if (table === TABLE) listener();
        });
        return () => {
            offSync();
            offOutbox();
        };
    }

    /**
     * Try refused uploads again now. Every cycle puts refused changes back in
     * line before it pushes, so this is one cycle that starts after the tap:
     * one already under way read the outbox before it, and is waited out.
     */
    async retryUploads(): Promise<void> {
        if (getSyncStatus() === 'syncing') await syncNow().catch(() => undefined);
        await syncNow();
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
}

export const DocumentSyncService = new DocumentSyncServiceClass();
