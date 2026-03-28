/**
 * SwipeableInventoryCard — Swipeable inventory item card with quantity controls.
 *
 * Extracted from InventoryList to reduce component size.
 */

import React from 'react';
import type { InventoryItem } from '../../../types';
import { useSwipeable } from '../../../hooks/useSwipeable';

interface SwipeableInventoryCardProps {
    item: InventoryItem;
    isExpanded: boolean;
    onTap: () => void;
    onDelete: () => void;
    onEdit: () => void;
    onQuantityAdjust: (id: string, delta: number) => void;
}

export const SwipeableInventoryCard: React.FC<SwipeableInventoryCardProps> = ({
    item,
    isExpanded,
    onTap,
    onDelete,
    onEdit,
    onQuantityAdjust,
}) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable();

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

            {/* Main card (slides on swipe) */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} bg-slate-800/40 rounded-lg border ${isLow ? 'border-amber-500/20' : 'border-white/5'}`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                ref={ref}
                onClick={() => {
                    if (swipeOffset === 0) onTap();
                }}
            >
                {/* Main row */}
                <div className="px-3 py-3">
                    <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-bold text-white truncate">{item.item_name}</h4>
                            {item.location_zone && (
                                <p className="text-label text-gray-400 truncate">
                                    📍 {item.location_zone}
                                    {item.location_specific ? ` — ${item.location_specific}` : ''}
                                </p>
                            )}
                            {isExpired && <p className="text-label font-bold text-red-400 mt-0.5">⚠️ Expired</p>}
                            {isExpiringSoon && (
                                <p className="text-label font-bold text-amber-400 mt-0.5">
                                    ⏳ Expires in {daysUntilExpiry}d
                                </p>
                            )}
                        </div>
                        <div
                            className={`px-2.5 py-1 rounded-lg text-center min-w-[3rem] ${isLow ? 'bg-amber-500/20 border border-amber-500/30' : 'bg-white/5'}`}
                        >
                            <p className={`text-sm font-black tabular-nums ${isLow ? 'text-amber-400' : 'text-white'}`}>
                                {item.quantity}
                            </p>
                        </div>
                        {/* Edit button */}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onEdit();
                            }}
                            className="p-1.5 -mr-1 rounded-lg hover:bg-white/10 transition-colors shrink-0"
                            aria-label="Edit item"
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

                {/* Expanded detail */}
                {isExpanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-white/5 animate-in fade-in duration-200">
                        <div className="grid grid-cols-2 gap-2 text-label mb-3">
                            <div>
                                <span className="text-gray-400">Category</span>
                                <p className="text-white font-bold">{item.category}</p>
                            </div>
                            {item.barcode && (
                                <div>
                                    <span className="text-gray-400">Barcode</span>
                                    <p className="text-white font-mono">{item.barcode}</p>
                                </div>
                            )}
                            {item.description && (
                                <div className="col-span-2">
                                    <span className="text-gray-400">Notes</span>
                                    <p className="text-gray-300">{item.description}</p>
                                </div>
                            )}
                            {item.expiry_date && (
                                <div>
                                    <span className="text-gray-400">Expiry / Service</span>
                                    <p
                                        className={`font-bold ${isExpired ? 'text-red-400' : isExpiringSoon ? 'text-amber-400' : 'text-emerald-400'}`}
                                    >
                                        {new Date(item.expiry_date).toLocaleDateString()}
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Quantity controls only */}
                        <div className="flex items-center justify-center gap-4 py-2 bg-white/[0.03] border border-white/[0.06] rounded-xl">
                            <button
                                aria-label="Decrease quantity"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onQuantityAdjust(item.id, -1);
                                }}
                                disabled={item.quantity <= 0}
                                className="w-9 h-9 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center text-red-400 font-bold hover:bg-red-500/25 transition-all active:scale-90 disabled:opacity-30"
                            >
                                −
                            </button>
                            <span className="text-white font-black text-lg w-8 text-center tabular-nums">
                                {item.quantity}
                            </span>
                            <button
                                aria-label="Increase quantity"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onQuantityAdjust(item.id, 1);
                                }}
                                className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold hover:bg-emerald-500/25 transition-all active:scale-90"
                            >
                                +
                            </button>
                        </div>

                        {isLow && (
                            <p className="text-label text-amber-400 font-bold mt-2">
                                ⚠️ Below minimum ({item.min_quantity})
                            </p>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
