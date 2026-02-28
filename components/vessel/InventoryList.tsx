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
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { InventoryItem, InventoryCategory } from '../../types';
import { InventoryService } from '../../services/InventoryService';
import { InventoryScanner } from './InventoryScanner';
import { triggerHaptic } from '../../utils/system';
import { SlideToAction } from '../ui/SlideToAction';
import { Capacitor } from '@capacitor/core';
import { PageHeader } from '../ui/PageHeader';

interface InventoryListProps {
    onBack: () => void;
}

const CATEGORIES: InventoryCategory[] = ['Engine', 'Plumbing', 'Electrical', 'Rigging', 'Safety', 'Provisions', 'Medical'];

const CATEGORY_ICONS: Record<InventoryCategory, string> = {
    Engine: '⚙️',
    Plumbing: '🔧',
    Electrical: '⚡',
    Rigging: '⛵',
    Safety: '🛟',
    Provisions: '🥫',
    Medical: '🏥',
};

export const InventoryList: React.FC<InventoryListProps> = ({ onBack }) => {
    const [items, setItems] = useState<InventoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [activeCategory, setActiveCategory] = useState<InventoryCategory | null>(null);
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
        } catch { /* ignore */ }
        setLoading(false);
    }, []);

    useEffect(() => { loadItems(); }, [loadItems]);

    // ── Filtered items ──
    const filtered = useMemo(() => {
        let result = items;

        // Category filter
        if (activeCategory) {
            result = result.filter(i => i.category === activeCategory);
        }

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

        return result;
    }, [items, activeCategory, searchQuery]);

    // ── Delete item ──
    const handleDelete = async (id: string) => {
        triggerHaptic('medium');
        try {
            await InventoryService.delete(id);
            setItems(prev => prev.filter(i => i.id !== id));
            setExpandedId(null);
        } catch { /* ignore */ }
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
        } catch { /* ignore */ }
    };

    // ── Quick quantity adjustment ──
    const handleQuantityAdjust = async (id: string, delta: number) => {
        triggerHaptic('light');
        try {
            const updated = await InventoryService.adjustQuantity(id, delta);
            setItems(prev => prev.map(i => i.id === id ? updated : i));
        } catch { /* ignore */ }
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
                        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30"
                    />
                </div>

                {/* ── Category filters ── */}
                <div className="shrink-0 px-4 pb-3">
                    <div className="grid grid-cols-4 gap-2">
                        <button
                            onClick={() => setActiveCategory(null)}
                            className={`py-2 rounded-full text-xs font-bold transition-all text-center ${!activeCategory ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}
                        >
                            All
                        </button>
                        {CATEGORIES.map(cat => {
                            const count = items.filter(i => i.category === cat).length;
                            if (count === 0) return null;
                            return (
                                <button
                                    key={cat}
                                    onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
                                    className={`py-2 rounded-full text-xs font-bold transition-all text-center ${activeCategory === cat ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-white/5 text-gray-500 border border-white/5'}`}
                                >
                                    {CATEGORY_ICONS[cat]} {cat}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* ── Item List (scrollable, stops above CTA) ── */}
                <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3 no-scrollbar">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
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
                                {searchQuery ? 'No Items Match' : 'No Inventory Yet'}
                            </p>
                            <p className="text-sm text-white/50 max-w-[240px] text-center">
                                {searchQuery ? 'Try a different search term.' : 'Slide below to add your first item, or scan a barcode.'}
                            </p>
                        </div>
                    ) : (
                        filtered.map(item => {
                            const isLow = item.quantity <= item.min_quantity && item.min_quantity > 0;
                            const isExpanded = expandedId === item.id;
                            const expiryMs = item.expiry_date ? new Date(item.expiry_date).getTime() : null;
                            const now = Date.now();
                            const daysUntilExpiry = expiryMs ? Math.ceil((expiryMs - now) / 86_400_000) : null;
                            const isExpired = daysUntilExpiry !== null && daysUntilExpiry <= 0;
                            const isExpiringSoon = daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry <= 90;

                            return (
                                <div
                                    key={item.id}
                                    className={`bg-slate-800/40 border rounded-lg overflow-hidden transition-all ${isLow ? 'border-amber-500/20' : 'border-white/5'}`}
                                >
                                    {/* Main row */}
                                    <button
                                        onClick={() => setExpandedId(isExpanded ? null : item.id)}
                                        className="w-full px-3 py-3 flex items-center gap-3 text-left"
                                    >
                                        <span className="text-xs shrink-0">{CATEGORY_ICONS[item.category]}</span>
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
                                        <svg className={`w-4 h-4 text-gray-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                                        </svg>
                                    </button>

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

                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => handleQuantityAdjust(item.id, -1)}
                                                        disabled={item.quantity <= 0}
                                                        className="w-9 h-9 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center text-red-400 font-bold hover:bg-red-500/25 transition-all active:scale-90 disabled:opacity-30"
                                                    >
                                                        −
                                                    </button>
                                                    <span className="text-white font-black text-lg w-8 text-center tabular-nums">{item.quantity}</span>
                                                    <button
                                                        onClick={() => handleQuantityAdjust(item.id, 1)}
                                                        className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold hover:bg-emerald-500/25 transition-all active:scale-90"
                                                    >
                                                        +
                                                    </button>
                                                </div>
                                                <button
                                                    onClick={() => openEdit(item)}
                                                    className="flex-1 py-2 rounded-xl bg-sky-500/10 text-sky-400 text-[11px] font-bold uppercase tracking-wider hover:bg-sky-500/20 transition-all text-center"
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(item.id)}
                                                    className="flex-1 py-2 rounded-xl bg-red-500/10 text-red-400 text-[11px] font-bold uppercase tracking-wider hover:bg-red-500/20 transition-all text-center"
                                                >
                                                    Delete
                                                </button>
                                            </div>

                                            {isLow && (
                                                <p className="text-[11px] text-amber-400 font-bold mt-2">⚠️ Below minimum ({item.min_quantity})</p>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })
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
                                                } catch { /* cancelled */ }
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

                            {/* Category */}
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
                                        className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600" />
                                </div>
                                <div>
                                    <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Specific</label>
                                    <input type="text" value={editSpecific} onChange={e => setEditSpecific(e.target.value)} placeholder="Port locker"
                                        className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600" />
                                </div>
                            </div>

                            {/* Notes + Expiry side by side */}
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Notes</label>
                                    <input type="text" value={editDescription} onChange={e => setEditDescription(e.target.value)} placeholder="Part no, batch"
                                        className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600" />
                                </div>
                                <div>
                                    <label className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Expiry / Service</label>
                                    <input type="date" value={editExpiry} onChange={e => setEditExpiry(e.target.value)}
                                        className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-white text-sm outline-none focus:border-sky-500 transition-colors" />
                                </div>
                            </div>
                        </div>

                        <button onClick={handleSaveEdit} disabled={!editName.trim()}
                            className="w-full mt-3 py-2.5 bg-gradient-to-r from-sky-600 to-sky-600 text-white font-black text-sm uppercase tracking-[0.15em] rounded-xl hover:from-sky-500 hover:to-sky-500 transition-all active:scale-[0.98] disabled:opacity-30"
                        >
                            Save Changes
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
