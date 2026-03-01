/**
 * InventoryList — Search & management view for ship's inventory.
 *
 * Features:
 * - Full-text search across name, location, description
 * - Horizontal category filter chips
 * - Item cards with quantity, location, and low-stock warnings
 * - Quick scan button to open InventoryScanner
 * - Swipe-to-delete (via button)
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { InventoryItem, InventoryCategory } from '../../types';
import { INVENTORY_CATEGORIES as CATEGORIES, INVENTORY_CATEGORY_ICONS as CATEGORY_ICONS } from '../../types';
import { InventoryService } from '../../services/InventoryService';
import { InventoryScanner } from './InventoryScanner';
import { triggerHaptic } from '../../utils/system';
import { SlideToAction } from '../ui/SlideToAction';
import { Capacitor } from '@capacitor/core';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from '../Toast';
import { useSwipeable } from '../../hooks/useSwipeable';

interface InventoryListProps {
    onBack: () => void;
}

// ── SwipeableInventoryCard ─────────────────────────────────────

interface SwipeableInventoryCardProps {
    item: InventoryItem;
    isExpanded: boolean;
    onTap: () => void;
    onDelete: () => void;
    onEdit: () => void;
    onQuantityAdjust: (id: string, delta: number) => void;
}

const SwipeableInventoryCard: React.FC<SwipeableInventoryCardProps> = ({ item, isExpanded, onTap, onDelete, onEdit, onQuantityAdjust }) => {
    const { swipeOffset, isSwiping, resetSwipe, handlers } = useSwipeable();

    const isLow = item.quantity <= item.min_quantity && item.min_quantity > 0;
    const expiryMs = item.expiry_date ? new Date(item.expiry_date).getTime() : null;
    const now = Date.now();
    const daysUntilExpiry = expiryMs ? Math.ceil((expiryMs - now) / 86_400_000) : null;
    const isExpired = daysUntilExpiry !== null && daysUntilExpiry <= 0;
    const isExpiringSoon = daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry <= 90;

    return (
        <div className="relative overflow-hidden rounded-lg">
            {/* Delete button (revealed on swipe) */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-lg transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => { resetSwipe(); onDelete(); }}
            >
                <div className="text-center text-white">
                    <svg className="w-5 h-5 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    <span className="text-[11px] font-bold">Delete</span>
                </div>
            </div>

            {/* Main card (slides on swipe) */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} bg-slate-800/40 rounded-lg border ${isLow ? 'border-amber-500/20' : 'border-white/5'}`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                {...handlers}
                onClick={() => { if (swipeOffset === 0) onTap(); }}
            >
                {/* Main row */}
                <div className="px-3 py-3">
                    <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-bold text-white truncate">{item.item_name}</h4>
                            {item.location_zone && (
                                <p className="text-[11px] text-gray-500 truncate">
                                    📍 {item.location_zone}{item.location_specific ? ` — ${item.location_specific}` : ''}
                                </p>
                            )}
                            {isExpired && (
                                <p className="text-[11px] font-bold text-red-400 mt-0.5">⚠️ Expired</p>
                            )}
                            {isExpiringSoon && (
                                <p className="text-[11px] font-bold text-amber-400 mt-0.5">⏳ Expires in {daysUntilExpiry}d</p>
                            )}
                        </div>
                        <div className={`px-2.5 py-1 rounded-lg text-center min-w-[3rem] ${isLow ? 'bg-amber-500/20 border border-amber-500/30' : 'bg-white/5'}`}>
                            <p className={`text-sm font-black tabular-nums ${isLow ? 'text-amber-400' : 'text-white'}`}>
                                {item.quantity}
                            </p>
                        </div>
                        {/* 3-dot menu for Edit */}
                        <button
                            onClick={(e) => { e.stopPropagation(); onEdit(); }}
                            className="p-1.5 -mr-1 rounded-lg hover:bg-white/10 transition-colors shrink-0"
                            aria-label="Edit item"
                        >
                            <svg className="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="12" cy="5" r="1.5" />
                                <circle cx="12" cy="12" r="1.5" />
                                <circle cx="12" cy="19" r="1.5" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-white/5 animate-in fade-in duration-200">
                        <div className="grid grid-cols-2 gap-2 text-[11px] mb-3">
                            <div>
                                <span className="text-gray-500">Category</span>
                                <p className="text-white font-bold">{item.category}</p>
                            </div>
                            {item.barcode && (
                                <div>
                                    <span className="text-gray-500">Barcode</span>
                                    <p className="text-white font-mono">{item.barcode}</p>
                                </div>
                            )}
                            {item.description && (
                                <div className="col-span-2">
                                    <span className="text-gray-500">Notes</span>
                                    <p className="text-gray-300">{item.description}</p>
                                </div>
                            )}
                            {item.expiry_date && (
                                <div>
                                    <span className="text-gray-500">Expiry / Service</span>
                                    <p className={`font-bold ${isExpired ? 'text-red-400' : isExpiringSoon ? 'text-amber-400' : 'text-emerald-400'}`}>
                                        {new Date(item.expiry_date).toLocaleDateString()}
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Quantity controls only */}
                        <div className="flex items-center justify-center gap-4 py-2 bg-white/[0.03] border border-white/[0.06] rounded-xl">
                            <button
                                onClick={(e) => { e.stopPropagation(); onQuantityAdjust(item.id, -1); }}
                                disabled={item.quantity <= 0}
                                className="w-9 h-9 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center text-red-400 font-bold hover:bg-red-500/25 transition-all active:scale-90 disabled:opacity-30"
                            >
                                −
                            </button>
                            <span className="text-white font-black text-lg w-8 text-center tabular-nums">{item.quantity}</span>
                            <button
                                onClick={(e) => { e.stopPropagation(); onQuantityAdjust(item.id, 1); }}
                                className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold hover:bg-emerald-500/25 transition-all active:scale-90"
                            >
                                +
                            </button>
                        </div>

                        {isLow && (
                            <p className="text-[11px] text-amber-400 font-bold mt-2">⚠️ Below minimum ({item.min_quantity})</p>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export const InventoryList: React.FC<InventoryListProps> = ({ onBack }) => {
    const [items, setItems] = useState<InventoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [showScanner, setShowScanner] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [stats, setStats] = useState<{ totalItems: number; totalQuantity: number; lowStock: number } | null>(null);

    // ── Load data ──
    const loadItems = useCallback(async () => {
        try {
            const data = await InventoryService.getAll();
            setItems(data);
            const s = await InventoryService.getStats();
            setStats(s);
        } catch (e) { console.warn('[InventoryList] ignore:', e); }
        setLoading(false);
    }, []);

    useEffect(() => { loadItems(); }, [loadItems]);

    // ── Filtered + grouped items ──
    const filtered = useMemo(() => {
        let result = items;

        // Search filter (client-side for instant response)
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            result = result.filter(i =>
                i.item_name.toLowerCase().includes(q) ||
                (i.location_zone || '').toLowerCase().includes(q) ||
                (i.location_specific || '').toLowerCase().includes(q) ||
                (i.description || '').toLowerCase().includes(q) ||
                (i.barcode || '').toLowerCase().includes(q)
            );
        }

        // Sort by category order then alphabetically
        return result.sort((a, b) => {
            const catA = CATEGORIES.indexOf(a.category);
            const catB = CATEGORIES.indexOf(b.category);
            if (catA !== catB) return catA - catB;
            return a.item_name.localeCompare(b.item_name);
        });
    }, [items, searchQuery]);

    // Group by category for rendering
    const groupedItems = useMemo(() =>
        CATEGORIES
            .map(cat => ({ category: cat, items: filtered.filter(i => i.category === cat) }))
            .filter(g => g.items.length > 0),
        [filtered]);

    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

    // ── Delete item ──
    const handleDelete = (id: string) => {
        setDeleteTargetId(id);
    };

    const confirmDelete = async () => {
        if (!deleteTargetId) return;
        triggerHaptic('medium');
        try {
            await InventoryService.delete(deleteTargetId);
            setItems(prev => prev.filter(i => i.id !== deleteTargetId));
            setExpandedId(null);
            toast.success('Item deleted');
        } catch (e) {
            console.warn('[InventoryList] delete failed:', e);
            toast.error('Failed to delete item');
        } finally {
            setDeleteTargetId(null);
        }
    };

    // ── Edit item ──
    const [editItem, setEditItem] = useState<InventoryItem | null>(null);
    const [editName, setEditName] = useState('');
    const [editCategory, setEditCategory] = useState<InventoryCategory>('Provisions');
    const [editQty, setEditQty] = useState(1);
    const [editMinQty, setEditMinQty] = useState(0);
    const [editZone, setEditZone] = useState('');
    const [editSpecific, setEditSpecific] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [editExpiry, setEditExpiry] = useState('');
    const [editBarcode, setEditBarcode] = useState('');

    const openEdit = (item: InventoryItem) => {
        setEditItem(item);
        setEditName(item.item_name);
        setEditCategory(item.category);
        setEditQty(item.quantity);
        setEditMinQty(item.min_quantity);
        setEditZone(item.location_zone || '');
        setEditSpecific(item.location_specific || '');
        setEditDescription(item.description || '');
        setEditExpiry(item.expiry_date || '');
        setEditBarcode(item.barcode || '');
    };

    const handleSaveEdit = async () => {
        if (!editItem || !editName.trim()) return;
        try {
            const updated = await InventoryService.update(editItem.id, {
                item_name: editName,
                category: editCategory,
                quantity: editQty,
                min_quantity: editMinQty,
                barcode: editBarcode || null,
                location_zone: editZone || null,
                location_specific: editSpecific || null,
                description: editDescription || null,
                expiry_date: editExpiry || null,
            });
            setItems(prev => prev.map(i => i.id === editItem.id ? updated : i));
            setEditItem(null);
            triggerHaptic('medium');
            toast.success('Item updated');
        } catch (e) {
            console.warn('[InventoryList] edit failed:', e);
            toast.error('Failed to update item');
        }
    };

    // ── Quick quantity adjustment ──
    const handleQuantityAdjust = async (id: string, delta: number) => {
        triggerHaptic('light');
        try {
            const updated = await InventoryService.adjustQuantity(id, delta);
            setItems(prev => prev.map(i => i.id === id ? updated : i));
        } catch (e) {
            console.warn('[InventoryList] qty adjust failed:', e);
            toast.error('Failed to update quantity');
        }
    };

    if (showScanner) {
        return (
            <InventoryScanner
                onClose={() => setShowScanner(false)}
                onItemSaved={() => { loadItems(); }}
                startInManualMode
            />
        );
    }

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            <div className="flex flex-col h-full">

                <PageHeader
                    title="Inventory"
                    onBack={onBack}
                    breadcrumbs={['Ship\'s Office', 'Inventory']}
                    subtitle={
                        <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">
                            {stats ? `${stats.totalItems} Items · ${stats.totalQuantity} Units` : 'Loading...'}
                            {stats && stats.lowStock > 0 && <span className="text-amber-400"> · {stats.lowStock} Low</span>}
                        </p>
                    }
                />

                {/* ── Search ── */}
                <div className="shrink-0 px-4 pb-3">
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search by name or location..."
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 outline-none focus:border-sky-500/30"
                    />
                </div>



                {/* ── Item List (scrollable, stops above CTA) ── */}
                <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3 no-scrollbar">
                    {loading ? (
                        <div className="space-y-3 px-1">
                            {[1, 2, 3, 4].map(i => (
                                <div key={i} className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4 flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-lg skeleton-shimmer" />
                                    <div className="flex-1 space-y-2">
                                        <div className="h-4 w-1/2 rounded-lg skeleton-shimmer" />
                                        <div className="h-3 w-1/4 rounded-lg skeleton-shimmer" />
                                    </div>
                                    <div className="w-12 h-4 rounded-lg skeleton-shimmer" />
                                </div>
                            ))}
                        </div>
                    ) : groupedItems.length === 0 ? (
                        <EmptyState
                            icon={<svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>}
                            title={searchQuery ? 'No Items Match' : 'No Inventory Yet'}
                            subtitle={searchQuery ? 'Try a different search term.' : 'Slide below to add your first item, or scan a barcode.'}
                            className="py-16"
                        />
                    ) : (
                        groupedItems.map(group => (
                            <div key={group.category}>
                                <div className="flex items-center gap-2 mb-2 mt-1">
                                    <span className="text-sm">{CATEGORY_ICONS[group.category]}</span>
                                    <span className="text-[11px] font-black text-gray-500 uppercase tracking-widest">{group.category}</span>
                                    <span className="text-[10px] text-gray-500 font-bold">({group.items.length})</span>
                                </div>
                                <div className="space-y-2">
                                    {group.items.map(item => (
                                        <SwipeableInventoryCard
                                            key={item.id}
                                            item={item}
                                            isExpanded={expandedId === item.id}
                                            onTap={() => setExpandedId(expandedId === item.id ? null : item.id)}
                                            onDelete={() => handleDelete(item.id)}
                                            onEdit={() => openEdit(item)}
                                            onQuantityAdjust={handleQuantityAdjust}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* ── SlideToAction CTA (8px above menu bar) ── */}
                <div className="shrink-0 px-4 pt-2 bg-slate-950" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
                    <SlideToAction
                        label="Slide to Add Item"
                        thumbIcon={
                            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                            </svg>
                        }
                        onConfirm={() => {
                            triggerHaptic('medium');
                            setShowScanner(true);
                        }}
                        theme="emerald"
                    />
                </div>
            </div>

            {/* ═══ EDIT ITEM MODAL ═══ */}
            {editItem && (
                <div className="fixed inset-0 z-[999] flex items-end justify-center px-4" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }} onClick={() => setEditItem(null)}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                    <div
                        className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-2xl p-4 animate-in fade-in slide-in-from-bottom-4 duration-300 max-h-[80vh] overflow-y-auto no-scrollbar"
                        onClick={e => e.stopPropagation()}
                    >
                        <button onClick={() => setEditItem(null)} className="absolute top-3 right-3 p-1.5 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10">
                            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                        <h3 className="text-base font-black text-white mb-3">Edit Item</h3>

                        <div className="space-y-2">
                            {/* Category — first */}
                            <div>
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Category</label>
                                <div className="grid grid-cols-4 gap-1 mt-0.5">
                                    {CATEGORIES.map(cat => (
                                        <button key={cat} type="button" onClick={() => setEditCategory(cat)}
                                            className={`py-1 rounded-lg text-[11px] font-bold transition-all text-center ${editCategory === cat ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}
                                        >
                                            {CATEGORY_ICONS[cat]} {cat}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Name */}
                            <div>
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Item Name *</label>
                                <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
                                    className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm outline-none focus:border-sky-500 transition-colors" />
                            </div>

                            {/* Barcode */}
                            <div>
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Barcode</label>
                                <div className="flex gap-1.5 mt-0.5">
                                    <input type="text" value={editBarcode} onChange={e => setEditBarcode(e.target.value)}
                                        className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm font-mono outline-none focus:border-sky-500 transition-colors" />
                                    <button
                                        type="button"
                                        onClick={async () => {
                                            if (Capacitor.isNativePlatform()) {
                                                try {
                                                    const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');
                                                    const { camera } = await BarcodeScanner.checkPermissions();
                                                    if (camera !== 'granted') {
                                                        const r = await BarcodeScanner.requestPermissions();
                                                        if (r.camera !== 'granted') return;
                                                    }
                                                    const { barcodes } = await BarcodeScanner.scan({
                                                        formats: [BarcodeFormat.Ean13, BarcodeFormat.Ean8, BarcodeFormat.UpcA, BarcodeFormat.UpcE, BarcodeFormat.Code128, BarcodeFormat.Code39, BarcodeFormat.QrCode],
                                                    });
                                                    if (barcodes.length > 0 && barcodes[0].rawValue) {
                                                        setEditBarcode(barcodes[0].rawValue);
                                                        triggerHaptic('medium');
                                                    }
                                                } catch (e) { console.warn('[InventoryList] cancelled:', e); }
                                            }
                                        }}
                                        className="px-3 flex items-center justify-center bg-sky-600/20 border border-sky-500/30 rounded-xl text-sky-400 hover:bg-sky-600/30 transition-colors active:scale-95"
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            {/* Quantity + Min */}
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Quantity</label>
                                    <input type="number" value={editQty} onChange={e => setEditQty(Math.max(0, parseInt(e.target.value) || 0))}
                                        className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm outline-none focus:border-sky-500 transition-colors" />
                                </div>
                                <div>
                                    <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Min Qty</label>
                                    <input type="number" value={editMinQty} onChange={e => setEditMinQty(Math.max(0, parseInt(e.target.value) || 0))}
                                        className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm outline-none focus:border-sky-500 transition-colors" />
                                </div>
                            </div>

                            {/* Location */}
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Zone</label>
                                    <input type="text" value={editZone} onChange={e => setEditZone(e.target.value)} placeholder="Engine Room"
                                        className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-500" />
                                </div>
                                <div>
                                    <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Specific</label>
                                    <input type="text" value={editSpecific} onChange={e => setEditSpecific(e.target.value)} placeholder="Port locker"
                                        className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-500" />
                                </div>
                            </div>

                            {/* Notes + Expiry side by side */}
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Notes</label>
                                    <input type="text" value={editDescription} onChange={e => setEditDescription(e.target.value)} placeholder="Part no, batch"
                                        className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-500" />
                                </div>
                                <div className="min-w-0 overflow-hidden">
                                    <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Expiry / Service</label>
                                    <input type="date" value={editExpiry} onChange={e => setEditExpiry(e.target.value)}
                                        className="w-full min-w-0 mt-0.5 bg-black/40 border border-white/10 rounded-xl px-2 py-1.5 text-[13px] text-white outline-none focus:border-sky-500 transition-colors [color-scheme:dark]" />
                                </div>
                            </div>
                        </div>

                        {!editName.trim() && (
                            <p className="text-[10px] text-amber-400/80 text-center mt-2">Item name is required</p>
                        )}
                        <button onClick={handleSaveEdit} disabled={!editName.trim()}
                            className="w-full mt-2 py-2.5 bg-gradient-to-r from-sky-600 to-sky-600 text-white font-black text-sm uppercase tracking-[0.15em] rounded-xl hover:from-sky-500 hover:to-sky-500 transition-all active:scale-[0.98] disabled:opacity-30"
                        >
                            Save Changes
                        </button>
                    </div>
                </div>
            )}

            <ConfirmDialog
                isOpen={!!deleteTargetId}
                title="Delete Item?"
                message="This will permanently remove this item from your inventory."
                confirmLabel="Delete"
                destructive
                onConfirm={confirmDelete}
                onCancel={() => setDeleteTargetId(null)}
            />
        </div>
    );
};
