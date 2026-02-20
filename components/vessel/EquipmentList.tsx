/**
 * EquipmentList — Searchable Equipment Register with category filters.
 *
 * Features:
 * - Full-text search across name, make, model, serial
 * - Horizontal category filter chips (grid layout)
 * - Swipe-to-delete cards with serial number copy
 * - Add Equipment modal (centered, X close)
 * - Tap card → EquipmentDetail view
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { EquipmentItem, EquipmentCategory } from '../../types';
import { LocalEquipmentService } from '../../services/vessel/LocalEquipmentService';
import { triggerHaptic } from '../../utils/system';

interface EquipmentListProps {
    onBack: () => void;
}

const CATEGORIES: { id: EquipmentCategory; label: string; icon: string }[] = [
    { id: 'Propulsion', label: 'Propulsion', icon: '⚙️' },
    { id: 'Electronics', label: 'Electronics', icon: '📡' },
    { id: 'HVAC', label: 'HVAC', icon: '❄️' },
    { id: 'Plumbing', label: 'Plumbing', icon: '🔧' },
    { id: 'Rigging', label: 'Rigging', icon: '⛵' },
    { id: 'Galley', label: 'Galley', icon: '🍳' },
];

const CATEGORY_ICONS: Record<EquipmentCategory, string> = {
    Propulsion: '⚙️',
    Electronics: '📡',
    HVAC: '❄️',
    Plumbing: '🔧',
    Rigging: '⛵',
    Galley: '🍳',
};

// ── SwipeableEquipmentCard ─────────────────────────────────────

interface SwipeableCardProps {
    item: EquipmentItem;
    onTap: () => void;
    onDelete: () => void;
    onCopySerial: () => void;
}

const SwipeableEquipmentCard: React.FC<SwipeableCardProps> = ({ item, onTap, onDelete, onCopySerial }) => {
    const [swipeOffset, setSwipeOffset] = useState(0);
    const [isSwiping, setIsSwiping] = useState(false);
    const startX = useRef(0);
    const deleteThreshold = 80;

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

    const warrantyActive = item.warranty_expiry
        ? new Date(item.warranty_expiry).getTime() > Date.now()
        : false;

    return (
        <div className="relative overflow-hidden rounded-2xl">
            {/* Delete button (revealed on swipe) */}
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

            {/* Main content (slides on swipe) */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} border border-white/10 rounded-2xl overflow-hidden bg-white/[0.03]`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onClick={() => { if (swipeOffset === 0) onTap(); }}
            >
                <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 text-left">
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs">{CATEGORY_ICONS[item.category] || '📋'}</span>
                                <h4 className="text-sm font-black text-white tracking-wide">{item.equipment_name}</h4>
                            </div>
                            <p className="text-[10px] text-gray-400 font-bold">
                                {item.make} — {item.model}
                            </p>
                        </div>

                        <div className="shrink-0 flex flex-col items-end gap-1">
                            {/* Warranty badge */}
                            {item.warranty_expiry && (
                                <span className={`px-2 py-0.5 rounded-lg text-[9px] font-bold uppercase tracking-wider ${warrantyActive
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : 'bg-red-500/20 text-red-400 border border-red-500/30'
                                    }`}>
                                    {warrantyActive ? '✓ Warranty' : '✗ Expired'}
                                </span>
                            )}

                            {/* Serial with copy */}
                            {item.serial_number && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onCopySerial();
                                    }}
                                    className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors group"
                                >
                                    <span className="text-[9px] text-gray-500 font-mono">{item.serial_number}</span>
                                    <svg className="w-3 h-3 text-gray-600 group-hover:text-sky-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                    </svg>
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ── EquipmentDetail (inline) ──────────────────────────────────

interface EquipmentDetailProps {
    item: EquipmentItem;
    onBack: () => void;
    onEdit: () => void;
    onDelete: () => void;
}

const EquipmentDetail: React.FC<EquipmentDetailProps> = ({ item, onBack, onEdit, onDelete }) => {
    const warrantyActive = item.warranty_expiry
        ? new Date(item.warranty_expiry).getTime() > Date.now()
        : null;

    const copySerial = () => {
        navigator.clipboard.writeText(item.serial_number).then(() => {
            triggerHaptic('light');
        }).catch(() => { });
    };

    const openManual = () => {
        if (item.manual_uri) {
            window.open(item.manual_uri, '_blank');
        }
    };

    return (
        <div className="w-full max-w-2xl mx-auto px-4 pt-4 animate-in fade-in duration-300 h-full flex flex-col" style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom, 0px))' }}>

            {/* Header */}
            <div className="flex items-center gap-3 mb-5">
                <button
                    onClick={onBack}
                    className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                >
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h2 className="text-lg font-black text-white">{item.equipment_name}</h2>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">{CATEGORY_ICONS[item.category]} {item.category}</p>
                </div>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto space-y-4 min-h-0 pb-4">

                {/* Specs card */}
                <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-5">
                    <h3 className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-4">Specifications</h3>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <p className="text-[9px] text-gray-600 uppercase tracking-widest font-bold mb-0.5">Make</p>
                            <p className="text-sm font-bold text-white">{item.make || '—'}</p>
                        </div>
                        <div>
                            <p className="text-[9px] text-gray-600 uppercase tracking-widest font-bold mb-0.5">Model</p>
                            <p className="text-sm font-bold text-white">{item.model || '—'}</p>
                        </div>
                    </div>

                    {/* Serial */}
                    <div className="mt-4">
                        <p className="text-[9px] text-gray-600 uppercase tracking-widest font-bold mb-1">Serial Number</p>
                        <div className="flex items-center gap-2">
                            <p className="text-sm font-mono font-bold text-sky-400">{item.serial_number || '—'}</p>
                            {item.serial_number && (
                                <button
                                    onClick={copySerial}
                                    className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                                    title="Copy serial number"
                                >
                                    <svg className="w-4 h-4 text-gray-400 hover:text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                    </svg>
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Install date */}
                    {item.installation_date && (
                        <div className="mt-4">
                            <p className="text-[9px] text-gray-600 uppercase tracking-widest font-bold mb-0.5">Installed</p>
                            <p className="text-sm font-bold text-white">{new Date(item.installation_date).toLocaleDateString()}</p>
                        </div>
                    )}
                </div>

                {/* Warranty status */}
                <div className={`border rounded-2xl p-5 ${warrantyActive === true
                    ? 'bg-emerald-500/10 border-emerald-500/30'
                    : warrantyActive === false
                        ? 'bg-red-500/10 border-red-500/30'
                        : 'bg-white/[0.04] border-white/[0.08]'
                    }`}>
                    <h3 className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-2">Warranty Status</h3>
                    {warrantyActive === true && (
                        <>
                            <p className="text-sm font-black text-emerald-400">✓ Active</p>
                            <p className="text-[10px] text-emerald-400/70 font-bold mt-1">
                                Expires {new Date(item.warranty_expiry!).toLocaleDateString()}
                            </p>
                        </>
                    )}
                    {warrantyActive === false && (
                        <>
                            <p className="text-sm font-black text-red-400">✗ Expired</p>
                            <p className="text-[10px] text-red-400/70 font-bold mt-1">
                                Expired {new Date(item.warranty_expiry!).toLocaleDateString()}
                            </p>
                        </>
                    )}
                    {warrantyActive === null && (
                        <p className="text-sm font-bold text-gray-500">No warranty date set</p>
                    )}
                </div>

                {/* Open Manual button */}
                {item.manual_uri && (
                    <button
                        onClick={openManual}
                        className="w-full py-4 bg-gradient-to-r from-sky-600/20 to-cyan-600/20 border border-sky-500/20 rounded-2xl flex items-center justify-center gap-3 group hover:from-sky-600/30 hover:to-cyan-600/30 transition-all active:scale-[0.98]"
                    >
                        <svg className="w-6 h-6 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                        </svg>
                        <span className="text-sm font-black text-sky-400 uppercase tracking-[0.15em]">Open Manual (PDF)</span>
                    </button>
                )}

                {/* Notes */}
                {item.notes && (
                    <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-5">
                        <h3 className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-2">Notes</h3>
                        <p className="text-sm text-gray-300 leading-relaxed">{item.notes}</p>
                    </div>
                )}

                {/* Delete button */}
                <button
                    onClick={onDelete}
                    className="w-full py-3 bg-red-500/10 border border-red-500/20 rounded-2xl text-sm font-bold text-red-400 hover:bg-red-500/20 transition-all active:scale-[0.98]"
                >
                    Delete Equipment
                </button>
            </div>

            {/* Edit FAB */}
            <button
                onClick={onEdit}
                className="fixed bottom-24 right-6 w-14 h-14 bg-sky-500 rounded-full flex items-center justify-center shadow-lg shadow-sky-500/30 hover:bg-sky-400 transition-all active:scale-90 z-50"
            >
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
            </button>
        </div>
    );
};

// ── Main Component ────────────────────────────────────────────

export const EquipmentList: React.FC<EquipmentListProps> = ({ onBack }) => {
    const [items, setItems] = useState<EquipmentItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<EquipmentCategory | 'all'>('all');
    const [selectedItem, setSelectedItem] = useState<EquipmentItem | null>(null);

    // Add form state
    const [showAddForm, setShowAddForm] = useState(false);
    const [newName, setNewName] = useState('');
    const [newCategory, setNewCategory] = useState<EquipmentCategory>('Propulsion');
    const [newMake, setNewMake] = useState('');
    const [newModel, setNewModel] = useState('');
    const [newSerial, setNewSerial] = useState('');
    const [newInstallDate, setNewInstallDate] = useState('');
    const [newWarrantyExpiry, setNewWarrantyExpiry] = useState('');
    const [newNotes, setNewNotes] = useState('');

    // Edit modal state
    const [showEditForm, setShowEditForm] = useState(false);

    // ── Load ──
    const loadItems = useCallback(() => {
        setLoading(true);
        try {
            setItems(LocalEquipmentService.getAll());
        } catch (e) {
            console.error('Failed to load equipment:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadItems(); }, [loadItems]);

    // ── Filtered items ──
    const filteredItems = items
        .filter(i => selectedCategory === 'all' || i.category === selectedCategory)
        .filter(i => {
            if (!searchQuery.trim()) return true;
            const q = searchQuery.toLowerCase();
            return (
                i.equipment_name.toLowerCase().includes(q) ||
                i.make.toLowerCase().includes(q) ||
                i.model.toLowerCase().includes(q) ||
                i.serial_number.toLowerCase().includes(q)
            );
        })
        .sort((a, b) => a.equipment_name.localeCompare(b.equipment_name));

    // ── Handlers ──
    const handleAdd = useCallback(async () => {
        if (!newName.trim()) return;
        try {
            triggerHaptic('medium');
            await LocalEquipmentService.create({
                equipment_name: newName.trim(),
                category: newCategory,
                make: newMake.trim(),
                model: newModel.trim(),
                serial_number: newSerial.trim(),
                installation_date: newInstallDate || null,
                warranty_expiry: newWarrantyExpiry || null,
                manual_uri: null,
                notes: newNotes.trim() || null,
            });
            setShowAddForm(false);
            setNewName(''); setNewMake(''); setNewModel(''); setNewSerial('');
            setNewInstallDate(''); setNewWarrantyExpiry(''); setNewNotes('');
            loadItems();
        } catch (e) {
            console.error('Failed to add equipment:', e);
        }
    }, [newName, newCategory, newMake, newModel, newSerial, newInstallDate, newWarrantyExpiry, newNotes, loadItems]);

    const handleDelete = useCallback(async (id: string) => {
        if (!confirm('Delete this equipment? This cannot be undone.')) return;
        try {
            triggerHaptic('medium');
            await LocalEquipmentService.delete(id);
            setSelectedItem(null);
            loadItems();
        } catch (e) {
            console.error('Failed to delete equipment:', e);
        }
    }, [loadItems]);

    const handleCopySerial = (serial: string) => {
        navigator.clipboard.writeText(serial).then(() => {
            triggerHaptic('light');
        }).catch(() => { });
    };

    const handleSaveEdit = useCallback(async () => {
        if (!selectedItem || !newName.trim()) return;
        try {
            triggerHaptic('medium');
            await LocalEquipmentService.update(selectedItem.id, {
                equipment_name: newName.trim(),
                category: newCategory,
                make: newMake.trim(),
                model: newModel.trim(),
                serial_number: newSerial.trim(),
                installation_date: newInstallDate || null,
                warranty_expiry: newWarrantyExpiry || null,
                notes: newNotes.trim() || null,
            });
            setShowEditForm(false);
            loadItems();
            // Update selected item in place
            setSelectedItem(prev => prev ? {
                ...prev,
                equipment_name: newName.trim(),
                category: newCategory,
                make: newMake.trim(),
                model: newModel.trim(),
                serial_number: newSerial.trim(),
                installation_date: newInstallDate || null,
                warranty_expiry: newWarrantyExpiry || null,
                notes: newNotes.trim() || null,
            } : null);
        } catch (e) {
            console.error('Failed to update equipment:', e);
        }
    }, [selectedItem, newName, newCategory, newMake, newModel, newSerial, newInstallDate, newWarrantyExpiry, newNotes, loadItems]);

    const openEditForm = (item: EquipmentItem) => {
        setNewName(item.equipment_name);
        setNewCategory(item.category);
        setNewMake(item.make);
        setNewModel(item.model);
        setNewSerial(item.serial_number);
        setNewInstallDate(item.installation_date || '');
        setNewWarrantyExpiry(item.warranty_expiry || '');
        setNewNotes(item.notes || '');
        setShowEditForm(true);
    };

    // ── Detail View ──
    if (selectedItem) {
        return (
            <>
                <EquipmentDetail
                    item={selectedItem}
                    onBack={() => setSelectedItem(null)}
                    onEdit={() => openEditForm(selectedItem)}
                    onDelete={() => handleDelete(selectedItem.id)}
                />

                {/* Edit Equipment Modal */}
                {showEditForm && (
                    <div className="fixed inset-0 z-[999] flex items-center justify-center p-4" onClick={() => setShowEditForm(false)}>
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                        <div
                            className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,24px))] animate-in fade-in zoom-in-95 duration-300 max-h-[85vh] overflow-y-auto"
                            onClick={e => e.stopPropagation()}
                        >
                            <button onClick={() => setShowEditForm(false)} className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10">
                                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                            <h3 className="text-lg font-black text-white mb-5">Edit Equipment</h3>
                            {renderFormFields()}
                            <button
                                onClick={handleSaveEdit}
                                className="w-full py-3.5 bg-gradient-to-r from-sky-600 to-cyan-600 text-white font-black text-sm uppercase tracking-[0.15em] rounded-xl hover:from-sky-500 hover:to-cyan-500 transition-all active:scale-[0.98]"
                            >
                                Save Changes
                            </button>
                        </div>
                    </div>
                )}
            </>
        );
    }

    // ── Shared form fields ──
    function renderFormFields() {
        return (
            <>
                <div className="mb-4">
                    <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Equipment Name</label>
                    <input type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Main Engine" className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30" />
                </div>

                <div className="mb-4">
                    <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-2">Category</label>
                    <div className="grid grid-cols-3 gap-2">
                        {CATEGORIES.map(cat => (
                            <button key={cat.id} onClick={() => setNewCategory(cat.id)} className={`py-2 rounded-full text-xs font-bold transition-all text-center ${newCategory === cat.id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}>
                                {cat.icon} {cat.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-4">
                    <div>
                        <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Make</label>
                        <input type="text" value={newMake} onChange={e => setNewMake(e.target.value)} placeholder="Yanmar" className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30" />
                    </div>
                    <div>
                        <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Model</label>
                        <input type="text" value={newModel} onChange={e => setNewModel(e.target.value)} placeholder="4JH4-TE" className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30" />
                    </div>
                </div>

                <div className="mb-4">
                    <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Serial Number</label>
                    <input type="text" value={newSerial} onChange={e => setNewSerial(e.target.value)} placeholder="YNM-4JH4TE-12345" className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white font-mono placeholder-gray-600 outline-none focus:border-sky-500/30" />
                </div>

                <div className="grid grid-cols-2 gap-3 mb-4">
                    <div>
                        <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Install Date</label>
                        <input type="date" value={newInstallDate} onChange={e => setNewInstallDate(e.target.value)} className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30" />
                    </div>
                    <div>
                        <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Warranty Expiry</label>
                        <input type="date" value={newWarrantyExpiry} onChange={e => setNewWarrantyExpiry(e.target.value)} className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30" />
                    </div>
                </div>

                <div className="mb-6">
                    <label className="text-[10px] text-gray-500 font-bold uppercase tracking-widest block mb-1">Notes (Optional)</label>
                    <textarea value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Additional details, service contacts..." rows={2} className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30 resize-none" />
                </div>
            </>
        );
    }

    // ── List View ──
    return (
        <div className="w-full max-w-2xl mx-auto px-4 pt-4 animate-in fade-in duration-300 h-full flex flex-col" style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom, 0px))' }}>

            {/* Header */}
            <div className="flex items-center gap-3 mb-5 shrink-0">
                <button onClick={onBack} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h2 className="text-lg font-black text-white">Equipment Register</h2>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">{items.length} Items Registered</p>
                </div>
            </div>

            {/* Search */}
            <div className="mb-4 shrink-0">
                <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search equipment, make, model, serial..."
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30"
                />
            </div>

            {/* Category filters */}
            <div className="shrink-0 mb-4">
                <div className="grid grid-cols-4 gap-2 pb-1">
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

            {/* Equipment list (scrollable) */}
            <div className="flex-1 overflow-y-auto space-y-2 pb-2 min-h-0">
                {loading ? (
                    <div className="flex items-center justify-center py-12">
                        <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : filteredItems.length === 0 ? (
                    <div className="text-center py-12">
                        <p className="text-gray-500 text-sm font-bold">{searchQuery ? 'No equipment matches' : 'No equipment registered'}</p>
                        <p className="text-gray-600 text-xs mt-1">Tap + to add your first item</p>
                    </div>
                ) : (
                    filteredItems.map(item => (
                        <SwipeableEquipmentCard
                            key={item.id}
                            item={item}
                            onTap={() => {
                                triggerHaptic('light');
                                setSelectedItem(item);
                            }}
                            onDelete={() => handleDelete(item.id)}
                            onCopySerial={() => handleCopySerial(item.serial_number)}
                        />
                    ))
                )}
            </div>

            {/* Add Equipment button (fixed at bottom) */}
            <div className="shrink-0 pt-3 pb-[env(safe-area-inset-bottom,0px)]">
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setNewName(''); setNewCategory('Propulsion'); setNewMake(''); setNewModel('');
                        setNewSerial(''); setNewInstallDate(''); setNewWarrantyExpiry(''); setNewNotes('');
                        setShowAddForm(true);
                    }}
                    className="w-full py-4 bg-gradient-to-r from-emerald-600/20 to-teal-600/20 border border-emerald-500/20 rounded-2xl flex items-center justify-center gap-3 group hover:from-emerald-600/30 hover:to-teal-600/30 transition-all active:scale-[0.98]"
                >
                    <div className="p-2 bg-emerald-500/20 rounded-lg group-hover:bg-emerald-500/30 transition-colors">
                        <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                    </div>
                    <span className="text-sm font-black text-emerald-400 uppercase tracking-[0.15em]">Add Equipment</span>
                </button>
            </div>

            {/* ═══ ADD EQUIPMENT MODAL ═══ */}
            {showAddForm && (
                <div className="fixed inset-0 z-[999] flex items-center justify-center p-4" onClick={() => setShowAddForm(false)}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                    <div
                        className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,24px))] animate-in fade-in zoom-in-95 duration-300 max-h-[85vh] overflow-y-auto"
                        onClick={e => e.stopPropagation()}
                    >
                        <button onClick={() => setShowAddForm(false)} className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10">
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                        <h3 className="text-lg font-black text-white mb-5">Add Equipment</h3>
                        {renderFormFields()}
                        <button
                            onClick={handleAdd}
                            disabled={!newName.trim()}
                            className="w-full py-3.5 bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-black text-sm uppercase tracking-[0.15em] rounded-xl hover:from-emerald-500 hover:to-teal-500 transition-all active:scale-[0.98] disabled:opacity-30"
                        >
                            Register Equipment
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
