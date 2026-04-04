/**
 * GroceryListPage — Full-page shopping list accessible from Ship's Office.
 *
 * Shows all shopping items grouped by Market Zone (🥩 Butcher, 🥬 Produce, etc.)
 * Tap to mark as purchased → auto-inserts into Ship's Stores + immediate sync.
 * Price tracking for voyage budget.
 *
 * "Check off items as you walk the aisles — your crew sees updates instantly."
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    getShoppingList,
    markPurchased,
    unmarkPurchased,
    addManualItem,
    getVoyageBudget,
    type ShoppingItem,
    type ShoppingListSummary,
    type MarketZone,
} from '../../services/ShoppingListService';
import { toPurchasable } from '../../services/PurchaseUnits';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { useRealtimeSync } from '../../hooks/useRealtimeSync';
import { getCachedActiveVoyage } from '../../services/VoyageService';

import { ZONE_EMOJI } from '../chat/galleyTokens';

interface GroceryListPageProps {
    onBack: () => void;
}

const ALL_ZONES: MarketZone[] = [
    'General',
    'Produce',
    'Butcher',
    'Dairy',
    'Bakery',
    'Bottle Shop',
    'Pharmacy',
    'Chandlery',
    'Fuel Dock',
];

export const GroceryListPage: React.FC<GroceryListPageProps> = ({ onBack }) => {
    const [summary, setSummary] = useState<ShoppingListSummary | null>(null);
    const [filter, setFilter] = useState<'all' | 'remaining' | 'purchased'>('remaining');
    const [purchasingId, setPurchasingId] = useState<string | null>(null);

    // Price input modal state
    const [priceItem, setPriceItem] = useState<ShoppingItem | null>(null);
    const [priceValue, setPriceValue] = useState('');
    const [storeName, setStoreName] = useState('');
    const priceInputRef = useRef<HTMLInputElement>(null);

    // Budget summary
    const [budget, setBudget] = useState<{ total: number; byZone: Record<string, number> } | null>(null);

    const loadList = useCallback(() => {
        const s = getShoppingList();
        setSummary(s);
        // Load budget
        try {
            const voyage = getCachedActiveVoyage();
            if (voyage) {
                const b = getVoyageBudget(voyage.id);
                const byZoneMap: Record<string, number> = {};
                for (const z of b.byZone) byZoneMap[z.zone] = z.spent;
                setBudget({ total: b.totalSpent, byZone: byZoneMap });
            }
        } catch (e) {
            console.warn('Suppressed:', e);
        }
    }, []);

    useEffect(() => {
        loadList();
    }, [loadList]);

    // Realtime sync — crew purchase updates appear instantly
    useRealtimeSync('shopping_list', loadList);

    // Filtered items
    const filteredZones = useMemo(() => {
        if (!summary) return [];
        return summary.zones
            .map((z) => ({
                ...z,
                items: z.items.filter((i) => {
                    if (filter === 'remaining') return !i.purchased;
                    if (filter === 'purchased') return i.purchased;
                    return true;
                }),
            }))
            .filter((z) => z.items.length > 0);
    }, [summary, filter]);

    // Open price prompt instead of immediately marking purchased
    const handleCheckbox = useCallback((item: ShoppingItem) => {
        if (item.purchased) return;
        setPriceItem(item);
        setPriceValue('');
        setStoreName('');
        // Focus the input after render
        setTimeout(() => priceInputRef.current?.focus(), 150);
    }, []);

    // Confirm purchase with optional price + store
    const handleConfirmPurchase = useCallback(async () => {
        if (!priceItem) return;
        setPurchasingId(priceItem.id);
        triggerHaptic('medium');
        const cost = priceValue ? parseFloat(priceValue) : undefined;
        const store = storeName.trim() || undefined;
        await markPurchased(priceItem.id, cost, store);
        setPurchasingId(null);
        setPriceItem(null);
        setPriceValue('');
        setStoreName('');
        loadList();
    }, [priceItem, priceValue, storeName, loadList]);

    // Skip price → just mark purchased
    const handleSkipPrice = useCallback(async () => {
        if (!priceItem) return;
        setPurchasingId(priceItem.id);
        triggerHaptic('medium');
        await markPurchased(priceItem.id);
        setPurchasingId(null);
        setPriceItem(null);
        setPriceValue('');
        setStoreName('');
        loadList();
    }, [priceItem, loadList]);

    // Untick — revert a purchased item back to "needs buying"
    const handleUntick = useCallback(
        async (item: ShoppingItem) => {
            setPurchasingId(item.id);
            triggerHaptic('light');
            await unmarkPurchased(item.id);
            setPurchasingId(null);
            loadList();
        },
        [loadList],
    );

    // ── Add manual item state ──
    const [showAddForm, setShowAddForm] = useState(false);
    const [addName, setAddName] = useState('');
    const [addQty, setAddQty] = useState('1');
    const [addUnit, setAddUnit] = useState('each');
    const [addZone, setAddZone] = useState<MarketZone>('General');
    const addNameRef = useRef<HTMLInputElement>(null);

    const handleAddItem = useCallback(async () => {
        if (!addName.trim()) return;
        await addManualItem({
            name: addName.trim(),
            qty: parseFloat(addQty) || 1,
            unit: addUnit || 'each',
            zone: addZone,
        });
        setShowAddForm(false);
        setAddName('');
        setAddQty('1');
        setAddUnit('each');
        setAddZone('General');
        loadList();
    }, [addName, addQty, addUnit, addZone, loadList]);

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Grocery List"
                    onBack={onBack}
                    breadcrumbs={["Ship's Office", 'Grocery List']}
                    subtitle={
                        summary ? (
                            <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
                                {summary.remaining} remaining · {summary.purchased} purchased
                                {summary.totalCost > 0 && (
                                    <span className="text-emerald-400"> · ${summary.totalCost.toFixed(2)}</span>
                                )}
                            </p>
                        ) : (
                            <p className="text-label text-gray-400">Loading…</p>
                        )
                    }
                />

                {/* Filter tabs */}
                <div className="shrink-0 flex border-b border-white/[0.06]">
                    {(['remaining', 'purchased', 'all'] as const).map((f) => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`flex-1 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-colors ${
                                filter === f
                                    ? 'text-emerald-400 border-b-2 border-emerald-400'
                                    : 'text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            {f === 'remaining'
                                ? `🛒 Need (${summary?.remaining ?? 0})`
                                : f === 'purchased'
                                  ? `✅ Done (${summary?.purchased ?? 0})`
                                  : `📋 All (${summary?.total ?? 0})`}
                        </button>
                    ))}
                </div>

                {/* Item list */}
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0 no-scrollbar">
                    {!summary || summary.total === 0 ? (
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
                                        d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"
                                    />
                                </svg>
                            }
                            title="No Grocery Items Yet"
                            subtitle="Add items from the Meal Calendar's 🛒 List button"
                            className="py-16"
                        />
                    ) : filteredZones.length === 0 ? (
                        <EmptyState
                            icon={<span className="text-3xl">✅</span>}
                            title={filter === 'remaining' ? 'All Done!' : 'No Purchased Items'}
                            subtitle={
                                filter === 'remaining'
                                    ? "All items have been purchased and added to Ship's Stores"
                                    : 'Items will appear here once purchased'
                            }
                            className="py-16"
                        />
                    ) : (
                        filteredZones.map((zone) => (
                            <div key={zone.zone}>
                                {/* Zone header */}
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-sm">{ZONE_EMOJI[zone.zone] || '🛒'}</span>
                                    <span className="text-label font-black text-gray-400 uppercase tracking-widest">
                                        {zone.zone}
                                    </span>
                                    <span className="text-micro text-gray-500 font-bold">({zone.items.length})</span>
                                </div>

                                {/* Items */}
                                <div className="space-y-1.5">
                                    {zone.items.map((item) => {
                                        const purchase = toPurchasable(
                                            item.ingredient_name,
                                            item.required_qty,
                                            item.unit,
                                        );
                                        const isPurchasing = purchasingId === item.id;

                                        return (
                                            <div
                                                key={item.id}
                                                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
                                                    item.purchased
                                                        ? 'bg-emerald-500/[0.04] border-emerald-500/10 opacity-60'
                                                        : 'bg-white/[0.02] border-white/[0.06]'
                                                }`}
                                            >
                                                {/* Checkbox */}
                                                <button
                                                    onClick={() =>
                                                        item.purchased ? handleUntick(item) : handleCheckbox(item)
                                                    }
                                                    disabled={isPurchasing}
                                                    className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center flex-shrink-0 transition-all active:scale-90 ${
                                                        item.purchased
                                                            ? 'bg-emerald-500 border-emerald-500'
                                                            : isPurchasing
                                                              ? 'border-amber-400 animate-pulse'
                                                              : 'border-gray-600 hover:border-emerald-400'
                                                    }`}
                                                    aria-label={
                                                        item.purchased
                                                            ? `Undo ${item.ingredient_name}`
                                                            : `Mark ${item.ingredient_name} as purchased`
                                                    }
                                                >
                                                    {item.purchased && (
                                                        <svg
                                                            className="w-3.5 h-3.5 text-black"
                                                            fill="none"
                                                            viewBox="0 0 24 24"
                                                            stroke="currentColor"
                                                            strokeWidth={3}
                                                        >
                                                            <path
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                                d="M4.5 12.75l6 6 9-13.5"
                                                            />
                                                        </svg>
                                                    )}
                                                    {isPurchasing && <span className="text-[10px]">⏳</span>}
                                                </button>

                                                {/* Name + purchase info */}
                                                <div className="flex-1 min-w-0">
                                                    <p
                                                        className={`text-xs font-bold truncate ${
                                                            item.purchased ? 'text-gray-500 line-through' : 'text-white'
                                                        }`}
                                                    >
                                                        {item.ingredient_name}
                                                    </p>
                                                    {item.purchased && item.purchased_at && (
                                                        <p className="text-[11px] text-emerald-500/60">
                                                            ✅ {new Date(item.purchased_at).toLocaleDateString()}
                                                            {item.store_location ? ` · ${item.store_location}` : ''}
                                                            {item.actual_cost
                                                                ? ` · $${item.actual_cost.toFixed(2)}`
                                                                : ''}
                                                        </p>
                                                    )}
                                                </div>

                                                {/* Purchase quantity */}
                                                <div className="text-right flex-shrink-0">
                                                    <span
                                                        className={`text-[11px] font-bold tabular-nums ${item.purchased ? 'text-gray-500' : 'text-emerald-400'}`}
                                                    >
                                                        {purchase.packageCount} × {purchase.packageLabel}
                                                    </span>
                                                    {purchase.matched && (
                                                        <p className="text-[11px] text-gray-500 line-through tabular-nums">
                                                            {Math.round(item.required_qty * 10) / 10} {item.unit}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* ═══ Voyage Budget Summary ═══ */}
                {budget && budget.total > 0 && (
                    <div className="shrink-0 mx-4 mb-3 p-3 rounded-xl bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.04] border border-emerald-500/10">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">
                                💰 Voyage Spend
                            </span>
                            <span className="text-sm font-black text-emerald-400 tabular-nums">
                                ${budget.total.toFixed(2)}
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {Object.entries(budget.byZone)
                                .filter(([, v]) => v > 0)
                                .sort(([, a], [, b]) => b - a)
                                .map(([zone, cost]) => (
                                    <span key={zone} className="text-[11px] text-gray-500">
                                        {ZONE_EMOJI[zone as MarketZone] || '🛒'} {zone}:{' '}
                                        <span className="text-gray-400 font-bold">${cost.toFixed(2)}</span>
                                    </span>
                                ))}
                        </div>
                    </div>
                )}

                {/* Progress bar at bottom */}
                {summary && summary.total > 0 && (
                    <div
                        className="shrink-0 px-4 py-3 border-t border-white/[0.06] bg-slate-950"
                        style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                    >
                        <div className="flex items-center gap-3">
                            <div className="flex-1 h-2 bg-white/[0.06] rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
                                    style={{
                                        width: `${Math.round((summary.purchased / summary.total) * 100)}%`,
                                    }}
                                />
                            </div>
                            <span className="text-[11px] font-bold text-emerald-400 tabular-nums whitespace-nowrap">
                                {summary.purchased}/{summary.total}
                            </span>
                        </div>
                    </div>
                )}
            </div>

            {/* ═══ Add Item FAB ═══ */}
            <button
                onClick={() => {
                    setShowAddForm(true);
                    setTimeout(() => addNameRef.current?.focus(), 150);
                }}
                className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-30 w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 shadow-lg shadow-emerald-500/30 flex items-center justify-center active:scale-90 transition-transform"
                aria-label="Add item"
            >
                <svg
                    className="w-7 h-7 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
            </button>

            {/* ═══ Price Input Modal ═══ */}
            {priceItem && (
                <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => setPriceItem(null)}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                    <div
                        className="relative w-full max-w-md mx-4 mb-[calc(5rem+env(safe-area-inset-bottom)+8px)] p-5 rounded-2xl bg-slate-900 border border-white/[0.08] shadow-2xl animate-in slide-in-from-bottom duration-200"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="text-sm font-black text-white mb-1">✅ Mark as Purchased</h3>
                        <p className="text-[11px] text-gray-400 mb-4">{priceItem.ingredient_name}</p>

                        {/* Price input */}
                        <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                            Price (optional)
                        </label>
                        <div className="flex items-center gap-2 mt-1 mb-4">
                            <span className="text-lg font-bold text-gray-500">$</span>
                            <input
                                ref={priceInputRef}
                                type="number"
                                inputMode="decimal"
                                step="0.01"
                                min="0"
                                value={priceValue}
                                onChange={(e) => setPriceValue(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleConfirmPurchase()}
                                placeholder="0.00"
                                className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-lg font-bold tabular-nums outline-none focus:border-emerald-500/50 transition-colors placeholder-gray-600"
                            />
                        </div>

                        {/* Store name */}
                        <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                            Store (optional)
                        </label>
                        <input
                            type="text"
                            value={storeName}
                            onChange={(e) => setStoreName(e.target.value)}
                            placeholder="Where did you buy it?"
                            className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm outline-none focus:border-emerald-500/50 transition-colors placeholder-gray-600"
                        />
                        <div className="flex flex-wrap gap-1.5 mt-2 mb-4">
                            {['Coles', 'Woolworths', 'Aldi', 'IGA', 'Markets'].map((s) => (
                                <button
                                    key={s}
                                    type="button"
                                    onClick={() => setStoreName(s)}
                                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all active:scale-95 ${
                                        storeName === s
                                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                            : 'bg-white/[0.04] text-gray-500 border border-white/[0.06] hover:text-gray-300'
                                    }`}
                                >
                                    {s}
                                </button>
                            ))}
                        </div>

                        {/* Buttons */}
                        <div className="flex gap-2">
                            <button
                                onClick={handleSkipPrice}
                                disabled={!!purchasingId}
                                className="flex-1 py-3 rounded-xl bg-white/[0.05] border border-white/[0.08] text-[11px] font-bold text-gray-400 uppercase tracking-widest active:scale-[0.97] disabled:opacity-40"
                            >
                                Skip Price
                            </button>
                            <button
                                onClick={handleConfirmPurchase}
                                disabled={!!purchasingId}
                                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-[11px] font-black text-white uppercase tracking-widest active:scale-[0.97] disabled:opacity-40"
                            >
                                {purchasingId ? '⏳ Saving…' : '✅ Confirm'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ Add Item Modal ═══ */}
            {showAddForm && (
                <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => setShowAddForm(false)}>
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                    <div
                        className="relative w-full max-w-md mx-4 p-5 rounded-2xl bg-slate-900 border border-white/[0.08] shadow-2xl animate-in slide-in-from-bottom duration-200"
                        style={{ marginBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="text-sm font-black text-white mb-4">➕ Add to Shopping List</h3>

                        {/* Item name */}
                        <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                            Item Name
                        </label>
                        <input
                            ref={addNameRef}
                            type="text"
                            value={addName}
                            onChange={(e) => setAddName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAddItem()}
                            placeholder="Shampoo, dish soap, shackle pins..."
                            className="w-full mt-1 mb-3 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-emerald-500/50 transition-colors placeholder-gray-600"
                        />

                        {/* Qty + Unit row */}
                        <div className="flex gap-2 mb-3">
                            <div className="flex-1">
                                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                                    Qty
                                </label>
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    min="1"
                                    value={addQty}
                                    onChange={(e) => setAddQty(e.target.value)}
                                    className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm font-bold tabular-nums outline-none focus:border-emerald-500/50"
                                />
                            </div>
                            <div className="flex-1">
                                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                                    Unit
                                </label>
                                <select
                                    value={addUnit}
                                    onChange={(e) => setAddUnit(e.target.value)}
                                    className="w-full mt-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-emerald-500/50 appearance-none"
                                >
                                    <option value="each">each</option>
                                    <option value="pack">pack</option>
                                    <option value="bottle">bottle</option>
                                    <option value="box">box</option>
                                    <option value="kg">kg</option>
                                    <option value="L">litres</option>
                                    <option value="m">metres</option>
                                    <option value="roll">roll</option>
                                    <option value="bag">bag</option>
                                    <option value="can">can</option>
                                    <option value="tube">tube</option>
                                </select>
                            </div>
                        </div>

                        {/* Zone picker */}
                        <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                            Aisle / Zone
                        </label>
                        <div className="flex flex-wrap gap-1.5 mt-1 mb-4">
                            {ALL_ZONES.map((z) => (
                                <button
                                    key={z}
                                    type="button"
                                    onClick={() => setAddZone(z)}
                                    className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all active:scale-95 ${
                                        addZone === z
                                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                            : 'bg-white/[0.04] text-gray-500 border border-white/[0.06] hover:text-gray-300'
                                    }`}
                                >
                                    {ZONE_EMOJI[z]} {z}
                                </button>
                            ))}
                        </div>

                        {/* Add button */}
                        <button
                            onClick={handleAddItem}
                            disabled={!addName.trim()}
                            className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-[11px] font-black text-white uppercase tracking-widest active:scale-[0.97] disabled:opacity-30 transition-all"
                        >
                            ➕ Add to List
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
