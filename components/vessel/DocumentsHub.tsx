/**
 * DocumentsHub — Ship's Documents vault with expiry traffic lights.
 *
 * Features:
 * - Documents grouped by category
 * - Traffic light expiry warnings (green/yellow/red/grey)
 * - Search across document names
 * - Swipe-to-delete
 * - Tap to open document (file_uri)
 * - Add / Edit document modal
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('DocumentsHub');
import type { ShipDocument, DocumentCategory } from '../../types';
import { LocalDocumentService } from '../../services/vessel/LocalDocumentService';
import { DocumentSyncService } from '../../services/vessel/DocumentSyncService';
import { triggerHaptic } from '../../utils/system';
import { SlideToAction } from '../ui/SlideToAction';
import { PageHeader } from '../ui/PageHeader';
import { toast } from '../Toast';
import { useSwipeable } from '../../hooks/useSwipeable';
import { ModalSheet } from '../ui/ModalSheet';
import { UndoToast } from '../ui/UndoToast';
import { EmptyState } from '../ui/EmptyState';
import { FormField } from '../ui/FormField';
import { useRealtimeSync } from '../../hooks/useRealtimeSync';
import { useSuccessFlash } from '../../hooks/useSuccessFlash';

interface DocumentsHubProps {
    onBack: () => void;
}

const CATEGORIES: { id: DocumentCategory; label: string; icon: string }[] = [
    { id: 'Registration', label: 'Registration', icon: '🚢' },
    { id: 'Insurance', label: 'Insurance', icon: '🛡️' },
    { id: 'Crew Visas/IDs', label: 'Crew IDs', icon: '🪪' },
    { id: 'Radio/MMSI', label: 'Radio/MMSI', icon: '📻' },
    { id: 'Customs Clearances', label: 'Customs', icon: '🛂' },
    { id: 'User Manuals', label: 'Manuals', icon: '📖' },
];

const CATEGORY_ICONS: Record<DocumentCategory, string> = {
    Registration: '🚢',
    Insurance: '🛡️',
    'Crew Visas/IDs': '🪪',
    'Radio/MMSI': '📻',
    'Customs Clearances': '🛂',
    'User Manuals': '📖',
};

// ── Expiry Status ──────────────────────────────────────────────

type ExpiryStatus = 'valid' | 'warning' | 'expired' | 'none';

function getExpiryStatus(expiryDate: string | null): ExpiryStatus {
    if (!expiryDate) return 'none';
    const now = Date.now();
    const expiry = new Date(expiryDate).getTime();
    if (expiry < now) return 'expired';
    if (expiry - now < 30 * 86400000) return 'warning'; // within 30 days
    return 'valid';
}

const EXPIRY_COLORS: Record<ExpiryStatus, { dot: string; text: string; border: string; label: string }> = {
    valid: { dot: 'bg-emerald-500', text: 'text-emerald-400', border: 'border-emerald-500/30', label: 'Valid' },
    warning: { dot: 'bg-amber-500', text: 'text-amber-400', border: 'border-amber-500/30', label: 'Expiring Soon' },
    expired: { dot: 'bg-red-500', text: 'text-red-400', border: 'border-red-500/30', label: 'Expired' },
    none: { dot: 'bg-gray-500', text: 'text-gray-400', border: 'border-gray-500/20', label: 'No Expiry' },
};

// ── File helpers ───────────────────────────────────────────────

/**
 * Get file extension from a data URI or URL
 */
function getFileExtFromUri(uri: string): string {
    if (uri.startsWith('data:')) {
        const mimeMatch = uri.match(/^data:([^;]+);/);
        const mime = mimeMatch?.[1] || '';
        if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
        if (mime.includes('png')) return 'png';
        if (mime.includes('heic')) return 'heic';
        if (mime.includes('pdf')) return 'pdf';
        if (mime.includes('word') || mime.includes('docx')) return 'docx';
        if (mime.includes('msword') || mime.includes('doc')) return 'doc';
        return 'pdf';
    }
    const urlExt = uri.split('.').pop()?.split('?')[0]?.toLowerCase();
    if (urlExt && ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx', 'heic'].includes(urlExt)) {
        return urlExt;
    }
    return 'pdf';
}

/**
 * Write a data URI to the Capacitor cache directory as a real file.
 * Returns the file:// URI that native APIs can use.
 */
async function writeUriToCache(dataUri: string, fileName: string): Promise<string> {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const ext = getFileExtFromUri(dataUri);
    const safeName = `${fileName.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'document'}.${ext}`;

    // Data URIs: extract base64 portion. URLs: fetch and convert.
    let base64Data: string;
    if (dataUri.startsWith('data:')) {
        base64Data = dataUri.split(',')[1];
    } else {
        const res = await fetch(dataUri);
        const blob = await res.blob();
        base64Data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    const result = await Filesystem.writeFile({
        path: safeName,
        data: base64Data,
        directory: Directory.Cache,
    });
    return result.uri;
}

/**
 * Open a document file — resolves fresh URL, writes to cache, opens via native share sheet.
 * This lets the user preview PDFs, images, etc. via their preferred app.
 */
async function openDocFile(uri: string, doc: ShipDocument): Promise<boolean> {
    try {
        // Resolve fresh download URL (re-signs Supabase URLs if expired)
        const freshUri = await DocumentSyncService.getDownloadUrl(uri);
        const fileUri = await writeUriToCache(freshUri, doc.document_name);
        const { Share } = await import('@capacitor/share');
        await Share.share({
            title: doc.document_name,
            files: [fileUri],
            dialogTitle: `Open ${doc.document_name}`,
        });
        return true;
    } catch (e: unknown) {
        if ((e as Error).message?.includes('cancel') || (e as Error).message?.includes('dismissed')) return true;
        log.warn(' openDocFile failed:', e);
        return false;
    }
}

/**
 * Share a document file via native share sheet (AirDrop, Mail, Files, etc.)
 * Uses the same Capacitor Filesystem + Share pattern as GPX export.
 */
async function shareDocFile(uri: string, doc: ShipDocument): Promise<boolean> {
    try {
        // Resolve fresh download URL (re-signs Supabase URLs if expired)
        const freshUri = await DocumentSyncService.getDownloadUrl(uri);
        const fileUri = await writeUriToCache(freshUri, doc.document_name);
        const { Share } = await import('@capacitor/share');
        await Share.share({
            title: doc.document_name,
            text: `Ship's Document: ${doc.document_name} (${doc.category})`,
            files: [fileUri],
            dialogTitle: `Share ${doc.document_name}`,
        });
        return true;
    } catch (e: unknown) {
        if ((e as Error).message?.includes('cancel') || (e as Error).message?.includes('dismissed')) return true;
        log.warn(' shareDocFile failed:', e);
        return false;
    }
}

/**
 * Save a document to the device (Downloads / Files).
 * Writes to cache then opens share sheet so user can "Save to Files".
 */
async function saveDocFile(uri: string, doc: ShipDocument): Promise<boolean> {
    // On iOS, there's no direct "download" — use share sheet with Save to Files
    return shareDocFile(uri, doc);
}

// ── SwipeableDocCard ───────────────────────────────────────────

interface SwipeableDocCardProps {
    doc: ShipDocument;
    onTap: () => void;
    onEdit: () => void;
    onDelete: () => void;
    selected: boolean;
    onToggleSelect: () => void;
}

const SwipeableDocCard: React.FC<SwipeableDocCardProps> = ({
    doc,
    onTap,
    onEdit,
    onDelete,
    selected,
    onToggleSelect,
}) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable();
    const status = getExpiryStatus(doc.expiry_date);
    const colors = EXPIRY_COLORS[status];

    return (
        <div className="relative overflow-hidden rounded-2xl">
            {/* Delete button */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => {
                    resetSwipe();
                    onDelete();
                }}
            >
                <div className="text-center text-white">
                    <svg className="w-5 h-5 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                    </svg>
                    <span className="text-label font-bold">Delete</span>
                </div>
            </div>

            {/* Main card */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} flex items-stretch border ${colors.border} rounded-2xl overflow-hidden bg-white/[0.03]`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                ref={ref}
                onClick={() => {
                    if (swipeOffset === 0) onTap();
                }}
            >
                {/* Selection checkbox */}
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleSelect();
                    }}
                    className="shrink-0 flex items-center justify-center w-10 ml-1"
                    aria-label={selected ? 'Deselect' : 'Select'}
                >
                    <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                            selected ? 'bg-sky-500 border-sky-500' : 'border-gray-500/40 bg-transparent'
                        }`}
                    >
                        {selected && (
                            <svg
                                className="w-3 h-3 text-white"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={3}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                        )}
                    </div>
                </button>

                {/* Traffic light bar */}
                <div className={`w-1.5 shrink-0 ${colors.dot}`} />

                {/* Content */}
                <div className="flex-1 p-4">
                    {/* Category badge — top of card */}
                    <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="text-micro">{CATEGORY_ICONS[doc.category] || '📋'}</span>
                        <span className="text-micro font-bold text-gray-400 uppercase tracking-widest">
                            {doc.category}
                        </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex-1 text-left min-w-0">
                            <h4 className="text-sm font-black text-white tracking-wide mb-0.5 truncate">
                                {doc.document_name}
                            </h4>
                            <div className="flex items-center gap-2 flex-wrap">
                                <p className={`text-label font-bold uppercase tracking-widest ${colors.text}`}>
                                    {colors.label}
                                </p>
                                {doc.expiry_date && (
                                    <span
                                        className={`px-2 py-0.5 rounded-lg text-label font-bold ${status === 'expired' ? 'bg-red-500/20 text-red-400' : status === 'warning' ? 'bg-amber-500/20 text-amber-400' : 'bg-white/5 text-gray-400'}`}
                                    >
                                        Exp {new Date(doc.expiry_date).toLocaleDateString()}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Direct edit button — vertically centered */}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onEdit();
                            }}
                            className="shrink-0 p-2 rounded-lg hover:bg-white/10 transition-colors self-center"
                            aria-label="Edit document"
                        >
                            <svg
                                className="w-4 h-4 text-slate-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
                                />
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ── Main Component ────────────────────────────────────────────

export const DocumentsHub: React.FC<DocumentsHubProps> = ({ onBack }) => {
    const [documents, setDocuments] = useState<ShipDocument[]>([]);
    const [loading, setLoading] = useState(true);
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
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ── Load ──
    const loadDocs = useCallback(() => {
        setLoading(true);
        try {
            setDocuments(LocalDocumentService.getAll());
        } catch (e) {
            log.error('Failed to load documents:', e);
            toast.error('Failed to load documents');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadDocs();
    }, [loadDocs]);

    // Realtime sync — crew edits appear instantly
    useRealtimeSync('ship_documents', loadDocs);

    const { ref: listRef, flash } = useSuccessFlash();

    // Cloud pull on mount (restore on new device)
    useEffect(() => {
        DocumentSyncService.pullFromCloud().then((restored) => {
            if (restored > 0) {
                loadDocs();
                toast.success(`☁️ Restored ${restored} document${restored > 1 ? 's' : ''} from cloud`);
            }
        });
    }, [loadDocs]);

    // ── Filtered ──
    const filtered = documents.filter((d) => {
        if (!searchQuery.trim()) return true;
        return d.document_name.toLowerCase().includes(searchQuery.toLowerCase());
    });

    // Group by category, sorted alphabetically within each group
    const grouped = CATEGORIES.map((cat) => ({
        ...cat,
        docs: filtered
            .filter((d) => d.category === cat.id)
            .sort((a, b) => a.document_name.localeCompare(b.document_name)),
    })).filter((g) => g.docs.length > 0);

    // ── Handlers ──
    const resetForm = () => {
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
        setShowForm(true);
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setFormFileName(file.name);
        const reader = new FileReader();
        reader.onload = () => {
            setFormFileUri(reader.result as string);
            triggerHaptic('light');
        };
        reader.readAsDataURL(file);
        // Reset input so same file can be re-selected
        e.target.value = '';
    };

    const handleSave = useCallback(async () => {
        if (!formName.trim()) return;
        try {
            triggerHaptic('medium');
            let savedId: string;
            if (editDoc) {
                await LocalDocumentService.update(editDoc.id, {
                    document_name: formName.trim(),
                    category: formCategory,
                    issue_date: formIssueDate || null,
                    expiry_date: formExpiryDate || null,
                    file_uri: formFileUri,
                    notes: formNotes.trim() || null,
                });
                savedId = editDoc.id;
            } else {
                const created = await LocalDocumentService.create({
                    document_name: formName.trim(),
                    category: formCategory,
                    issue_date: formIssueDate || null,
                    expiry_date: formExpiryDate || null,
                    file_uri: formFileUri,
                    notes: formNotes.trim() || null,
                });
                savedId = created.id;
            }
            setShowForm(false);
            resetForm();
            loadDocs();
            toast.success(editDoc ? 'Document updated' : 'Document filed');
            flash();
            // Mark for cloud sync
            DocumentSyncService.markForSync(savedId);
        } catch (e) {
            log.error('Failed to save document:', e);
            toast.error('Failed to save document');
        }
    }, [editDoc, formName, formCategory, formIssueDate, formExpiryDate, formNotes, formFileUri, loadDocs]);

    const [deletedDoc, setDeletedDoc] = useState<ShipDocument | null>(null);

    const handleDelete = useCallback(
        (id: string) => {
            const doc = documents.find((d) => d.id === id);
            if (!doc) return;
            triggerHaptic('medium');
            // Remove from UI immediately
            setDocuments((prev) => prev.filter((d) => d.id !== id));
            setDeletedDoc(doc);
        },
        [documents],
    );

    // Called by UndoToast after 5s — performs the actual delete
    const handleDismissDelete = useCallback(async () => {
        if (!deletedDoc) return;
        const doc = deletedDoc;
        setDeletedDoc(null);
        try {
            await LocalDocumentService.delete(doc.id);
            DocumentSyncService.markDeleted(doc.id);
        } catch (e) {
            log.warn(' delete failed:', e);
            toast.error('Failed to delete document');
            setDocuments((prev) => [...prev, doc]);
        }
    }, [deletedDoc]);

    const handleUndoDelete = useCallback(() => {
        if (deletedDoc) {
            setDocuments((prev) => [...prev, deletedDoc]);
            toast.success('Document restored');
        }
        setDeletedDoc(null);
    }, [deletedDoc]);

    const handleOpenDoc = async (doc: ShipDocument) => {
        if (doc.file_uri) {
            triggerHaptic('light');
            const ok = await openDocFile(doc.file_uri, doc);
            if (!ok) toast.error('Could not open document');
        } else {
            openEditForm(doc);
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

    // Batch download selected docs
    const handleBatchDownload = async () => {
        setHeaderMenuOpen(false);
        const selected = documents.filter((d) => selectedIds.has(d.id) && d.file_uri);
        if (selected.length === 0) {
            toast.error('No files attached to selected documents');
            return;
        }
        triggerHaptic('medium');
        let ok = 0;
        for (const doc of selected) {
            if (doc.file_uri && (await saveDocFile(doc.file_uri, doc))) ok++;
        }
        toast.success(`📥 Saved ${ok} of ${selected.length} file${selected.length > 1 ? 's' : ''}`);
        setSelectedIds(new Set());
    };

    // Batch share/email selected docs
    const handleBatchShare = async () => {
        setHeaderMenuOpen(false);
        const selected = documents.filter((d) => selectedIds.has(d.id) && d.file_uri);
        if (selected.length === 0) {
            toast.error('No files attached to selected documents');
            return;
        }
        triggerHaptic('medium');
        // Share all files via a single share sheet if possible
        try {
            const fileUris: string[] = [];
            for (const doc of selected) {
                if (doc.file_uri) {
                    const freshUri = await DocumentSyncService.getDownloadUrl(doc.file_uri);
                    const cachedUri = await writeUriToCache(freshUri, doc.document_name);
                    fileUris.push(cachedUri);
                }
            }
            const { Share } = await import('@capacitor/share');
            await Share.share({
                title: `Ship's Documents (${fileUris.length})`,
                files: fileUris,
                dialogTitle: 'Share Selected Documents',
            });
        } catch (e: unknown) {
            if (!(e as Error).message?.includes('cancel') && !(e as Error).message?.includes('dismissed')) {
                toast.error('Share failed');
            }
        }
        setSelectedIds(new Set());
    };

    // ── Expiry stats ──
    const expiredCount = documents.filter((d) => getExpiryStatus(d.expiry_date) === 'expired').length;
    const warningCount = documents.filter((d) => getExpiryStatus(d.expiry_date) === 'warning').length;
    const pendingSyncCount = DocumentSyncService.pendingCount;

    // ── Render ──
    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Documents"
                    onBack={onBack}
                    breadcrumbs={["Ship's Office", 'Documents']}
                    subtitle={
                        <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
                            {documents.length} Documents
                            {selectedIds.size > 0 && (
                                <span className="text-sky-400 ml-2">✓ {selectedIds.size} selected</span>
                            )}
                            {expiredCount > 0 && <span className="text-red-400 ml-2">⚠ {expiredCount} Expired</span>}
                            {warningCount > 0 && (
                                <span className="text-amber-400 ml-2">⚡ {warningCount} Expiring</span>
                            )}
                            {pendingSyncCount > 0 && (
                                <span className="text-sky-400 ml-2">☁️ {pendingSyncCount} pending</span>
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
                                <svg className="w-5 h-5 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
                                    <circle cx="12" cy="5" r="1.5" />
                                    <circle cx="12" cy="12" r="1.5" />
                                    <circle cx="12" cy="19" r="1.5" />
                                </svg>
                            </button>
                            {headerMenuOpen && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setHeaderMenuOpen(false)} />
                                    <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                        <button
                                            onClick={handleBatchDownload}
                                            disabled={selectedIds.size === 0}
                                            className="w-full flex items-center gap-2.5 px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors disabled:opacity-30"
                                        >
                                            <svg
                                                className="w-4 h-4 text-sky-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                                                />
                                            </svg>
                                            Download Selected
                                        </button>
                                        <div className="border-t border-white/5" />
                                        <button
                                            onClick={handleBatchShare}
                                            disabled={selectedIds.size === 0}
                                            className="w-full flex items-center gap-2.5 px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors disabled:opacity-30"
                                        >
                                            <svg
                                                className="w-4 h-4 text-emerald-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                                                />
                                            </svg>
                                            Share Selected
                                        </button>
                                        {selectedIds.size > 0 && (
                                            <>
                                                <div className="border-t border-white/5" />
                                                <button
                                                    onClick={() => {
                                                        setSelectedIds(new Set());
                                                        setHeaderMenuOpen(false);
                                                    }}
                                                    className="w-full flex items-center gap-2.5 px-4 py-3 text-sm text-gray-400 hover:bg-white/5 transition-colors"
                                                >
                                                    <svg
                                                        className="w-4 h-4"
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
                                                    Clear Selection
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    }
                />

                {/* Search */}
                <div className="shrink-0 px-4 pb-3">
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search documents..."
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 outline-none focus:border-sky-500/30"
                    />
                </div>

                {/* Documents list (scrollable, grouped) */}
                <div ref={listRef} className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3">
                    {loading ? (
                        <div className="space-y-3 px-1">
                            {[1, 2, 3].map((i) => (
                                <div
                                    key={i}
                                    className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4 flex items-center gap-3"
                                >
                                    <div className="w-10 h-10 rounded-xl skeleton-shimmer" />
                                    <div className="flex-1 space-y-2">
                                        <div className="h-4 w-1/2 rounded-lg skeleton-shimmer" />
                                        <div className="h-3 w-1/4 rounded-lg skeleton-shimmer" />
                                    </div>
                                    <div className="w-16 h-6 rounded-full skeleton-shimmer" />
                                </div>
                            ))}
                        </div>
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
                            title={searchQuery ? 'No Documents Match' : 'No Documents Filed'}
                            subtitle={
                                searchQuery
                                    ? 'Try a different search term.'
                                    : 'Slide below to file your first document.'
                            }
                            className="py-16"
                        />
                    ) : (
                        /* Grouped by category, alphabetical within */
                        grouped.map((group) => (
                            <div key={group.id}>
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-xs">{group.icon}</span>
                                    <span className="text-label font-black text-gray-400 uppercase tracking-widest">
                                        {group.label}
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
                                            onDelete={() => handleDelete(doc.id)}
                                            selected={selectedIds.has(doc.id)}
                                            onToggleSelect={() => toggleSelectDoc(doc.id)}
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
                    <SlideToAction
                        label="Slide to Add Document"
                        thumbIcon={
                            <svg
                                className="w-5 h-5 text-white"
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
                        title={editDoc ? 'Edit Document' : 'Add Document'}
                        alignTop
                    >
                        {/* Category — first */}
                        <div className="mb-3">
                            <label className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-1.5">
                                Category
                            </label>
                            <div className="grid grid-cols-3 gap-1.5">
                                {CATEGORIES.map((cat) => (
                                    <button
                                        key={cat.id}
                                        onClick={() => setFormCategory(cat.id)}
                                        className={`py-1.5 rounded-full text-label font-bold transition-all text-center ${formCategory === cat.id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-400 border border-white/5'}`}
                                    >
                                        {cat.icon} {cat.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Document Name */}
                        <div className="mb-3">
                            <FormField
                                label="Document Name"
                                value={formName}
                                onChange={setFormName}
                                placeholder="Vessel Registration, Hull Insurance 2026..."
                                required
                            />
                        </div>

                        {/* Dates — side by side */}
                        <div className="grid grid-cols-2 gap-2 mb-3 overflow-hidden">
                            <FormField
                                label="Issue Date"
                                type="date"
                                value={formIssueDate}
                                onChange={setFormIssueDate}
                            />
                            <FormField
                                label="Expiry Date"
                                type="date"
                                value={formExpiryDate}
                                onChange={setFormExpiryDate}
                            />
                        </div>

                        {/* Attach Document */}
                        <div className="mb-3">
                            <label className="text-label text-gray-400 font-bold uppercase tracking-widest block mb-1">
                                Attach Document
                            </label>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".pdf,.jpg,.jpeg,.png,.heic,.doc,.docx"
                                onChange={handleFileSelect}
                                className="hidden"
                            />
                            {formFileUri ? (
                                <div className="flex items-center gap-2 bg-white/5 border border-emerald-500/20 rounded-xl px-3 py-2.5">
                                    <svg
                                        className="w-4 h-4 text-emerald-400 shrink-0"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z"
                                        />
                                    </svg>
                                    <span className="text-sm text-emerald-400 font-bold truncate flex-1">
                                        {formFileName}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setFormFileUri(null);
                                            setFormFileName(null);
                                        }}
                                        className="p-1 rounded-full hover:bg-white/10 transition-colors shrink-0"
                                        aria-label="Remove attachment"
                                    >
                                        <svg
                                            className="w-3.5 h-3.5 text-gray-400"
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
                                    </button>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="w-full flex items-center justify-center gap-2 bg-white/5 border border-dashed border-white/[0.15] rounded-xl px-3 py-3 text-sm text-gray-400 hover:text-white hover:border-sky-500/30 hover:bg-white/[0.06] transition-all active:scale-[0.98]"
                                >
                                    <svg
                                        className="w-4 h-4"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13"
                                        />
                                    </svg>
                                    Attach PDF, Photo or Document
                                </button>
                            )}
                        </div>

                        {/* Notes */}
                        <div className="mb-4">
                            <FormField
                                label="Notes (Optional)"
                                type="textarea"
                                value={formNotes}
                                onChange={setFormNotes}
                                placeholder="Policy number, agent contact..."
                                rows={2}
                            />
                        </div>

                        {!formName.trim() && (
                            <p className="text-micro text-amber-400/80 text-center mt-2">Document name is required</p>
                        )}
                        <button
                            onClick={handleSave}
                            disabled={!formName.trim()}
                            className={`w-full py-3 mt-1 rounded-xl text-sm font-black text-white uppercase tracking-[0.15em] transition-all active:scale-[0.97] disabled:opacity-30 ${
                                editDoc
                                    ? 'bg-gradient-to-r from-sky-600 to-sky-600 shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500'
                                    : 'bg-gradient-to-r from-emerald-600 to-emerald-600 shadow-lg shadow-emerald-500/20 hover:from-emerald-500 hover:to-emerald-500'
                            }`}
                        >
                            {editDoc ? 'Save Changes' : 'Add Document'}
                        </button>
                    </ModalSheet>
                )}
            </div>
            <UndoToast
                isOpen={!!deletedDoc}
                message={`"${deletedDoc?.document_name}" deleted`}
                onUndo={handleUndoDelete}
                onDismiss={handleDismissDelete}
            />
        </div>
    );
};
