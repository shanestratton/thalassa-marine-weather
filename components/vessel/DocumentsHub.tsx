/**
 * DocumentsHub — Ship's Documents vault with expiry traffic lights.
 *
 * Sub-components extracted to ./documents/:
 *   - SwipeableDocCard: swipe-to-delete card with expiry traffic lights
 *   - DocumentForm: add/edit form modal content
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('DocumentsHub');
import type { ShipDocument, DocumentCategory } from '../../types';
import { LocalDocumentService } from '../../services/vessel/LocalDocumentService';
import { DocumentSyncService } from '../../services/vessel/DocumentSyncService';
import { triggerHaptic } from '../../utils/system';
import { TapToAction } from '../ui/TapToAction';
import { PageHeader } from '../ui/PageHeader';
import { toast } from '../Toast';
import { ModalSheet } from '../ui/ModalSheet';
import { UndoToast } from '../ui/UndoToast';
import { EmptyState } from '../ui/EmptyState';
import { LoadErrorState } from '../ui/LoadErrorState';
import { ShimmerBlock } from '../ui/ShimmerBlock';
import { OfflineBadge } from '../ui/OfflineBadge';
import { AlertTriangleIcon, CheckIcon, ClockIcon } from '../icons/UIIcons';
import { CloudIcon } from '../icons/WeatherIcons';
import { useRealtimeSync } from '../../hooks/useRealtimeSync';
import { useUndoDelete } from '../../hooks/useUndoDelete';
import { useSuccessFlash } from '../../hooks/useSuccessFlash';
import { SwipeableDocCard, getExpiryStatus } from './documents/SwipeableDocCard';
import { DocumentForm, CATEGORIES, CREW_IDS_CATEGORY } from './documents/DocumentForm';
import { docCacheFileName, docFileExtension } from './documents/docFiles';
import { useBinderSource } from '../../hooks/useBinderSource';
import { SharedBinderLine, bringingInCopy } from './SharedBinderLine';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';

interface DocumentsHubProps {
    onBack: () => void;
}

// Expiry logic now in ./documents/SwipeableDocCard.tsx

// ── File helpers ───────────────────────────────────────────────

/**
 * The copies one share sheet hands out, in a Cache folder of their own. Every
 * open of a paper names its copy the same, so a second open while the first
 * sheet was still up overwrote that file and, clearing up, deleted it from
 * under Save to Files or Mail. A folder per sheet keeps them apart; the file
 * names the sheet shows are unchanged.
 */
interface ShareCopies {
    folder: string;
    /** Set once a write has started: only then is there a folder to clear. */
    used: boolean;
}

function newShareCopies(): ShareCopies {
    return { folder: `share-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, used: false };
}

/**
 * Write a document to the Capacitor cache directory as a real file, named and
 * typed from the document (components/vessel/documents/docFiles.ts): a synced
 * photo is a .jpg, not a ".pdf", and two papers with one name are two files.
 * A URL is fetched once; its own content type picks the extension. Returns
 * the file:// URI native APIs use. Only for an old inline file (data:) or a
 * legacy https link: a paper in the vault bucket is kept on the phone and
 * downloaded natively (126-B3b), never through JS.
 */
async function writeUriToCache(
    uri: string,
    doc: Pick<ShipDocument, 'id' | 'document_name'>,
    copies: ShareCopies,
): Promise<string> {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');

    // Data URIs: extract base64 portion. URLs: fetch and convert.
    let base64Data: string;
    let ext: string;
    if (uri.startsWith('data:')) {
        base64Data = uri.split(',')[1];
        ext = docFileExtension(uri);
    } else {
        const res = await fetch(uri);
        // A refused or expired link is not a document: never save its error body.
        if (!res.ok) throw new Error(`document fetch failed (${res.status})`);
        const blob = await res.blob();
        ext = docFileExtension(uri, blob.type);
        base64Data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    copies.used = true;
    const result = await Filesystem.writeFile({
        path: `${copies.folder}/${docCacheFileName(doc.document_name, doc.id, ext)}`,
        data: base64Data,
        directory: Directory.Cache,
        recursive: true,
    });
    return result.uri;
}

/**
 * Clear a share sheet's copies once it has closed (shared, cancelled or
 * failed): a passport copy must not sit in Caches. Best effort, as the Diary
 * does (SwipeableDiaryCard): a folder that will not go is logged.
 */
async function clearShareCopies(copies: ShareCopies): Promise<void> {
    if (!copies.used) return;
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    await Filesystem.rmdir({ path: copies.folder, directory: Directory.Cache, recursive: true }).catch((e) =>
        log.warn('documents: cache-cleanup-failed', e),
    );
}

/**
 * A share sheet the skipper closed, or one refused because another is already
 * up ("Can't share while sharing is in progress": a second tap on a slow
 * link). Neither is a failure to report.
 */
const isQuietShareEnd = (e: unknown) => {
    const message = (e as Error)?.message ?? '';
    return message.includes('cancel') || message.includes('dismissed') || message.includes('in progress');
};

type VaultModule = typeof import('../../services/vessel/vaultFiles');
type PaperFileState = import('../../services/vessel/vaultFiles').PaperFileState;

/** The Documents file store on this phone (126-B3a), loaded with the first file this page touches. */
const loadVault = (): Promise<VaultModule> => import('../../services/vessel/vaultFiles');

/** No copy on this phone, and no signal to fetch the cloud's. */
class NeedsSignalError extends Error {}

const NEEDS_SIGNAL = "This file isn't on this phone yet. Open it once with signal to keep a copy.";

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Write one paper's file into a share sheet's Cache folder: the copy on this
 * phone first (126-B3a; a native copy, no bytes through JS), else the cloud's,
 * kept on this phone from then on (126-B3b: checked, or downloaded natively).
 * A copy that may be older than the cloud's is used with no signal, or when
 * the cloud does not answer: it is the best copy there is. Null when the page
 * moved on (another account).
 */
async function writePaperToCache(
    doc: ShipDocument,
    copies: ShareCopies,
    isCurrent: () => boolean,
): Promise<string | null> {
    const vault = await loadVault();
    const offline = isOffline();
    const copy = await vault.localCopyFor(doc);
    if (!isCurrent()) return null;
    const fromPhone = (found: NonNullable<typeof copy>) => {
        copies.used = true;
        return vault.openLocalCopy(found, doc, copies.folder);
    };
    if (copy && (copy.fresh || offline)) return fromPhone(copy);
    if (!doc.file_uri || doc.file_uri.startsWith(vault.LOCAL_VAULT_SCHEME)) {
        throw new Error('documents: the file on this phone is missing');
    }
    // An old inline file (data:) is on the phone; everything else is fetched.
    if (offline && !doc.file_uri.startsWith('data:')) throw new NeedsSignalError();
    try {
        if (vault.isCloudFile(doc.file_uri)) {
            // Room is unlimited here, so the copy is always kept.
            const kept = (await vault.cacheCloudFile(doc)).copy!;
            if (!isCurrent()) return null;
            return await fromPhone(kept);
        }
        const freshUri = await DocumentSyncService.getDownloadUrl(doc.file_uri);
        if (!isCurrent()) return null;
        return await writeUriToCache(freshUri, doc, copies);
    } catch (error) {
        if (copy && isCurrent()) return fromPhone(copy);
        throw error;
    }
}

/**
 * Present a document file through the native share sheet.
 *
 * Writes the paper's file to the cache (from this phone's copy, or a fresh
 * download URL, re-signing an expired Supabase link), then hands it to Share.
 * Opening, sharing and "Save to Files" were three near-identical copies of
 * this body; on iOS there is no direct download, so saving IS the share
 * sheet. The copy is cleared after.
 */
async function presentDocFile(
    doc: ShipDocument,
    isCurrent: () => boolean,
    opts: { text?: string; dialogTitle: string },
): Promise<'shown' | 'failed' | 'needs-signal'> {
    const copies = newShareCopies();
    try {
        const fileUri = await writePaperToCache(doc, copies, isCurrent);
        if (!fileUri || !isCurrent()) return 'failed';
        const { Share } = await import('@capacitor/share');
        await Share.share({
            title: doc.document_name,
            ...(opts.text ? { text: opts.text } : {}),
            files: [fileUri],
            dialogTitle: opts.dialogTitle,
        });
        return 'shown';
    } catch (e: unknown) {
        if (e instanceof NeedsSignalError) return 'needs-signal';
        if (isQuietShareEnd(e)) return 'shown';
        log.warn(' presentDocFile failed:', e);
        return 'failed';
    } finally {
        await clearShareCopies(copies);
    }
}

/**
 * What a refused pick says (126-B3a): the size in MB as the Files app counts
 * it (1,000,000 bytes) and the skipper's locale writes it. The cap is 25 MiB
 * (26.2 MB), so a refused file always reads over 25.
 */
function refusedPickMessage(result: { reason: string; bytes?: number }): string {
    if (result.reason === 'too-large' && typeof result.bytes === 'number') {
        const megabytes = result.bytes / 1_000_000;
        const shown = megabytes >= 100 ? Math.round(megabytes) : Math.round(megabytes * 10) / 10;
        return `That file is ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(shown)} MB. Documents can be up to 25 MB.`;
    }
    if (result.reason === 'unsupported-type') return 'Attach a PDF, photo or Word document.';
    return "Couldn't read that file. Try again.";
}

// SwipeableDocCard now in ./documents/SwipeableDocCard.tsx

// ── Main Component ────────────────────────────────────────────

export const DocumentsHub: React.FC<DocumentsHubProps> = ({ onBack }) => {
    const initialScope = getAuthIdentityScope();
    const [documents, setDocuments] = useState<ShipDocument[]>([]);
    const [dataScopeKey, setDataScopeKey] = useState(initialScope.key);
    const [loading, setLoading] = useState(true);
    // A failed fetch used to fall through to the empty state, so a network
    // error read as "no documents" — see components/ui/LoadErrorState.
    const [loadError, setLoadError] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [headerMenuOpen, setHeaderMenuOpen] = useState(false);

    // Add/Edit state
    const [showForm, setShowForm] = useState(false);
    const [editDoc, setEditDoc] = useState<ShipDocument | null>(null);
    const [formName, setFormName] = useState('');
    const [formCategory, setFormCategory] = useState<DocumentCategory>('Registration');
    const [formIssueDate, setFormIssueDate] = useState('');
    const [formExpiryDate, setFormExpiryDate] = useState('');
    const [formNotes, setFormNotes] = useState('');
    const [formFileUri, setFormFileUri] = useState<string | null>(null);
    const [formFileName, setFormFileName] = useState<string | null>(null);
    // A picked file is read and kept on the phone before it can be filed (126-B3a).
    const [fileState, setFileState] = useState<'idle' | 'reading' | 'ready'>('idle');
    const pickedRef = React.useRef<{ uri: string; bytes: number } | null>(null);
    // Where each paper's file is, for its card (126-B3b): on this phone, only in
    // the cloud, or on this phone only (too big to back up; the row has no file).
    const [fileStates, setFileStates] = useState<Readonly<Record<string, PaperFileState>>>({});
    const [vaultTick, setVaultTick] = useState(0);
    const refreshFileStates = useCallback(() => setVaultTick((tick) => tick + 1), []);
    // Soft delete with undo (126-B10a): the document stays in state, hidden,
    // until its delete is committed. The commit is fenced on the account, not
    // on the page being open, so a delete flushed by Back or by the phone
    // locking still marks the cloud copy deleted.
    const undoDelete = useUndoDelete<ShipDocument>({
        rows: documents,
        // Declared below; called only once a delete has landed.
        onCommitted: () => loadDocs(),
        commit: async (doc, scope) => {
            await LocalDocumentService.delete(doc.id);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            DocumentSyncService.markDeleted(doc.id);
            // Its copy on this phone goes with it (126-B3a; the file an hour on).
            void loadVault()
                .then((vault) => vault.recordLocalCopy(doc.id, null))
                .catch((error) => log.warn('documents: index-forget-failed', error));
        },
        onCommitFailed: () => toast.error('Failed to delete document'),
        onRestored: () => toast.success('Document restored'),
        describe: (doc) => `"${doc.document_name}" deleted`,
    });
    const { hiddenIds } = undoDelete;
    const { key: undoToastKey, ...undoToastProps } = undoDelete.toastProps;
    const mountedRef = React.useRef(true);
    const fileReadVersionRef = React.useRef(0);
    const reloadTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const currentOperation = useCallback(
        (scope: AuthIdentityScope) =>
            mountedRef.current && isAuthIdentityScopeCurrent(scope) && dataScopeKey === scope.key,
        [dataScopeKey],
    );

    // ── Load ──
    const loadDocs = useCallback(() => {
        setLoadError(false);
        const scope = getAuthIdentityScope();
        setLoading(true);
        try {
            const loaded = LocalDocumentService.getAll();
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setDataScopeKey(scope.key);
            setDocuments(loaded);
        } catch (e) {
            log.error('Failed to load documents:', e);
            if (isAuthIdentityScopeCurrent(scope)) {
                setLoadError(true);
                toast.error('Failed to load documents');
            }
        } finally {
            if (isAuthIdentityScopeCurrent(scope)) setLoading(false);
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        loadDocs();
        const unsubscribe = subscribeAuthIdentityScope((next) => {
            fileReadVersionRef.current += 1;
            if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
            setDataScopeKey(next.key);
            setDocuments([]);
            setLoading(true);
            setSearchQuery('');
            setSelectedIds(new Set());
            setHeaderMenuOpen(false);
            setShowForm(false);
            setEditDoc(null);
            setFormName('');
            setFormCategory('Registration');
            setFormIssueDate('');
            setFormExpiryDate('');
            setFormNotes('');
            setFormFileUri(null);
            setFormFileName(null);
            setFileState('idle');
            pickedRef.current = null;
            setFileStates({});
            reloadTimerRef.current = setTimeout(() => {
                if (isAuthIdentityScopeCurrent(next)) loadDocs();
            }, 0);
        });
        return () => {
            mountedRef.current = false;
            fileReadVersionRef.current += 1;
            if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
            reloadTimerRef.current = null;
            unsubscribe();
        };
    }, [loadDocs]);

    // Realtime sync — crew edits appear instantly
    useRealtimeSync('ship_documents', loadDocs);

    // Where each paper's file is (126-B3b), from one read of the vault's index
    // after every load, open, share and Wi-Fi pass: no filesystem call per card.
    // A paper too big to back up has no file in its row, but its card opens.
    useEffect(() => {
        if (loading) return;
        const scope = getAuthIdentityScope();
        let cancelled = false;
        loadVault()
            .then(async (vault) => {
                const states = await vault.paperFileStates(documents);
                if (!cancelled && currentOperation(scope)) setFileStates(states);
            })
            .catch((error) => log.warn('documents: vault-index-failed', error));
        return () => {
            cancelled = true;
        };
    }, [currentOperation, documents, loading, vaultTick]);

    // On Wi-Fi, the ship's papers come down to this phone before they are
    // needed (126-B3b); then files nothing refers to any more go, an hour on.
    // A later pass (after a sync) relabels the cards it kept, too.
    useEffect(() => {
        let stop: (() => void) | undefined;
        let cancelled = false;
        loadVault()
            .then((vault) => {
                if (cancelled) return;
                stop = vault.onPapersKept(refreshFileStates);
                return vault.prefetchPapers();
            })
            .catch((error) => log.warn('documents: prefetch-failed', error));
        return () => {
            cancelled = true;
            stop?.();
        };
    }, [dataScopeKey, refreshFileStates]);

    // Whose papers these are (shared binders, 2026-10-02): the skipper's while
    // this sailor is crew on a boat that shares Documents. Crew may file and
    // edit, but never delete or attach files to the skipper's records.
    const { source: binder, fetchingSkipperBinder } = useBinderSource('documents', {
        reload: loadDocs,
        rowCount: documents.length,
    });
    const sharedBinder = binder.mode === 'shared';

    const { ref: listRef, flash } = useSuccessFlash();

    // Cloud pull on mount (restore on new device)
    useEffect(() => {
        const scope = getAuthIdentityScope();
        DocumentSyncService.pullFromCloud().then((restored) => {
            if (!currentOperation(scope)) return;
            if (restored > 0) {
                loadDocs();
                toast.success(`Restored ${restored} document${restored > 1 ? 's' : ''} from cloud`);
            }
        });
    }, [currentOperation, loadDocs]);

    // ── Filtered ──
    // On screen, counted and selectable: a document waiting out its undo is
    // hidden, and so, in a skipper's shared binder, are crew IDs (126-B4): the
    // server stops serving them to crew, but a phone may still hold some it
    // synced before, and an edit to one could never land.
    const visibleDocuments = useMemo(() => {
        if (dataScopeKey !== getAuthIdentityScope().key) return [];
        if (hiddenIds.size === 0 && !sharedBinder) return documents;
        return documents.filter(
            (doc) => !hiddenIds.has(doc.id) && !(sharedBinder && doc.category === CREW_IDS_CATEGORY),
        );
    }, [dataScopeKey, documents, hiddenIds, sharedBinder]);
    // Memoised: this ran a toLowerCase() per document per render, and the
    // search box re-renders the hub on every keystroke.
    const filtered = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return visibleDocuments;
        return visibleDocuments.filter((d) => d.document_name.toLowerCase().includes(q));
    }, [visibleDocuments, searchQuery]);

    // Group by category, sorted alphabetically within each group
    const grouped = useMemo(
        () =>
            CATEGORIES.map((cat) => ({
                ...cat,
                docs: filtered
                    .filter((d) => d.category === cat.id)
                    .sort((a, b) => a.document_name.localeCompare(b.document_name)),
            })).filter((g) => g.docs.length > 0),
        [filtered],
    );

    // ── Handlers ──
    const resetForm = () => {
        // A file still being read belongs to no form now.
        fileReadVersionRef.current += 1;
        setFileState('idle');
        pickedRef.current = null;
        setFormName('');
        setFormCategory('Registration');
        setFormIssueDate('');
        setFormExpiryDate('');
        setFormNotes('');
        setFormFileUri(null);
        setFormFileName(null);
        setEditDoc(null);
    };

    const openAddForm = () => {
        resetForm();
        setShowForm(true);
    };

    const openEditForm = (doc: ShipDocument) => {
        setEditDoc(doc);
        setFormName(doc.document_name);
        setFormCategory(doc.category);
        setFormIssueDate(doc.issue_date ? doc.issue_date.split('T')[0] : '');
        setFormExpiryDate(doc.expiry_date ? doc.expiry_date.split('T')[0] : '');
        setFormNotes(doc.notes || '');
        setFormFileUri(doc.file_uri || null);
        setFormFileName(doc.file_uri ? 'Attached file' : null);
        setFileState(doc.file_uri ? 'ready' : 'idle');
        setShowForm(true);
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        // Reset input so same file can be re-selected
        e.target.value = '';
        if (!file) return;
        const scope = getAuthIdentityScope();
        const readVersion = ++fileReadVersionRef.current;
        const isCurrentPick = () => currentOperation(scope) && fileReadVersionRef.current === readVersion;
        setFileState('reading');
        // The file is kept on the phone (Library/vault), photos shrunk, never
        // read whole into memory as base64 (126-B3a).
        void (async () => {
            let vault: VaultModule | null = null;
            let result: Awaited<ReturnType<VaultModule['saveAttachment']>>;
            try {
                vault = await loadVault();
                result = await vault.saveAttachment(file);
            } catch {
                result = { ok: false, reason: 'write-failed' };
            }
            if (!isCurrentPick()) {
                // Its form, or its account, is gone: nothing of it stays.
                if (result.ok) void vault?.discardAttachment(result.uri);
                return;
            }
            if (!result.ok) {
                // A pick is only offered with no file attached.
                setFileState('idle');
                log.warn(`documents: attach-${result.reason}`);
                toast.error(refusedPickMessage(result));
                return;
            }
            pickedRef.current = { uri: result.uri, bytes: result.bytes };
            setFormFileUri(result.uri);
            setFormFileName(file.name);
            setFileState('ready');
            triggerHaptic('light');
        })();
    };

    const handleSave = useCallback(async () => {
        if (!formName.trim() || fileState === 'reading') return;
        const scope = getAuthIdentityScope();
        const wasEditing = Boolean(editDoc);
        const documentId = editDoc?.id ?? null;
        // The file goes in only when it was added, replaced or removed: an
        // edit of the notes must not upload the same file again (126-B3a).
        const attachmentChanged = !editDoc || formFileUri !== (editDoc.file_uri || null);
        const picked = pickedRef.current?.uri === formFileUri ? pickedRef.current : null;
        const details = {
            document_name: formName.trim(),
            category: formCategory,
            issue_date: formIssueDate || null,
            expiry_date: formExpiryDate || null,
            notes: formNotes.trim() || null,
        };
        try {
            triggerHaptic('medium');
            let savedId: string;
            if (documentId) {
                await LocalDocumentService.update(
                    documentId,
                    attachmentChanged ? { ...details, file_uri: formFileUri } : details,
                );
                savedId = documentId;
            } else {
                const created = await LocalDocumentService.create({ ...details, file_uri: formFileUri });
                savedId = created.id;
            }
            if (!currentOperation(scope)) return;
            if (attachmentChanged && (picked || wasEditing)) {
                // Which file on this phone is this paper's, so it opens after
                // the pull replaces the reference (or forget a removed one).
                await loadVault()
                    .then((vault) => vault.recordLocalCopy(savedId, picked?.uri ?? null, picked?.bytes))
                    .catch((error) => log.warn('documents: index-write-failed', error));
                if (!currentOperation(scope)) return;
            }
            setShowForm(false);
            resetForm();
            loadDocs();
            toast.success(wasEditing ? 'Document updated' : 'Document filed');
            flash();
            // Mark for cloud sync
            DocumentSyncService.markForSync(savedId);
        } catch (e) {
            log.error('Failed to save document:', e);
            if (currentOperation(scope)) toast.error('Failed to save document');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editDoc, formName, formCategory, formIssueDate, formExpiryDate, formNotes, formFileUri, fileState, loadDocs]);

    const { remove: removeDoc } = undoDelete;
    const handleDelete = useCallback(
        (id: string) => {
            const doc = visibleDocuments.find((d) => d.id === id);
            if (!doc) return;
            triggerHaptic('medium');
            // A deleted document leaves the batch selection too.
            setSelectedIds((previous) => {
                if (!previous.has(id)) return previous;
                const next = new Set(previous);
                next.delete(id);
                return next;
            });
            removeDoc(doc);
        },
        [removeDoc, visibleDocuments],
    );

    const handleOpenDoc = async (doc: ShipDocument) => {
        const scope = getAuthIdentityScope();
        if (doc.file_uri || fileStates[doc.id] === 'phone-only') {
            triggerHaptic('light');
            const shown = await presentDocFile({ ...doc }, () => currentOperation(scope), {
                dialogTitle: `Open ${doc.document_name}`,
            });
            if (!currentOperation(scope)) return;
            // Opened with signal, a cloud paper is now kept on this phone.
            refreshFileStates();
            if (shown === 'needs-signal') {
                log.warn('documents: open-needs-signal');
                toast.info(NEEDS_SIGNAL);
            } else if (shown === 'failed') {
                toast.error('Could not open document');
            }
        } else {
            if (currentOperation(scope)) openEditForm(doc);
        }
    };

    const toggleSelectDoc = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    /**
     * Share or save the ticked papers in ONE share sheet (126-B3b, DOC-10). On
     * iOS saving IS the share sheet ("Save to Files"), so the old "Download
     * selected", one sheet per paper that counted a cancel as saved, is gone.
     * Each paper comes from this phone, or with signal is kept on it first;
     * one that cannot be had is left out and counted (no signal, or it could
     * not be read: said apart). The sheet is its own confirmation (no toast),
     * and a cancel says nothing.
     */
    const handleShareOrSave = async () => {
        const scope = getAuthIdentityScope();
        setHeaderMenuOpen(false);
        const selected = visibleDocuments
            .filter((d) => selectedIds.has(d.id) && (d.file_uri || fileStates[d.id] === 'phone-only'))
            .map((doc) => ({ ...doc }));
        if (selected.length === 0) {
            toast.error('No files attached to selected documents');
            return;
        }
        triggerHaptic('medium');
        const copies = newShareCopies();
        try {
            const fileUris: string[] = [];
            let leftOut = 0;
            let failed = 0;
            for (const doc of selected) {
                let fileUri: string | null;
                try {
                    fileUri = await writePaperToCache(doc, copies, () => currentOperation(scope));
                } catch (e: unknown) {
                    // Not on this phone and no signal: left out, and said so.
                    // Anything else (the cloud refused it, a full disk) failed.
                    if (e instanceof NeedsSignalError || isOffline()) leftOut += 1;
                    else {
                        failed += 1;
                        log.warn('documents: share-failed', e);
                    }
                    continue;
                }
                if (!fileUri || !currentOperation(scope)) return;
                fileUris.push(fileUri);
            }
            if (!currentOperation(scope)) return;
            if (leftOut > 0) {
                log.warn('documents: share-needs-signal');
                toast.info(
                    fileUris.length + failed === 0
                        ? "These papers aren't on this phone yet. Connect to share them."
                        : leftOut === 1
                          ? "1 paper isn't on this phone yet and was left out."
                          : `${leftOut} papers aren't on this phone yet and were left out.`,
                );
            }
            if (failed > 0)
                toast.error(
                    fileUris.length === 0
                        ? 'Share failed'
                        : `${failed} paper${failed === 1 ? " couldn't be read and was" : "s couldn't be read and were"} left out.`,
                );
            if (fileUris.length === 0) return;
            const { Share } = await import('@capacitor/share');
            await Share.share({
                title: `Ship's Documents (${fileUris.length})`,
                files: fileUris,
                dialogTitle: 'Share or save documents',
            });
        } catch (e: unknown) {
            if (!isQuietShareEnd(e)) {
                log.warn('documents: share-failed', e);
                if (currentOperation(scope)) toast.error('Share failed');
            }
        } finally {
            await clearShareCopies(copies);
            if (currentOperation(scope)) refreshFileStates();
        }
        if (currentOperation(scope)) setSelectedIds(new Set());
    };

    // ── Expiry stats ──
    // One pass instead of two, and one getExpiryStatus (a `new Date`) per
    // document instead of two.
    const { expiredCount, warningCount } = useMemo(() => {
        let expired = 0;
        let warning = 0;
        for (const d of visibleDocuments) {
            const status = getExpiryStatus(d.expiry_date);
            if (status === 'expired') expired++;
            else if (status === 'warning') warning++;
        }
        return { expiredCount: expired, warningCount: warning };
    }, [visibleDocuments]);
    const pendingSyncCount = loading ? 0 : DocumentSyncService.pendingCount;

    // ── Render ──
    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Documents"
                    onBack={onBack}
                    breadcrumbs={['Boat Binder', 'Documents']}
                    status={
                        <>
                            <OfflineBadge />
                            <SharedBinderLine register="documents" source={binder} />
                        </>
                    }
                    subtitle={
                        // One count, worded like Stores and Equipment ('0 items');
                        // '0 documents' under the title only repeated it. Line
                        // icons, not ✓ ⚠ ⚡ ☁️ (UX scorecard run 7).
                        <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
                            {visibleDocuments.length} {visibleDocuments.length === 1 ? 'item' : 'items'}
                            {selectedIds.size > 0 && (
                                <span className="text-sky-400 ml-2 inline-flex items-center gap-1">
                                    <CheckIcon className="h-3 w-3 shrink-0" />
                                    {selectedIds.size} selected
                                </span>
                            )}
                            {expiredCount > 0 && (
                                <span className="text-red-400 ml-2 inline-flex items-center gap-1">
                                    <AlertTriangleIcon className="h-3 w-3 shrink-0" />
                                    {expiredCount} expired
                                </span>
                            )}
                            {warningCount > 0 && (
                                <span className="text-amber-400 ml-2 inline-flex items-center gap-1">
                                    <ClockIcon className="h-3 w-3 shrink-0" />
                                    {warningCount} expiring
                                </span>
                            )}
                            {pendingSyncCount > 0 && (
                                <span className="text-sky-400 ml-2 inline-flex items-center gap-1">
                                    <CloudIcon className="h-3 w-3 shrink-0" />
                                    {pendingSyncCount} pending
                                </span>
                            )}
                        </p>
                    }
                    action={
                        <div className="relative">
                            <button
                                onClick={() => setHeaderMenuOpen(!headerMenuOpen)}
                                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                                aria-label="Page actions"
                            >
                                <svg
                                    aria-hidden="true"
                                    className="w-5 h-5 text-gray-400"
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                >
                                    <circle cx="12" cy="5" r="1.5" />
                                    <circle cx="12" cy="12" r="1.5" />
                                    <circle cx="12" cy="19" r="1.5" />
                                </svg>
                            </button>
                            {headerMenuOpen && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setHeaderMenuOpen(false)} />
                                    <div className="absolute right-0 top-full mt-1 z-50 w-60 max-w-[calc(100vw-2rem)] bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                        <button
                                            aria-label="Share or save selected documents"
                                            onClick={handleShareOrSave}
                                            disabled={selectedIds.size === 0}
                                            className="w-full min-h-11 flex items-center gap-2.5 px-4 py-3 text-left text-sm text-white hover:bg-white/5 transition-colors disabled:opacity-30"
                                        >
                                            <svg
                                                aria-hidden="true"
                                                className="w-4 h-4 shrink-0 text-sky-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                                                />
                                            </svg>
                                            Share or save selected
                                        </button>
                                        {selectedIds.size > 0 && (
                                            <>
                                                <div className="border-t border-white/5" />
                                                <button
                                                    aria-label="Clear document selection"
                                                    onClick={() => {
                                                        setSelectedIds(new Set());
                                                        setHeaderMenuOpen(false);
                                                    }}
                                                    className="w-full min-h-11 flex items-center gap-2.5 px-4 py-3 text-left text-sm text-gray-400 hover:bg-white/5 transition-colors"
                                                >
                                                    <svg
                                                        aria-hidden="true"
                                                        className="w-4 h-4 shrink-0"
                                                        fill="none"
                                                        viewBox="0 0 24 24"
                                                        stroke="currentColor"
                                                        strokeWidth={2}
                                                    >
                                                        <path
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                            d="M6 18L18 6M6 6l12 12"
                                                        />
                                                    </svg>
                                                    Clear selection
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    }
                />

                {/* Search — only once there is something to search (UX scorecard
                    run 7: a live field sat over an empty list). */}
                {(visibleDocuments.length > 0 || searchQuery) && (
                    <div className="shrink-0 px-4 pb-3">
                        <input
                            type="text"
                            aria-label="Search documents"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search documents…"
                            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-400 [.display-light_&]:placeholder-slate-600! outline-hidden focus:border-sky-500/30"
                        />
                    </div>
                )}

                {/* Documents list (scrollable, grouped) */}
                <div ref={listRef} className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3">
                    {loading ? (
                        <div className="space-y-3 px-1">
                            <ShimmerBlock variant="list" rows={3} />
                        </div>
                    ) : loadError ? (
                        <LoadErrorState what="your documents" onRetry={loadDocs} />
                    ) : fetchingSkipperBinder && !searchQuery ? (
                        <p role="status" className="py-16 text-center text-sm font-semibold text-gray-400">
                            {bringingInCopy(binder)}
                        </p>
                    ) : filtered.length === 0 ? (
                        <EmptyState
                            icon={
                                <svg
                                    className="w-8 h-8"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                                    />
                                </svg>
                            }
                            title={searchQuery ? 'No documents match' : 'No documents filed'}
                            subtitle={
                                searchQuery
                                    ? 'Try a different search term.'
                                    : "Keep the ship's papers in one place: registration, insurance, radio licence, crew passports. Tap Add document below to file one."
                            }
                            className="py-16"
                        />
                    ) : (
                        /* Grouped by category, alphabetical within */
                        grouped.map((group) => (
                            <div key={group.id}>
                                <div className="flex items-center gap-2 mb-2">
                                    <group.Icon className="h-4 w-4 shrink-0 text-gray-400" />
                                    <span className="text-label font-black text-gray-400 uppercase tracking-widest">
                                        {group.label}
                                        {/* The server keeps these for the owner (126-B4). */}
                                        {!sharedBinder && group.id === CREW_IDS_CATEGORY && ' · only you'}
                                    </span>
                                    <span className="text-label text-gray-400 font-bold">({group.docs.length})</span>
                                </div>
                                <div className="space-y-2">
                                    {group.docs.map((doc) => (
                                        <SwipeableDocCard
                                            key={doc.id}
                                            doc={doc}
                                            onTap={() => handleOpenDoc(doc)}
                                            onEdit={() => openEditForm(doc)}
                                            onDelete={sharedBinder ? undefined : () => handleDelete(doc.id)}
                                            selected={selectedIds.has(doc.id)}
                                            onToggleSelect={() => toggleSelectDoc(doc.id)}
                                            fileState={fileStates[doc.id]}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Add Document CTA (fixed at bottom) */}
                <div
                    className="shrink-0 px-4 pt-2 bg-slate-950"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    <TapToAction
                        label="Add document"
                        icon={
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2.5}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                            </svg>
                        }
                        onConfirm={() => {
                            triggerHaptic('medium');
                            openAddForm();
                        }}
                        theme="emerald"
                    />
                </div>

                {/* ═══ ADD / EDIT DOCUMENT MODAL ═══ */}
                {showForm && (
                    <ModalSheet
                        isOpen={true}
                        onClose={() => {
                            setShowForm(false);
                            resetForm();
                        }}
                        title={editDoc ? 'Edit document' : 'Add document'}
                    >
                        <DocumentForm
                            isEdit={!!editDoc}
                            formName={formName}
                            formCategory={formCategory}
                            formIssueDate={formIssueDate}
                            formExpiryDate={formExpiryDate}
                            formNotes={formNotes}
                            formFileUri={formFileUri}
                            formFileName={formFileName}
                            onNameChange={setFormName}
                            onCategoryChange={setFormCategory}
                            onIssueDateChange={setFormIssueDate}
                            onExpiryDateChange={setFormExpiryDate}
                            onNotesChange={setFormNotes}
                            onFileSelect={handleFileSelect}
                            onRemoveFile={() => {
                                setFormFileUri(null);
                                setFormFileName(null);
                                setFileState('idle');
                            }}
                            onSave={handleSave}
                            allowAttach={!sharedBinder}
                            crewView={sharedBinder}
                            fileBusy={fileState === 'reading'}
                        />
                    </ModalSheet>
                )}
            </div>
            <UndoToast key={undoToastKey} {...undoToastProps} />
        </div>
    );
};
