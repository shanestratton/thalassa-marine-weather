/**
 * SwipeableEquipmentCard — Swipeable equipment card with warranty status.
 *
 * Extracted from EquipmentList to reduce component size.
 */

import React from 'react';
import type { EquipmentItem, EquipmentCategory } from '../../../types';
import { useSwipeable } from '../../../hooks/useSwipeable';
import { triggerHaptic } from '../../../utils/system';
import { localDaysUntil } from '../../../utils/localDate';
import { ClipboardIcon, GearIcon, RadioIcon } from '../../icons/UIIcons';
import { DropletIcon, ThermometerIcon } from '../../icons/WeatherIcons';
import { FoodIcon, SailBoatIcon } from '../../icons/MaritimeIcons';

/** A stroke icon from components/icons; each one is aria-hidden. */
export type EquipmentCategoryIcon = (props: { className?: string }) => React.JSX.Element;

// Line icons, not emoji (⚙️ 📡 ❄️ 🔧 ⛵ 🍳 rendered as OS-varying colour
// glyphs beside the app's stroke icons; UX scorecard run 7).
export const CATEGORY_ICONS: Record<EquipmentCategory, EquipmentCategoryIcon> = {
    Propulsion: GearIcon,
    Electronics: RadioIcon,
    HVAC: ThermometerIcon,
    Plumbing: DropletIcon,
    Rigging: SailBoatIcon,
    Galley: FoodIcon,
};

/** For a category the register does not know (older rows). */
export const FALLBACK_CATEGORY_ICON: EquipmentCategoryIcon = ClipboardIcon;

/**
 * Is the warranty still in force? Through the end of its last day, on the
 * phone's calendar, as the Equipment PDF reds a name only once it has run
 * out. Its UTC midnight (the synced '2026-11-01T00:00:00+00:00' too) ended
 * it a day early in the Americas (131-B11, EQ-2). Null with no date.
 */
export function warrantyInForce(warrantyExpiry: string | null | undefined): boolean | null {
    const days = localDaysUntil(warrantyExpiry);
    return days === null ? null : days >= 0;
}

export const CATEGORIES: { id: EquipmentCategory; label: string; Icon: EquipmentCategoryIcon }[] = (
    ['Propulsion', 'Electronics', 'HVAC', 'Plumbing', 'Rigging', 'Galley'] as EquipmentCategory[]
).map((id) => ({ id, label: id, Icon: CATEGORY_ICONS[id] }));

interface SwipeableCardProps {
    item: EquipmentItem;
    onTap: () => void;
    /** Omitted on a skipper's shared binder: no swipe-to-delete at all. */
    onDelete?: () => void;
    onContextMenu: () => void;
}

export const SwipeableEquipmentCard: React.FC<SwipeableCardProps> = ({ item, onTap, onDelete, onContextMenu }) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable({
        onSwipeComplete: () => void triggerHaptic('light'),
    });
    const revealed = swipeOffset > 0;
    const confirmDelete = () => {
        resetSwipe();
        onDelete?.();
    };
    const CategoryIcon = CATEGORY_ICONS[item.category] ?? FALLBACK_CATEGORY_ICON;
    // Make and model, whichever are set; a lone ' — ' said nothing.
    const makeModel = [item.make, item.model].filter((part) => part && part.trim()).join(' — ') || '--';

    const warrantyActive = warrantyInForce(item.warranty_expiry);

    return (
        <div className="relative overflow-hidden rounded-lg">
            {/* Delete button (revealed on swipe). Hidden from assistive tech
                until the swipe reveals it, then a named button, like the
                maintenance cards (126-B10b): VoiceOver read an unnamed
                "Delete" before every one of the register's items. */}
            {onDelete && (
                <div
                    className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-lg transition-opacity ${revealed ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                    aria-hidden={revealed ? undefined : true}
                    role={revealed ? 'button' : undefined}
                    aria-label={revealed ? `Delete ${item.equipment_name}` : undefined}
                    tabIndex={revealed ? 0 : -1}
                    onClick={confirmDelete}
                    onKeyDown={(e) => {
                        if (!revealed || (e.key !== 'Enter' && e.key !== ' ')) return;
                        e.preventDefault();
                        confirmDelete();
                    }}
                >
                    <div className="text-center text-white" aria-hidden="true">
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
            )}

            {/* Main card (slides on swipe) */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} bg-slate-800/40 rounded-lg p-3 border border-white/5`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                ref={onDelete ? ref : undefined}
                onClick={() => {
                    if (swipeOffset === 0) onTap();
                }}
            >
                {/* Category badge — top of card */}
                <div className="flex items-center gap-1.5 mb-1.5">
                    <CategoryIcon className="h-3 w-3 shrink-0 text-gray-400" />
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
                                aria-hidden="true"
                            />
                        )}
                        {/* The dot is colour-only and `title` never shows on touch —
                            say it for the screen reader too. */}
                        {item.warranty_expiry && (
                            <span className="sr-only">{warrantyActive ? 'Warranty active' : 'Warranty expired'}</span>
                        )}
                    </div>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onContextMenu();
                        }}
                        className="hit-target-44 p-1.5 -mr-1 -mt-0.5 rounded-lg hover:bg-white/10 transition-colors shrink-0"
                        aria-label={`Options for ${item.equipment_name}`}
                    >
                        <svg
                            aria-hidden="true"
                            className="w-4 h-4 text-slate-400"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                        >
                            <circle cx="12" cy="5" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="12" cy="19" r="1.5" />
                        </svg>
                    </button>
                </div>

                {/* Row 2: Make — Model */}
                <p className="text-label text-slate-400 font-bold mt-1">{makeModel}</p>
            </div>
        </div>
    );
};
