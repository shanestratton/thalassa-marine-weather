/**
 * SwipeableEquipmentCard — Swipeable equipment card with warranty status.
 *
 * Extracted from EquipmentList to reduce component size.
 */

import React from 'react';
import type { EquipmentItem, EquipmentCategory } from '../../../types';
import { useSwipeable } from '../../../hooks/useSwipeable';

export const CATEGORIES: { id: EquipmentCategory; label: string; icon: string }[] = [
    { id: 'Propulsion', label: 'Propulsion', icon: '⚙️' },
    { id: 'Electronics', label: 'Electronics', icon: '📡' },
    { id: 'HVAC', label: 'HVAC', icon: '❄️' },
    { id: 'Plumbing', label: 'Plumbing', icon: '🔧' },
    { id: 'Rigging', label: 'Rigging', icon: '⛵' },
    { id: 'Galley', label: 'Galley', icon: '🍳' },
];

export const CATEGORY_ICONS: Record<EquipmentCategory, string> = {
    Propulsion: '⚙️',
    Electronics: '📡',
    HVAC: '❄️',
    Plumbing: '🔧',
    Rigging: '⛵',
    Galley: '🍳',
};

interface SwipeableCardProps {
    item: EquipmentItem;
    onTap: () => void;
    onDelete: () => void;
    onContextMenu: () => void;
}

export const SwipeableEquipmentCard: React.FC<SwipeableCardProps> = ({ item, onTap, onDelete, onContextMenu }) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable();

    const warrantyActive = item.warranty_expiry ? new Date(item.warranty_expiry).getTime() > Date.now() : null;

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
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} bg-slate-800/40 rounded-lg p-3 border border-white/5`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                ref={ref}
                onClick={() => {
                    if (swipeOffset === 0) onTap();
                }}
            >
                {/* Category badge — top of card */}
                <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-micro">{CATEGORY_ICONS[item.category] || '📋'}</span>
                    <span className="text-micro font-bold text-gray-400 uppercase tracking-widest">
                        {item.category}
                    </span>
                </div>
                {/* Row 1: Name + Warranty dot + 3-dot menu */}
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                        <h4 className="text-sm font-bold text-white truncate">{item.equipment_name}</h4>
                        {/* Warranty status dot */}
                        {item.warranty_expiry && (
                            <span
                                className={`w-2 h-2 rounded-full shrink-0 ${warrantyActive ? 'bg-emerald-400' : 'bg-red-400'}`}
                                title={warrantyActive ? 'Warranty Active' : 'Warranty Expired'}
                            />
                        )}
                    </div>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onContextMenu();
                        }}
                        className="p-1.5 -mr-1 -mt-0.5 rounded-lg hover:bg-white/10 transition-colors shrink-0"
                        aria-label="Equipment options"
                    >
                        <svg className="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="5" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="12" cy="19" r="1.5" />
                        </svg>
                    </button>
                </div>

                {/* Row 2: Make — Model */}
                <p className="text-label text-slate-400 font-bold mt-1">
                    {item.make} — {item.model}
                </p>
            </div>
        </div>
    );
};
