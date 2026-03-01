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
import type { ShipDocument, DocumentCategory } from '../../types';
import { LocalDocumentService } from '../../services/vessel/LocalDocumentService';
import { DocumentSyncService } from '../../services/vessel/DocumentSyncService';
import { triggerHaptic } from '../../utils/system';
import { SlideToAction } from '../ui/SlideToAction';
import { PageHeader } from '../ui/PageHeader';
import { toast } from '../Toast';
import { useSwipeable } from '../../hooks/useSwipeable';

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
    none: { dot: 'bg-gray-500', text: 'text-gray-500', border: 'border-gray-500/20', label: 'No Expiry' },
};

// ── File helpers ───────────────────────────────────────────────

/** Convert a data URI or cloud URL to a File object */
async function uriToFile(uri: string, fileName: string): Promise<File | null> {
    try {
        const res = await fetch(uri);
        const blob = await res.blob();
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const mimeMap: Record<string, string> = {
            pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
            png: 'image/png', heic: 'image/heic', doc: 'application/msword',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        };
        const mime = mimeMap[ext] || blob.type || 'application/octet-stream';
        return new File([blob], fileName, { type: mime });
    } catch {
        return null;
    }
}

/** Download a file to the device */
async function downloadFile(uri: string, fileName: string): Promise<boolean> {
    try {
        const res = await fetch(uri);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return true;
    } catch {
        return false;
    }
}

/** Share a file via Web Share API (email, AirDrop, WhatsApp, etc.) */
async function shareFile(uri: string, doc: ShipDocument): Promise<boolean> {
    const fileName = `${doc.document_name.replace(/[^a-zA-Z0-9 ]/g, '').trim()}` ||
        'document';

    // Determine file extension from URI
    let ext = 'pdf';
    if (uri.startsWith('data:')) {
        const mimeMatch = uri.match(/^data:([^;]+);/);
        const mime = mimeMatch?.[1] || '';
        if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
        else if (mime.includes('png')) ext = 'png';
        else if (mime.includes('pdf')) ext = 'pdf';
        else if (mime.includes('heic')) ext = 'heic';
    } else {
        const urlExt = uri.split('.').pop()?.split('?')[0]?.toLowerCase();
        if (urlExt && ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx', 'heic'].includes(urlExt)) {
            ext = urlExt;
        }
    }

    const fullFileName = `${fileName}.${ext}`;

    // Try Web Share API with files (works on iOS Safari, Android Chrome)
    if (navigator.share) {
        try {
            const file = await uriToFile(uri, fullFileName);
            if (file && navigator.canShare?.({ files: [file] })) {
                await navigator.share({
                    title: doc.document_name,
                    text: `Ship's Document: ${doc.document_name} (${doc.category})`,
                    files: [file],
                });
                return true;
            }
            // Fallback: share URL only (for cloud-stored docs)
            if (!uri.startsWith('data:')) {
                await navigator.share({
                    title: doc.document_name,
                    text: `Ship's Document: ${doc.document_name} (${doc.category})`,
                    url: uri,
                });
                return true;
            }
        } catch (e: unknown) {
            if ((e as Error).name === 'AbortError') return false; // User cancelled
        }
    }

    // Fallback: open in new tab (user can save/share from there)
    if (!uri.startsWith('data:')) {
        window.open(uri, '_blank');
        return true;
    }

    return false;
}

// ── SwipeableDocCard ───────────────────────────────────────────

interface SwipeableDocCardProps {
    doc: ShipDocument;
    onTap: () => void;
    onDelete: () => void;
}

const SwipeableDocCard: React.FC<SwipeableDocCardProps> = ({ doc, onTap, onDelete }) => {
    const { swipeOffset, isSwiping, resetSwipe, handlers } = useSwipeable();
    const [actionBusy, setActionBusy] = useState<'download' | 'share' | null>(null);
    const status = getExpiryStatus(doc.expiry_date);
    const colors = EXPIRY_COLORS[status];
    const hasFile = !!doc.file_uri;

    const handleDownload = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!doc.file_uri) return;
        setActionBusy('download');
        triggerHaptic('light');
        const ok = await downloadFile(doc.file_uri, doc.document_name);
        if (ok) toast.success('📥 Saved to device');
        else toast.error('Download failed');
        setActionBusy(null);
    };

    const handleShare = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!doc.file_uri) return;
        setActionBusy('share');
        triggerHaptic('light');
        const ok = await shareFile(doc.file_uri, doc);
        if (!ok) toast.error('Share not available');
        setActionBusy(null);
    };

    return (
        <div className="relative overflow-hidden rounded-2xl">
            {/* Delete button */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => { resetSwipe(); onDelete(); }}
            >
                <div className="text-center text-white">
                    <svg className="w-5 h-5 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    <span className="text-[11px] font-bold">Delete</span>
                </div>
            </div>

            {/* Main card */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} flex items-stretch border ${colors.border} rounded-2xl overflow-hidden bg-white/[0.03]`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                {...handlers}
                onClick={() => { if (swipeOffset === 0) onTap(); }}
            >
                {/* Traffic light bar */}
                <div className={`w-1.5 shrink-0 ${colors.dot}`} />

                {/* Content */}
                <div className="flex-1 p-4">
                    {/* Category badge — top of card */}
                    <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="text-[10px]">{CATEGORY_ICONS[doc.category] || '📋'}</span>
                        <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">{doc.category}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 text-left">
                            <h4 className="text-sm font-black text-white tracking-wide mb-0.5">{doc.document_name}</h4>
                            <p className={`text-[11px] font-bold uppercase tracking-widest ${colors.text}`}>
                                {colors.label}
                            </p>
                        </div>

                        <div className="shrink-0 flex flex-col items-end gap-1">
                            {doc.expiry_date && (
                                <span className={`px-2 py-0.5 rounded-lg text-[11px] font-bold ${status === 'expired' ? 'bg-red-500/20 text-red-400' : status === 'warning' ? 'bg-amber-500/20 text-amber-400' : 'bg-white/5 text-gray-500'}`}>
                                    {status === 'expired' ? 'Exp ' : 'Exp '}
                                    {new Date(doc.expiry_date).toLocaleDateString()}
                                </span>
                            )}
                            {/* File action buttons */}
                            {hasFile && (
                                <div className="flex items-center gap-1.5 mt-0.5">
                                    {/* Download to phone */}
                                    <button
                                        onClick={handleDownload}
                                        disabled={actionBusy === 'download'}
                                        className="p-1.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400 hover:bg-sky-500/20 active:scale-95 transition-all disabled:opacity-50"
                                        aria-label="Download to phone"
                                    >
                                        {actionBusy === 'download' ? (
                                            <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4" strokeLinecap="round" />
                                            </svg>
                                        ) : (
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                            </svg>
                                        )}
                                    </button>
                                    {/* Share / Email */}
                                    <button
                                        onClick={handleShare}
                                        disabled={actionBusy === 'share'}
                                        className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 active:scale-95 transition-all disabled:opacity-50"
                                        aria-label="Share or email"
                                    >
                                        {actionBusy === 'share' ? (
                                            <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4" strokeLinecap="round" />
                                            </svg>
                                        ) : (
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                            </svg>
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>
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
            console.error('Failed to load documents:', e);
            toast.error('Failed to load documents');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadDocs(); }, [loadDocs]);

    // Cloud pull on mount (restore on new device)
    useEffect(() => {
        DocumentSyncService.pullFromCloud().then(restored => {
            if (restored > 0) {
                loadDocs();
                toast.success(`☁️ Restored ${restored} document${restored > 1 ? 's' : ''} from cloud`);
            }
        });
    }, [loadDocs]);

    // ── Filtered ──
    const filtered = documents
        .filter(d => {
            if (!searchQuery.trim()) return true;
            return d.document_name.toLowerCase().includes(searchQuery.toLowerCase());
        });

    // Group by category, sorted alphabetically within each group
    const grouped = CATEGORIES.map(cat => ({
        ...cat,
        docs: filtered.filter(d => d.category === cat.id)
            .sort((a, b) => a.document_name.localeCompare(b.document_name)),
    })).filter(g => g.docs.length > 0);

    // ── Handlers ──
    const resetForm = () => {
        setFormName(''); setFormCategory('Registration');
        setFormIssueDate(''); setFormExpiryDate(''); setFormNotes('');
        setFormFileUri(null); setFormFileName(null);
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
            // Mark for cloud sync
            DocumentSyncService.markForSync(savedId);
        } catch (e) {
            console.error('Failed to save document:', e);
            toast.error('Failed to save document');
        }
    }, [editDoc, formName, formCategory, formIssueDate, formExpiryDate, formNotes, formFileUri, loadDocs]);

    const handleDelete = useCallback(async (id: string) => {
        if (!confirm('Delete this document? This cannot be undone.')) return;
        try {
            triggerHaptic('medium');
            await LocalDocumentService.delete(id);
            DocumentSyncService.markDeleted(id);
            loadDocs();
        } catch (e) {
            console.error('Failed to delete document:', e);
            toast.error('Failed to delete document');
        }
    }, [loadDocs]);

    const handleOpenDoc = (doc: ShipDocument) => {
        if (doc.file_uri) {
            window.open(doc.file_uri, '_blank');
        } else {
            openEditForm(doc);
        }
    };

    // ── Expiry stats ──
    const expiredCount = documents.filter(d => getExpiryStatus(d.expiry_date) === 'expired').length;
    const warningCount = documents.filter(d => getExpiryStatus(d.expiry_date) === 'warning').length;
    const pendingSyncCount = DocumentSyncService.pendingCount;

    // ── Render ──
    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            <div className="flex flex-col h-full">

                <PageHeader
                    title="Documents"
                    onBack={onBack}
                    breadcrumbs={['Ship\'s Office', 'Documents']}
                    subtitle={
                        <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">
                            {documents.length} Documents
                            {expiredCount > 0 && <span className="text-red-400 ml-2">⚠ {expiredCount} Expired</span>}
                            {warningCount > 0 && <span className="text-amber-400 ml-2">⚡ {warningCount} Expiring</span>}
                            {pendingSyncCount > 0 && <span className="text-sky-400 ml-2">☁️ {pendingSyncCount} pending</span>}
                        </p>
                    }
                />

                {/* Search */}
                <div className="shrink-0 px-4 pb-3">
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search documents..."
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30"
                    />
                </div>



                {/* Documents list (scrollable, grouped) */}
                <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3">
                    {loading ? (
                        <div className="space-y-3 px-1">
                            {[1, 2, 3].map(i => (
                                <div key={i} className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4 flex items-center gap-3">
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
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 px-6 py-16">
                            <div className="relative w-20 h-20 mb-5">
                                <svg viewBox="0 0 96 96" fill="none" className="w-full h-full text-sky-500/30">
                                    <circle cx="48" cy="48" r="44" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" />
                                    <circle cx="48" cy="48" r="6" fill="currentColor" fillOpacity="0.3" />
                                    <path d="M48 8L52 44H44L48 8Z" fill="currentColor" fillOpacity="0.6" />
                                    <path d="M48 88L44 52H52L48 88Z" fill="currentColor" fillOpacity="0.3" />
                                </svg>
                            </div>
                            <p className="text-base font-bold text-white mb-1">
                                {searchQuery ? 'No Documents Match' : 'No Documents Filed'}
                            </p>
                            <p className="text-sm text-white/60 max-w-[240px] text-center">
                                {searchQuery ? 'Try a different search term.' : 'Slide below to file your first document.'}
                            </p>
                        </div>
                    ) : (
                        /* Grouped by category, alphabetical within */
                        grouped.map(group => (
                            <div key={group.id}>
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-xs">{group.icon}</span>
                                    <span className="text-[11px] font-black text-gray-400 uppercase tracking-widest">{group.label}</span>
                                    <span className="text-[11px] text-gray-500 font-bold">({group.docs.length})</span>
                                </div>
                                <div className="space-y-2">
                                    {group.docs.map(doc => (
                                        <SwipeableDocCard
                                            key={doc.id}
                                            doc={doc}
                                            onTap={() => handleOpenDoc(doc)}
                                            onDelete={() => handleDelete(doc.id)}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Add Document CTA (fixed at bottom) */}
                <div className="shrink-0 px-4 pt-2 bg-slate-950" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
                    <SlideToAction
                        label="Slide to Add Document"
                        thumbIcon={
                            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
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
                    <div className="fixed inset-0 z-[999] flex items-start justify-center overflow-y-auto" style={{ padding: '0 12px', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 56px)', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 4rem + 8px)' }} onClick={() => { setShowForm(false); resetForm(); }}>
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                        <div
                            className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-2xl p-4 animate-in fade-in zoom-in-95 duration-300"
                            onClick={e => e.stopPropagation()}
                        >
                            <button onClick={() => { setShowForm(false); resetForm(); }} className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10">
                                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>

                            <h3 className="text-base font-black text-white mb-3">{editDoc ? 'Edit Document' : 'Add Document'}</h3>

                            {/* Category — first */}
                            <div className="mb-3">
                                <label className="text-[11px] text-gray-500 font-bold uppercase tracking-widest block mb-1.5">Category</label>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {CATEGORIES.map(cat => (
                                        <button key={cat.id} onClick={() => setFormCategory(cat.id)} className={`py-1.5 rounded-full text-[11px] font-bold transition-all text-center ${formCategory === cat.id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}>
                                            {cat.icon} {cat.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Document Name */}
                            <div className="mb-3">
                                <label className="text-[11px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Document Name</label>
                                <input type="text" value={formName} onChange={e => setFormName(e.target.value)} placeholder="Vessel Registration, Hull Insurance 2026..." className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30" />
                            </div>

                            {/* Dates — side by side */}
                            <div className="grid grid-cols-2 gap-2 mb-3 overflow-hidden">
                                <div className="min-w-0">
                                    <label className="text-[11px] text-gray-500 font-bold uppercase tracking-wider block mb-1">Issue Date</label>
                                    <input type="date" value={formIssueDate} onChange={e => setFormIssueDate(e.target.value)} className="w-full min-w-0 bg-white/[0.04] border border-white/[0.08] rounded-xl px-1.5 py-2 text-[13px] text-white outline-none focus:border-sky-500/30 [color-scheme:dark]" />
                                </div>
                                <div className="min-w-0">
                                    <label className="text-[11px] text-gray-500 font-bold uppercase tracking-wider block mb-1">Expiry Date</label>
                                    <input type="date" value={formExpiryDate} onChange={e => setFormExpiryDate(e.target.value)} className="w-full min-w-0 bg-white/[0.04] border border-white/[0.08] rounded-xl px-1.5 py-2 text-[13px] text-white outline-none focus:border-sky-500/30 [color-scheme:dark]" />
                                </div>
                            </div>

                            {/* Attach Document */}
                            <div className="mb-3">
                                <label className="text-[11px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Attach Document</label>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".pdf,.jpg,.jpeg,.png,.heic,.doc,.docx"
                                    onChange={handleFileSelect}
                                    className="hidden"
                                />
                                {formFileUri ? (
                                    <div className="flex items-center gap-2 bg-white/[0.04] border border-emerald-500/20 rounded-xl px-3 py-2.5">
                                        <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                                        </svg>
                                        <span className="text-sm text-emerald-400 font-bold truncate flex-1">{formFileName}</span>
                                        <button
                                            type="button"
                                            onClick={() => { setFormFileUri(null); setFormFileName(null); }}
                                            className="p-1 rounded-full hover:bg-white/10 transition-colors shrink-0"
                                        >
                                            <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                            </svg>
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => fileInputRef.current?.click()}
                                        className="w-full flex items-center justify-center gap-2 bg-white/[0.04] border border-dashed border-white/[0.15] rounded-xl px-3 py-3 text-sm text-gray-400 hover:text-white hover:border-sky-500/30 hover:bg-white/[0.06] transition-all active:scale-[0.98]"
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                                        </svg>
                                        Attach PDF, Photo or Document
                                    </button>
                                )}
                            </div>

                            {/* Notes */}
                            <div className="mb-4">
                                <label className="text-[11px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Notes (Optional)</label>
                                <textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} placeholder="Policy number, agent contact..." rows={2} className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30 resize-none" />
                            </div>

                            <button
                                onClick={handleSave}
                                disabled={!formName.trim()}
                                className={`w-full py-3 rounded-xl text-sm font-black text-white uppercase tracking-[0.15em] transition-all active:scale-[0.97] disabled:opacity-30 ${editDoc
                                    ? 'bg-gradient-to-r from-sky-600 to-sky-600 shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500'
                                    : 'bg-gradient-to-r from-emerald-600 to-emerald-600 shadow-lg shadow-emerald-500/20 hover:from-emerald-500 hover:to-emerald-500'
                                    }`}
                            >
                                {editDoc ? 'Save Changes' : 'Add Document'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
