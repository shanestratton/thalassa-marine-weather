/**
 * SwipeableItemCard — Swipeable checklist item card (heading or detail).
 *
 * Extracted from ChecklistsPage to reduce component size.
 */

import React from 'react';
import type { ChecklistEntry } from '../../../services/vessel/LocalChecklistService';
import { useSwipeable } from '../../../hooks/useSwipeable';

interface SwipeableItemCardProps {
    entry: ChecklistEntry;
    onEdit: () => void;
    onDelete: () => void;
    isHeading?: boolean;
    itemCount?: number;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    isFirst?: boolean;
    isLast?: boolean;
}

export const SwipeableItemCard: React.FC<SwipeableItemCardProps> = ({
    entry,
    onEdit,
    onDelete,
    isHeading,
    itemCount,
    onMoveUp,
    onMoveDown,
    isFirst,
    isLast,
}) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable();

    return (
        <div className="relative overflow-hidden rounded-xl">
            {/* Delete action */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => {
                    resetSwipe();
                    onDelete();
                }}
            >
                <div className="text-center text-white">
                    <svg className="w-4 h-4 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                    </svg>
                    <span className="text-[11px] font-bold">Delete</span>
                </div>
            </div>

            {/* Main card */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} border rounded-xl overflow-hidden bg-white/[0.03] ${
                    isHeading ? 'border-emerald-500/20' : 'border-white/[0.06] ml-4'
                }`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                ref={ref}
                onClick={() => {
                    if (swipeOffset === 0) onEdit();
                }}
            >
                <div className="flex items-center gap-3 p-3">
                    {isHeading ? (
                        <>
                            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
                                <svg
                                    className="w-4 h-4 text-emerald-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
                                    />
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <h4 className="text-sm font-black text-white tracking-wide">{entry.text}</h4>
                                <p className="text-[11px] text-emerald-400/70 font-bold uppercase tracking-widest mt-0.5">
                                    {itemCount ?? 0} item{(itemCount ?? 0) !== 1 ? 's' : ''}
                                </p>
                            </div>
                        </>
                    ) : (
                        <>
                            {/* Move up/down buttons */}
                            <div className="flex flex-col gap-0.5 shrink-0">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onMoveUp?.();
                                    }}
                                    disabled={isFirst}
                                    className={`p-1 rounded transition-colors ${isFirst ? 'text-white/10' : 'text-white/40 hover:text-white/70 hover:bg-white/10 active:scale-90'}`}
                                    aria-label="Move up"
                                >
                                    <svg
                                        className="w-3.5 h-3.5"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2.5}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M4.5 15.75l7.5-7.5 7.5 7.5"
                                        />
                                    </svg>
                                </button>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onMoveDown?.();
                                    }}
                                    disabled={isLast}
                                    className={`p-1 rounded transition-colors ${isLast ? 'text-white/10' : 'text-white/40 hover:text-white/70 hover:bg-white/10 active:scale-90'}`}
                                    aria-label="Move down"
                                >
                                    <svg
                                        className="w-3.5 h-3.5"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2.5}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                        />
                                    </svg>
                                </button>
                            </div>
                            <div className="w-5 h-5 rounded-full border-2 border-white/20 shrink-0" />
                            <span className="text-sm text-white/80 font-medium flex-1 min-w-0 truncate">
                                {entry.text}
                            </span>
                        </>
                    )}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onEdit();
                        }}
                        className="shrink-0 p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                        aria-label="Edit"
                    >
                        <svg
                            className="w-3.5 h-3.5 text-slate-400"
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
        </div>
    );
};
