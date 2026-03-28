/**
 * SwipeableTaskCard — Swipeable maintenance task card with traffic-light status.
 *
 * Extracted from MaintenanceHub to reduce component size.
 */

import React from 'react';
import type { TaskWithStatus, TrafficLight } from '../../../services/MaintenanceService';
import type { MaintenanceTriggerType } from '../../../types';
import { useSwipeable } from '../../../hooks/useSwipeable';
import { CATEGORIES, TRIGGER_LABELS } from './constants';

/** Map period triggers to their interval in days */
export const PERIOD_DAYS: Partial<Record<MaintenanceTriggerType, number>> = {
    daily: 1,
    quarterly: 90,
    monthly: 30,
    bi_annual: 182,
    annual: 365,
};

// Traffic light colors
export const LIGHT_COLORS: Record<TrafficLight, { dot: string; bg: string; border: string; text: string }> = {
    red: { dot: 'bg-red-500', bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-400' },
    yellow: { dot: 'bg-amber-500', bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400' },
    green: {
        dot: 'bg-emerald-500',
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/30',
        text: 'text-emerald-400',
    },
    grey: { dot: 'bg-gray-500', bg: 'bg-gray-500/10', border: 'border-gray-500/20', text: 'text-gray-400' },
};

interface SwipeableTaskCardProps {
    task: TaskWithStatus;
    categories: typeof CATEGORIES;
    lightColors: typeof LIGHT_COLORS;
    triggerLabels: typeof TRIGGER_LABELS;
    onTap: () => void;
    onDelete: () => void;
}

export const SwipeableTaskCard: React.FC<SwipeableTaskCardProps> = ({
    task,
    categories,
    lightColors,
    triggerLabels: _triggerLabels,
    onTap,
    onDelete,
}) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable();
    const light = lightColors[task.status];
    const catConfig = categories.find((c) => c.id === task.category);

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
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} bg-slate-800/40 rounded-lg p-3 border border-white/5 border-l-2 ${
                    task.status === 'red'
                        ? 'border-l-red-500'
                        : task.status === 'yellow'
                          ? 'border-l-amber-400'
                          : task.status === 'green'
                            ? 'border-l-emerald-500'
                            : 'border-l-gray-500'
                }`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                ref={ref}
            >
                {/* Category badge — top of card */}
                <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-micro">{catConfig?.icon || '📋'}</span>
                    <span className="text-micro font-bold text-gray-400 uppercase tracking-widest">
                        {catConfig?.label || task.category}
                    </span>
                </div>
                {/* Row 1: Title + 3-dot menu */}
                <div className="flex items-start justify-between gap-2">
                    <h4 className="text-sm font-bold text-white truncate flex-1 min-w-0">{task.title}</h4>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onTap();
                        }}
                        className="p-1.5 -mr-1 -mt-0.5 rounded-lg hover:bg-white/10 transition-colors shrink-0"
                        aria-label="Task options"
                    >
                        <svg className="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="5" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="12" cy="19" r="1.5" />
                        </svg>
                    </button>
                </div>

                {/* Row 2: Status label + due info */}
                <div className="flex items-center justify-between mt-1.5">
                    <p className={`text-label font-bold uppercase tracking-widest ${light.text}`}>{task.statusLabel}</p>
                    <div className="flex items-center gap-2">
                        {task.trigger_type === 'engine_hours' && task.next_due_hours !== null && (
                            <span className="text-label text-slate-400 font-mono">
                                @ {task.next_due_hours?.toLocaleString()} hrs
                            </span>
                        )}
                        {task.next_due_date && (
                            <span className="text-label text-slate-400 font-mono">
                                {new Date(task.next_due_date).toLocaleDateString()}
                            </span>
                        )}
                    </div>
                </div>

                {/* Row 3: Last serviced */}
                {task.last_completed && (
                    <p className="text-label text-slate-400 mt-1">
                        Last serviced: {new Date(task.last_completed).toLocaleDateString()}
                    </p>
                )}
            </div>
        </div>
    );
};
