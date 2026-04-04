/**
 * EquipmentList — Searchable Equipment Register with category filters.
 *
 * Sub-components extracted to ./equipment/:
 *   - SwipeableEquipmentCard: swipe-to-delete card with warranty status
 *   - EquipmentDetail: full detail view with specs and warranty
 */
import React, { useState, useEffect, useCallback } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('EquipmentList');
import { createPortal } from 'react-dom';
import type { EquipmentItem, EquipmentCategory } from '../../types';
import { LocalEquipmentService } from '../../services/vessel/LocalEquipmentService';
import { triggerHaptic } from '../../utils/system';
import { SlideToAction } from '../ui/SlideToAction';
import { exportEquipmentPdf } from '../../utils/equipmentPdfExport';
import { PageHeader } from '../ui/PageHeader';
import { ModalSheet } from '../ui/ModalSheet';
import { toast } from '../Toast';
import { UndoToast } from '../ui/UndoToast';
import { EmptyState } from '../ui/EmptyState';
import { ShimmerBlock } from '../ui/ShimmerBlock';
import { OfflineBadge } from '../ui/OfflineBadge';
import { FormField } from '../ui/FormField';
import { useRealtimeSync } from '../../hooks/useRealtimeSync';
import { useSuccessFlash } from '../../hooks/useSuccessFlash';
import { SwipeableEquipmentCard, CATEGORIES, CATEGORY_ICONS } from './equipment/SwipeableEquipmentCard';
import { EquipmentDetail } from './equipment/EquipmentDetail';

interface EquipmentListProps {
    onBack: () => void;
}

// SwipeableEquipmentCard, EquipmentDetail, CATEGORIES, CATEGORY_ICONS — now in ./equipment/

// ── Main Component ────────────────────────────────────────────

export const EquipmentList: React.FC<EquipmentListProps> = ({ onBack }) => {
    const [items, setItems] = useState<EquipmentItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
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

    // Context menu bottom sheet state
    const [contextItem, setContextItem] = useState<EquipmentItem | null>(null);

    // 3-dot menu state
    const [menuOpen, setMenuOpen] = useState(false);

    // ── Load ──
    const loadItems = useCallback(() => {
        setLoading(true);
        try {
            setItems(LocalEquipmentService.getAll());
        } catch (e) {
            log.error('Failed to load equipment:', e);
            toast.error('Failed to load equipment');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadItems();
    }, [loadItems]);

    // Realtime sync — crew edits appear instantly
    useRealtimeSync('equipment_register', loadItems);

    const { ref: listRef, flash } = useSuccessFlash();

    // ── Filtered + grouped items ──
    const CATEGORY_ORDER: EquipmentCategory[] = ['Propulsion', 'Electronics', 'HVAC', 'Plumbing', 'Rigging', 'Galley'];

    const filteredItems = items
        .filter((i) => {
            if (!searchQuery.trim()) return true;
            const q = searchQuery.toLowerCase();
            return (
                i.equipment_name.toLowerCase().includes(q) ||
                i.make.toLowerCase().includes(q) ||
                i.model.toLowerCase().includes(q) ||
                i.serial_number.toLowerCase().includes(q)
            );
        })
        .sort((a, b) => {
            const catA = CATEGORY_ORDER.indexOf(a.category);
            const catB = CATEGORY_ORDER.indexOf(b.category);
            if (catA !== catB) return catA - catB;
            return a.equipment_name.localeCompare(b.equipment_name);
        });

    // Group by category for rendering
    const groupedItems = CATEGORY_ORDER.map((cat) => ({
        category: cat,
        items: filteredItems.filter((i) => i.category === cat),
    })).filter((g) => g.items.length > 0);

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
            setNewName('');
            setNewMake('');
            setNewModel('');
            setNewSerial('');
            setNewInstallDate('');
            setNewWarrantyExpiry('');
            setNewNotes('');
            loadItems();
            toast.success('Equipment registered');
            flash();
        } catch (e) {
            log.error('Failed to add equipment:', e);
            toast.error('Failed to add equipment');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [newName, newCategory, newMake, newModel, newSerial, newInstallDate, newWarrantyExpiry, newNotes, loadItems]);

    const [deletedItem, setDeletedItem] = useState<EquipmentItem | null>(null);
    const deleteTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleDelete = useCallback(
        (id: string) => {
            const item = items.find((i) => i.id === id);
            if (!item) return;
            triggerHaptic('medium');
            // Remove from UI immediately
            setItems((prev) => prev.filter((i) => i.id !== id));
            setSelectedItem(null);
            setContextItem(null);
            setDeletedItem(item);

            // Schedule actual delete after 5s
            if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
            deleteTimerRef.current = setTimeout(async () => {
                try {
                    await LocalEquipmentService.delete(id);
                } catch (e) {
                    log.warn(' delete failed:', e);
                    toast.error('Failed to delete equipment');
                    setItems((prev) => [...prev, item]);
                }
                setDeletedItem(null);
            }, 5000);
        },
        [items],
    );

    const handleUndoDelete = useCallback(() => {
        if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
        if (deletedItem) {
            setItems((prev) => [...prev, deletedItem]);
            toast.success('Equipment restored');
        }
        setDeletedItem(null);
    }, [deletedItem]);

    const handleCopySerial = (serial: string) => {
        navigator.clipboard
            .writeText(serial)
            .then(() => {
                triggerHaptic('light');
            })
            .catch((e) => {
                log.warn(`[EquipmentList]`, e);
            });
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
            setSelectedItem((prev) =>
                prev
                    ? {
                          ...prev,
                          equipment_name: newName.trim(),
                          category: newCategory,
                          make: newMake.trim(),
                          model: newModel.trim(),
                          serial_number: newSerial.trim(),
                          installation_date: newInstallDate || null,
                          warranty_expiry: newWarrantyExpiry || null,
                          notes: newNotes.trim() || null,
                      }
                    : null,
            );
            toast.success('Equipment updated');
            flash();
        } catch (e) {
            log.error('Failed to update equipment:', e);
            toast.error('Failed to update equipment');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        selectedItem,
        newName,
        newCategory,
        newMake,
        newModel,
        newSerial,
        newInstallDate,
        newWarrantyExpiry,
        newNotes,
        loadItems,
    ]);

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
                    <ModalSheet isOpen={true} onClose={() => setShowEditForm(false)} title="Edit Equipment">
                        {renderFormFields()}
                        <button
                            aria-label="Save equipment changes"
                            onClick={handleSaveEdit}
                            className="w-full py-3.5 bg-gradient-to-r from-sky-600 to-sky-600 text-white font-black text-sm uppercase tracking-[0.15em] rounded-xl hover:from-sky-500 hover:to-sky-500 transition-all active:scale-[0.98]"
                        >
                            Save Changes
                        </button>
                    </ModalSheet>
                )}
            </>
        );
    }

    function renderFormFields() {
        return (
            <div className="flex-1 min-h-0 flex flex-col gap-2 overflow-y-auto">
                <div>
                    <label className="text-micro text-gray-400 font-bold uppercase tracking-wider block mb-1">
                        Category
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                        {CATEGORIES.map((cat) => (
                            <button
                                aria-label="Select equipment category"
                                key={cat.id}
                                onClick={() => setNewCategory(cat.id)}
                                className={`py-1 rounded-full text-label font-bold transition-all text-center ${newCategory === cat.id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-400 border border-white/5'}`}
                            >
                                {cat.icon} {cat.label}
                            </button>
                        ))}
                    </div>
                </div>

                <FormField
                    label="Equipment Name"
                    value={newName}
                    onChange={setNewName}
                    placeholder="Main Engine"
                    required
                />

                <div className="grid grid-cols-2 gap-2">
                    <FormField label="Make" value={newMake} onChange={setNewMake} placeholder="Yanmar" />
                    <FormField label="Model" value={newModel} onChange={setNewModel} placeholder="4JH4-TE" />
                </div>

                <FormField
                    label="Serial Number"
                    value={newSerial}
                    onChange={setNewSerial}
                    placeholder="YNM-4JH4TE-12345"
                    mono
                />

                <div className="grid grid-cols-2 gap-2">
                    <FormField label="Install Date" type="date" value={newInstallDate} onChange={setNewInstallDate} />
                    <FormField
                        label="Warranty Expiry"
                        type="date"
                        value={newWarrantyExpiry}
                        onChange={setNewWarrantyExpiry}
                    />
                </div>

                <FormField
                    label="Notes (Optional)"
                    type="textarea"
                    value={newNotes}
                    onChange={setNewNotes}
                    placeholder="Additional details..."
                    rows={1}
                />
            </div>
        );
    }

    // ── List View ──
    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Equipment Register"
                    subtitle={`${items.length} Items Registered`}
                    onBack={onBack}
                    breadcrumbs={["Ship's Office", 'Equipment']}
                    status={<OfflineBadge />}
                    action={
                        items.length > 0 ? (
                            <div className="relative">
                                <button
                                    onClick={() => setMenuOpen(!menuOpen)}
                                    className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                                    aria-label="More options"
                                >
                                    <svg
                                        className="w-5 h-5 text-gray-400"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z"
                                        />
                                    </svg>
                                </button>
                                {menuOpen && (
                                    <>
                                        <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                                        <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                            <button
                                                aria-label="Export equipment register as PDF"
                                                onClick={() => {
                                                    exportEquipmentPdf(items);
                                                    setMenuOpen(false);
                                                }}
                                                className="w-full text-left px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors flex items-center gap-3"
                                            >
                                                <svg
                                                    className="w-4 h-4 text-gray-400"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={1.5}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18.25 7.034H5.75"
                                                    />
                                                </svg>
                                                Export to PDF
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        ) : undefined
                    }
                />

                {/* ── Search ── */}
                <div className="shrink-0 px-4 pb-3">
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search equipment, make, model, serial..."
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 outline-none focus:border-sky-500/30"
                    />
                </div>

                {/* ── Equipment list (scrollable) ── */}
                <div ref={listRef} className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3">
                    {loading ? (
                        <div className="space-y-3 px-1">
                            <ShimmerBlock variant="list" rows={4} />
                        </div>
                    ) : groupedItems.length === 0 ? (
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
                                        d="M11.42 15.17l-5.1-5.1a7 7 0 119.9 0l-5.1 5.1a.5.5 0 01-.7 0zM12 7v4m0 0h.01"
                                    />
                                </svg>
                            }
                            title={searchQuery ? 'No Equipment Matches' : 'No Equipment Registered'}
                            subtitle={
                                searchQuery
                                    ? 'Try a different search term.'
                                    : 'Slide below to register your first item.'
                            }
                            className="py-16"
                        />
                    ) : (
                        groupedItems.map((group) => {
                            const catConfig = CATEGORIES.find((c) => c.id === group.category);
                            return (
                                <div key={group.category}>
                                    <div className="flex items-center gap-2 mb-2 mt-1">
                                        <span className="text-sm">{catConfig?.icon}</span>
                                        <span className="text-label font-black text-gray-400 uppercase tracking-widest">
                                            {catConfig?.label}
                                        </span>
                                        <span className="text-micro text-gray-400 font-bold">
                                            ({group.items.length})
                                        </span>
                                    </div>
                                    <div className="space-y-2">
                                        {group.items.map((item) => (
                                            <SwipeableEquipmentCard
                                                key={item.id}
                                                item={item}
                                                onTap={() => {
                                                    triggerHaptic('light');
                                                    setSelectedItem(item);
                                                }}
                                                onDelete={() => handleDelete(item.id)}
                                                onContextMenu={() => {
                                                    triggerHaptic('light');
                                                    setContextItem(item);
                                                }}
                                            />
                                        ))}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                {/* ── SlideToAction CTA (fixed at bottom) ── */}
                <div
                    className="shrink-0 px-4 pt-2 bg-slate-950"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    <SlideToAction
                        label="Slide to Add Equipment"
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
                            setNewName('');
                            setNewCategory('Propulsion');
                            setNewMake('');
                            setNewModel('');
                            setNewSerial('');
                            setNewInstallDate('');
                            setNewWarrantyExpiry('');
                            setNewNotes('');
                            setShowAddForm(true);
                        }}
                        theme="sky"
                    />
                </div>
            </div>

            {/* ═══ CONTEXT MENU BOTTOM SHEET ═══ */}
            {contextItem &&
                createPortal(
                    <div
                        className="fixed inset-0 z-[999] flex items-center justify-center px-3"
                        onClick={() => setContextItem(null)}
                    >
                        <div className="absolute inset-0 bg-black/60" />
                        <div
                            className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-2xl p-5 animate-in fade-in zoom-in-95 duration-300 overflow-y-auto"
                            style={{ maxHeight: 'calc(100dvh - 12rem)' }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* Close X */}
                            <button
                                onClick={() => setContextItem(null)}
                                className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
                                aria-label="Close context menu"
                            >
                                <svg
                                    className="w-5 h-5 text-gray-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>

                            {/* Item header */}
                            <div className="flex items-center gap-3 mb-5">
                                <span className="text-lg">{CATEGORY_ICONS[contextItem.category] || '📋'}</span>
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-lg font-black text-white truncate">
                                        {contextItem.equipment_name}
                                    </h3>
                                    <p className="text-xs text-slate-400 font-bold">
                                        {contextItem.make} — {contextItem.model}
                                    </p>
                                </div>
                            </div>

                            {/* Action buttons */}
                            <div className="space-y-2">
                                {/* View Details */}
                                <button
                                    aria-label="View equipment details"
                                    onClick={() => {
                                        setSelectedItem(contextItem);
                                        setContextItem(null);
                                    }}
                                    className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors active:scale-[0.98]"
                                >
                                    <svg
                                        className="w-5 h-5 text-sky-400 shrink-0"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                                        />
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                                        />
                                    </svg>
                                    <span className="text-sm font-bold text-white">View Details</span>
                                </button>

                                {/* Copy Serial */}
                                {contextItem.serial_number && (
                                    <button
                                        aria-label="Copy serial number to clipboard"
                                        onClick={() => {
                                            handleCopySerial(contextItem.serial_number);
                                            setContextItem(null);
                                        }}
                                        className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors active:scale-[0.98]"
                                    >
                                        <svg
                                            className="w-5 h-5 text-sky-400 shrink-0"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={2}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                                            />
                                        </svg>
                                        <div className="flex-1 text-left">
                                            <span className="text-sm font-bold text-white">Copy Serial Number</span>
                                            <p className="text-label text-slate-400 font-mono mt-0.5">
                                                {contextItem.serial_number}
                                            </p>
                                        </div>
                                    </button>
                                )}

                                {/* Open Manual */}
                                {contextItem.manual_uri && (
                                    <button
                                        aria-label="Open equipment manual PDF"
                                        onClick={() => {
                                            window.open(contextItem.manual_uri!, '_blank');
                                            setContextItem(null);
                                        }}
                                        className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors active:scale-[0.98]"
                                    >
                                        <svg
                                            className="w-5 h-5 text-sky-400 shrink-0"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={2}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                                            />
                                        </svg>
                                        <span className="text-sm font-bold text-white">Open Manual (PDF)</span>
                                    </button>
                                )}

                                {/* Edit */}
                                <button
                                    aria-label="Edit equipment details"
                                    onClick={() => {
                                        openEditForm(contextItem);
                                        setSelectedItem(contextItem);
                                        setContextItem(null);
                                    }}
                                    className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-sky-500/10 border border-sky-500/20 hover:bg-sky-500/20 transition-colors active:scale-[0.98]"
                                >
                                    <svg
                                        className="w-5 h-5 text-sky-400 shrink-0"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                        />
                                    </svg>
                                    <span className="text-sm font-bold text-sky-400">Edit Equipment</span>
                                </button>

                                {/* Delete */}
                                <button
                                    aria-label="Delete this equipment item"
                                    onClick={() => {
                                        handleDelete(contextItem.id);
                                    }}
                                    className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 transition-colors active:scale-[0.98]"
                                >
                                    <svg
                                        className="w-5 h-5 text-red-400 shrink-0"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                        />
                                    </svg>
                                    <span className="text-sm font-bold text-red-400">Delete Equipment</span>
                                </button>
                            </div>
                        </div>
                    </div>,
                    document.body,
                )}

            {/* ═══ ADD EQUIPMENT MODAL ═══ */}
            {showAddForm && (
                <ModalSheet isOpen={true} onClose={() => setShowAddForm(false)} title="Add Equipment">
                    {renderFormFields()}
                    {!newName.trim() && (
                        <p className="text-micro text-amber-400/80 text-center mt-2">Equipment name is required</p>
                    )}
                    <button
                        aria-label="Register new equipment"
                        onClick={handleAdd}
                        disabled={!newName.trim()}
                        className="w-full py-3 mt-2 bg-gradient-to-r from-emerald-600 to-emerald-600 text-white font-black text-sm uppercase tracking-[0.15em] rounded-xl hover:from-emerald-500 hover:to-emerald-500 transition-all active:scale-[0.98] disabled:opacity-30 shrink-0"
                    >
                        Register Equipment
                    </button>
                </ModalSheet>
            )}

            <UndoToast
                isOpen={!!deletedItem}
                message={`"${deletedItem?.equipment_name}" deleted`}
                onUndo={handleUndoDelete}
                onDismiss={() => setDeletedItem(null)}
            />
        </div>
    );
};
