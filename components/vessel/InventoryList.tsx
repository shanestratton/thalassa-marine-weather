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
import { InventoryService } from '../../services/InventoryService';
import { InventoryScanner } from './InventoryScanner';
import { triggerHaptic } from '../../utils/system';

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
            />
        );
    }

    return (
        <div className="w-full max-w-2xl mx-auto px-4 pb-24 animate-in fade-in duration-300">
            {/* Header */}
            <div className="sticky top-0 z-20 bg-black pt-[max(1rem,env(safe-area-inset-top))] pb-3">
                <div className="flex items-center gap-3 mb-4">
                    <button onClick={onBack} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                        <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <div className="flex-1">
                        <h1 className="text-xl font-black text-white tracking-wide">Inventory</h1>
                        {stats && (
                            <p className="text-[10px] text-gray-500">
                                {stats.totalItems} items • {stats.totalQuantity} total units
                                {stats.lowStock > 0 && <span className="text-amber-400"> • {stats.lowStock} low stock</span>}
                            </p>
                        )}
                    </div>
                    <button
                        onClick={() => setShowScanner(true)}
                        className="py-2.5 px-4 bg-gradient-to-r from-sky-600 to-cyan-600 text-white rounded-xl text-xs font-black uppercase tracking-wider shadow-lg shadow-sky-500/20 active:scale-95 transition-transform"
                    >
                        📷 Scan
                    </button>
                </div>

                {/* Search bar */}
                <div className="relative mb-3">
                    <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                    </svg>
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search by name or location…"
                        className="w-full bg-white/[0.05] border border-white/10 rounded-xl pl-10 pr-4 py-3 text-white text-sm outline-none focus:border-sky-500 transition-colors placeholder:text-gray-600"
                    />
                    {searchQuery && (
                        <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    )}
                </div>

                {/* Category filter chips */}
                <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                    <button
                        onClick={() => setActiveCategory(null)}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider whitespace-nowrap transition-all flex-shrink-0 ${!activeCategory ? 'bg-sky-600 text-white' : 'bg-white/5 text-gray-400 hover:bg-white/10'
                            }`}
                    >
                        All ({items.length})
                    </button>
                    {CATEGORIES.map(cat => {
                        const count = items.filter(i => i.category === cat).length;
                        if (count === 0) return null;
                        return (
                            <button
                                key={cat}
                                onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
                                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider whitespace-nowrap transition-all flex-shrink-0 ${activeCategory === cat ? 'bg-sky-600 text-white' : 'bg-white/5 text-gray-400 hover:bg-white/10'
                                    }`}
                            >
                                {CATEGORY_ICONS[cat]} {cat} ({count})
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ── Item List ── */}
            {loading ? (
                <div className="flex items-center justify-center py-20">
                    <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                </div>
            ) : filtered.length === 0 ? (
                <div className="text-center py-20">
                    <p className="text-3xl mb-3">{searchQuery ? '🔍' : '📦'}</p>
                    <p className="text-sm font-bold text-gray-400 mb-1">
                        {searchQuery ? 'No items match your search' : 'No inventory items yet'}
                    </p>
                    <p className="text-xs text-gray-600 mb-4">
                        {searchQuery ? 'Try a different search term' : 'Scan a barcode or add items manually'}
                    </p>
                    {!searchQuery && (
                        <button
                            onClick={() => setShowScanner(true)}
                            className="px-6 py-3 bg-sky-600 text-white rounded-xl text-sm font-bold"
                        >
                            📷 Scan First Item
                        </button>
                    )}
                </div>
            ) : (
                <div className="space-y-2 mt-2">
                    {filtered.map(item => {
                        const isLow = item.quantity <= item.min_quantity && item.min_quantity > 0;
                        const isExpanded = expandedId === item.id;

                        return (
                            <div
                                key={item.id}
                                className={`bg-white/[0.03] border rounded-2xl overflow-hidden transition-all ${isLow ? 'border-amber-500/20' : 'border-white/[0.06]'
                                    }`}
                            >
                                {/* Main row */}
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                                    className="w-full px-4 py-3.5 flex items-center gap-3 text-left"
                                >
                                    {/* Category icon */}
                                    <span className="text-lg flex-shrink-0">{CATEGORY_ICONS[item.category]}</span>

                                    {/* Item info */}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-bold text-white truncate">{item.item_name}</p>
                                        {item.location_zone && (
                                            <p className="text-[10px] text-gray-500 truncate">
                                                📍 {item.location_zone}{item.location_specific ? ` — ${item.location_specific}` : ''}
                                            </p>
                                        )}
                                    </div>

                                    {/* Quantity badge */}
                                    <div className={`px-2.5 py-1 rounded-lg text-center min-w-[3rem] ${isLow ? 'bg-amber-500/20 border border-amber-500/30' : 'bg-white/5'
                                        }`}>
                                        <p className={`text-sm font-black tabular-nums ${isLow ? 'text-amber-400' : 'text-white'}`}>
                                            {item.quantity}
                                        </p>
                                    </div>

                                    {/* Expand chevron */}
                                    <svg className={`w-4 h-4 text-gray-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                                    </svg>
                                </button>

                                {/* Expanded detail */}
                                {isExpanded && (
                                    <div className="px-4 pb-4 pt-1 border-t border-white/5 animate-in fade-in duration-200">
                                        <div className="grid grid-cols-2 gap-2 text-[10px] mb-3">
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
                                        </div>

                                        {/* Quick quantity controls */}
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
                                                onClick={() => handleDelete(item.id)}
                                                className="px-3 py-2 rounded-xl bg-red-500/10 text-red-400 text-[10px] font-bold uppercase tracking-wider hover:bg-red-500/20 transition-all"
                                            >
                                                Delete
                                            </button>
                                        </div>

                                        {isLow && (
                                            <p className="text-[10px] text-amber-400 font-bold mt-2">⚠️ Below minimum ({item.min_quantity})</p>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
