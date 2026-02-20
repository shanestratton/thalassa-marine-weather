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
import { triggerHaptic } from '../../utils/system';

interface DocumentsHubProps {
    onBack: () => void;
}

const CATEGORIES: { id: DocumentCategory; label: string; icon: string }[] = [
    { id: 'Registration', label: 'Registration', icon: '🚢' },
    { id: 'Insurance', label: 'Insurance', icon: '🛡️' },
    { id: 'Crew Visas/IDs', label: 'Crew IDs', icon: '🪪' },
    { id: 'Radio/MMSI', label: 'Radio/MMSI', icon: '📻' },
    { id: 'Customs Clearances', label: 'Customs', icon: '🛂' },
];

const CATEGORY_ICONS: Record<DocumentCategory, string> = {
    Registration: '🚢',
    Insurance: '🛡️',
    'Crew Visas/IDs': '🪪',
    'Radio/MMSI': '📻',
    'Customs Clearances': '🛂',
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

// ── SwipeableDocCard ───────────────────────────────────────────

interface SwipeableDocCardProps {
    doc: ShipDocument;
    onTap: () => void;
    onDelete: () => void;
}

const SwipeableDocCard: React.FC<SwipeableDocCardProps> = ({ doc, onTap, onDelete }) => {
    const [swipeOffset, setSwipeOffset] = useState(0);
    const [isSwiping, setIsSwiping] = useState(false);
    const startX = useRef(0);
    const deleteThreshold = 80;
    const status = getExpiryStatus(doc.expiry_date);
    const colors = EXPIRY_COLORS[status];

    const handleTouchStart = (e: React.TouchEvent) => {
        startX.current = e.touches[0].clientX;
        setIsSwiping(true);
    };
    const handleTouchMove = (e: React.TouchEvent) => {
        if (!isSwiping) return;
        const diff = startX.current - e.touches[0].clientX;
        setSwipeOffset(Math.max(0, Math.min(diff, deleteThreshold + 20)));
    };
    const handleTouchEnd = () => {
        setIsSwiping(false);
        setSwipeOffset(swipeOffset >= deleteThreshold ? deleteThreshold : 0);
    };

    return (
        <div className="relative overflow-hidden rounded-2xl">
            {/* Delete button */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => { setSwipeOffset(0); onDelete(); }}
            >
                <div className="text-center text-white">
                    <svg className="w-5 h-5 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    <span className="text-[10px] font-bold">Delete</span>
                </div>
            </div>

            {/* Main card */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} flex items-stretch border ${colors.border} rounded-2xl overflow-hidden bg-white/[0.03]`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onClick={() => { if (swipeOffset === 0) onTap(); }}
            >
                {/* Traffic light bar */}
                <div className={`w-1.5 shrink-0 ${colors.dot}`} />

                {/* Content */}
                <div className="flex-1 p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 text-left">
                            <h4 className="text-sm font-black text-white tracking-wide mb-0.5">{doc.document_name}</h4>
                            <p className={`text-[10px] font-bold uppercase tracking-widest ${colors.text}`}>
                                {colors.label}
                            </p>
                        </div>

                        <div className="shrink-0 flex flex-col items-end gap-1">
                            {doc.expiry_date && (
                                <span className={`px-2 py-0.5 rounded-lg text-[9px] font-bold ${status === 'expired' ? 'bg-red-500/20 text-red-400' : status === 'warning' ? 'bg-amber-500/20 text-amber-400' : 'bg-white/5 text-gray-500'}`}>
                                    {status === 'expired' ? 'Exp ' : 'Exp '}
                                    {new Date(doc.expiry_date).toLocaleDateString()}
                                </span>
                            )}
                            {doc.file_uri && (
                                <span className="text-[9px] text-sky-400 font-bold">📄 PDF</span>
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
    const [selectedCategory, setSelectedCategory] = useState<DocumentCategory | 'all'>('all');

    // Add/Edit state
    const [showForm, setShowForm] = useState(false);
    const [editDoc, setEditDoc] = useState<ShipDocument | null>(null);
    const [formName, setFormName] = useState('');
    const [formCategory, setFormCategory] = useState<DocumentCategory>('Registration');
    const [formIssueDate, setFormIssueDate] = useState('');
    const [formExpiryDate, setFormExpiryDate] = useState('');
    const [formNotes, setFormNotes] = useState('');

    // ── Load ──
    const loadDocs = useCallback(() => {
        setLoading(true);
        try {
            setDocuments(LocalDocumentService.getAll());
        } catch (e) {
            console.error('Failed to load documents:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadDocs(); }, [loadDocs]);

    // ── Filtered ──
    const filtered = documents
        .filter(d => selectedCategory === 'all' || d.category === selectedCategory)
        .filter(d => {
            if (!searchQuery.trim()) return true;
            return d.document_name.toLowerCase().includes(searchQuery.toLowerCase());
        });

    // Group by category for display
    const grouped = CATEGORIES.map(cat => ({
        ...cat,
        docs: filtered.filter(d => d.category === cat.id)
            .sort((a, b) => {
                // Expired/warning first
                const sa = getExpiryStatus(a.expiry_date);
                const sb = getExpiryStatus(b.expiry_date);
                const order: Record<ExpiryStatus, number> = { expired: 0, warning: 1, valid: 2, none: 3 };
                return order[sa] - order[sb];
            }),
    })).filter(g => g.docs.length > 0);

    // ── Handlers ──
    const resetForm = () => {
        setFormName(''); setFormCategory('Registration');
        setFormIssueDate(''); setFormExpiryDate(''); setFormNotes('');
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
        setShowForm(true);
    };

    const handleSave = useCallback(async () => {
        if (!formName.trim()) return;
        try {
            triggerHaptic('medium');
            if (editDoc) {
                await LocalDocumentService.update(editDoc.id, {
                    document_name: formName.trim(),
                    category: formCategory,
                    issue_date: formIssueDate || null,
                    expiry_date: formExpiryDate || null,
                    notes: formNotes.trim() || null,
                });
            } else {
                await LocalDocumentService.create({
                    document_name: formName.trim(),
                    category: formCategory,
                    issue_date: formIssueDate || null,
                    expiry_date: formExpiryDate || null,
                    file_uri: null,
                    notes: formNotes.trim() || null,
                });
            }
            setShowForm(false);
            resetForm();
            loadDocs();
        } catch (e) {
            console.error('Failed to save document:', e);
        }
    }, [editDoc, formName, formCategory, formIssueDate, formExpiryDate, formNotes, loadDocs]);

    const handleDelete = useCallback(async (id: string) => {
        if (!confirm('Delete this document? This cannot be undone.')) return;
        try {
            triggerHaptic('medium');
            await LocalDocumentService.delete(id);
            loadDocs();
        } catch (e) {
            console.error('Failed to delete document:', e);
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

    // ── Render ──
    return (
        <div className="w-full max-w-2xl mx-auto px-4 pt-4 animate-in fade-in duration-300 h-full flex flex-col overflow-hidden" style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom, 0px))' }}>

            {/* Header */}
            <div className="flex items-center gap-3 mb-5 shrink-0">
                <button onClick={onBack} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h2 className="text-lg font-black text-white">Ship's Documents</h2>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">
                        {documents.length} Documents
                        {expiredCount > 0 && <span className="text-red-400 ml-2">⚠ {expiredCount} Expired</span>}
                        {warningCount > 0 && <span className="text-amber-400 ml-2">⚡ {warningCount} Expiring</span>}
                    </p>
                </div>
            </div>

            {/* Search */}
            <div className="mb-4 shrink-0">
                <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search documents..."
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30"
                />
            </div>

            {/* Category filters */}
            <div className="shrink-0 mb-4">
                <div className="grid grid-cols-3 gap-2">
                    <button
                        onClick={() => setSelectedCategory('all')}
                        className={`py-2 rounded-full text-xs font-bold transition-all text-center ${selectedCategory === 'all' ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}
                    >
                        All
                    </button>
                    {CATEGORIES.map(cat => (
                        <button
                            key={cat.id}
                            onClick={() => setSelectedCategory(cat.id)}
                            className={`py-2 rounded-full text-xs font-bold transition-all text-center ${selectedCategory === cat.id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}
                        >
                            {cat.icon} {cat.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Documents list (scrollable, grouped) */}
            <div className="flex-1 overflow-y-auto space-y-5 pb-2 min-h-0">
                {loading ? (
                    <div className="flex items-center justify-center py-12">
                        <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="text-center py-12">
                        <p className="text-gray-500 text-sm font-bold">{searchQuery ? 'No documents match' : 'No documents filed'}</p>
                        <p className="text-gray-600 text-xs mt-1">Tap + to add your first document</p>
                    </div>
                ) : selectedCategory !== 'all' ? (
                    /* Flat list when category selected */
                    <div className="space-y-2">
                        {filtered.map(doc => (
                            <SwipeableDocCard
                                key={doc.id}
                                doc={doc}
                                onTap={() => handleOpenDoc(doc)}
                                onDelete={() => handleDelete(doc.id)}
                            />
                        ))}
                    </div>
                ) : (
                    /* Grouped by category */
                    grouped.map(group => (
                        <div key={group.id}>
                            <div className="flex items-center gap-2 mb-2">
                                <span className="text-xs">{group.icon}</span>
                                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{group.label}</span>
                                <span className="text-[9px] text-gray-600 font-bold">({group.docs.length})</span>
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

            {/* Add Document button (fixed at bottom) */}
            <div className="shrink-0 pt-3 pb-[env(safe-area-inset-bottom,0px)]">
                <button
                    onClick={() => { triggerHaptic('light'); openAddForm(); }}
                    className="w-full py-4 bg-gradient-to-r from-emerald-600/20 to-teal-600/20 border border-emerald-500/20 rounded-2xl flex items-center justify-center gap-3 group hover:from-emerald-600/30 hover:to-teal-600/30 transition-all active:scale-[0.98]"
                >
                    <div className="p-2 bg-emerald-500/20 rounded-lg group-hover:bg-emerald-500/30 transition-colors">
                        <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                    </div>
                    <span className="text-sm font-black text-emerald-400 uppercase tracking-[0.15em]">Add Document</span>
                </button>
            </div>

            {/* ═══ ADD / EDIT DOCUMENT MODAL ═══ */}
            {showForm && (
                <div className="fixed inset-0 z-[999] flex items-center justify-center p-4" onClick={() => { setShowForm(false); resetForm(); }}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                    <div
                        className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,24px))] animate-in fade-in zoom-in-95 duration-300 max-h-[85vh] overflow-y-auto"
                        onClick={e => e.stopPropagation()}
                    >
                        <button onClick={() => { setShowForm(false); resetForm(); }} className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10">
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>

                        <h3 className="text-lg font-black text-white mb-5">{editDoc ? 'Edit Document' : 'Add Document'}</h3>

                        {/* Document Name */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Document Name</label>
                            <input type="text" value={formName} onChange={e => setFormName(e.target.value)} placeholder="Vessel Registration, Hull Insurance 2026..." className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30" />
                        </div>

                        {/* Category */}
                        <div className="mb-4">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-2">Category</label>
                            <div className="grid grid-cols-3 gap-2">
                                {CATEGORIES.map(cat => (
                                    <button key={cat.id} onClick={() => setFormCategory(cat.id)} className={`py-2 rounded-full text-xs font-bold transition-all text-center ${formCategory === cat.id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}>
                                        {cat.icon} {cat.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Dates */}
                        <div className="grid grid-cols-2 gap-3 mb-4">
                            <div>
                                <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Issue Date</label>
                                <input type="date" value={formIssueDate} onChange={e => setFormIssueDate(e.target.value)} className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-sky-500/30" />
                            </div>
                            <div>
                                <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Expiry Date</label>
                                <input type="date" value={formExpiryDate} onChange={e => setFormExpiryDate(e.target.value)} className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-sky-500/30" />
                            </div>
                        </div>

                        {/* Notes */}
                        <div className="mb-6">
                            <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Notes (Optional)</label>
                            <textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} placeholder="Policy number, agent contact..." rows={2} className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30 resize-none" />
                        </div>

                        <button
                            onClick={handleSave}
                            disabled={!formName.trim()}
                            className={`w-full py-3.5 rounded-xl text-sm font-black text-white uppercase tracking-[0.15em] transition-all active:scale-[0.97] disabled:opacity-30 ${editDoc
                                ? 'bg-gradient-to-r from-sky-600 to-cyan-600 shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-cyan-500'
                                : 'bg-gradient-to-r from-emerald-600 to-teal-600 shadow-lg shadow-emerald-500/20 hover:from-emerald-500 hover:to-teal-500'
                                }`}
                        >
                            {editDoc ? 'Save Changes' : 'Add Document'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
