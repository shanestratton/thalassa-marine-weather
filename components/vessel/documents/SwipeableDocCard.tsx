/**
 * SwipeableDocCard — Swipeable document card with expiry traffic lights.
 *
 * Extracted from DocumentsHub to reduce component size.
 */

import React from 'react';
import type { ShipDocument, DocumentCategory } from '../../../types';
import { useSwipeable } from '../../../hooks/useSwipeable';

// ── Expiry logic ──

export type ExpiryStatus = 'valid' | 'warning' | 'expired' | 'none';

export function getExpiryStatus(expiryDate: string | null): ExpiryStatus {
    if (!expiryDate) return 'none';
    const now = Date.now();
    const expiry = new Date(expiryDate).getTime();
    if (expiry < now) return 'expired';
    if (expiry - now < 30 * 86400000) return 'warning';
    return 'valid';
}

export const EXPIRY_COLORS: Record<ExpiryStatus, { dot: string; text: string; border: string; label: string }> = {
    valid: { dot: 'bg-emerald-500', text: 'text-emerald-400', border: 'border-emerald-500/30', label: 'Valid' },
    warning: { dot: 'bg-amber-500', text: 'text-amber-400', border: 'border-amber-500/30', label: 'Expiring Soon' },
    expired: { dot: 'bg-red-500', text: 'text-red-400', border: 'border-red-500/30', label: 'Expired' },
    none: { dot: 'bg-gray-500', text: 'text-gray-400', border: 'border-gray-500/20', label: 'No Expiry' },
};

export const CATEGORY_ICONS: Record<DocumentCategory, string> = {
    Registration: '🚢',
    Insurance: '🛡️',
    'Crew Visas/IDs': '🪪',
    'Radio/MMSI': '📻',
    'Customs Clearances': '🛂',
    'User Manuals': '📖',
};

// ── Component ──

interface SwipeableDocCardProps {
    doc: ShipDocument;
    onTap: () => void;
    onEdit: () => void;
    onDelete: () => void;
    selected: boolean;
    onToggleSelect: () => void;
}

export const SwipeableDocCard: React.FC<SwipeableDocCardProps> = ({
    doc,
    onTap,
    onEdit,
    onDelete,
    selected,
    onToggleSelect,
}) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable();
    const status = getExpiryStatus(doc.expiry_date);
    const colors = EXPIRY_COLORS[status];

    return (
        <div className="relative overflow-hidden rounded-2xl">
            {/* Delete button */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
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

            {/* Main card */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} flex items-stretch border ${colors.border} rounded-2xl overflow-hidden bg-white/[0.03]`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                ref={ref}
                onClick={() => {
                    if (swipeOffset === 0) onTap();
                }}
            >
                {/* Selection checkbox */}
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleSelect();
                    }}
                    className="shrink-0 flex items-center justify-center w-10 ml-1"
                    aria-label={selected ? 'Deselect' : 'Select'}
                >
                    <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                            selected ? 'bg-sky-500 border-sky-500' : 'border-gray-500/40 bg-transparent'
                        }`}
                    >
                        {selected && (
                            <svg
                                className="w-3 h-3 text-white"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={3}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                        )}
                    </div>
                </button>

                {/* Traffic light bar */}
                <div className={`w-1.5 shrink-0 ${colors.dot}`} />

                {/* Content */}
                <div className="flex-1 p-4">
                    {/* Category badge */}
                    <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="text-micro">{CATEGORY_ICONS[doc.category] || '📋'}</span>
                        <span className="text-micro font-bold text-gray-400 uppercase tracking-widest">
                            {doc.category}
                        </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex-1 text-left min-w-0">
                            <h4 className="text-sm font-black text-white tracking-wide mb-0.5 truncate">
                                {doc.document_name}
                            </h4>
                            <div className="flex items-center gap-2 flex-wrap">
                                <p className={`text-label font-bold uppercase tracking-widest ${colors.text}`}>
                                    {colors.label}
                                </p>
                                {doc.expiry_date && (
                                    <span
                                        className={`px-2 py-0.5 rounded-lg text-label font-bold ${status === 'expired' ? 'bg-red-500/20 text-red-400' : status === 'warning' ? 'bg-amber-500/20 text-amber-400' : 'bg-white/5 text-gray-400'}`}
                                    >
                                        Exp {new Date(doc.expiry_date).toLocaleDateString()}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Edit button */}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onEdit();
                            }}
                            className="shrink-0 p-2 rounded-lg hover:bg-white/10 transition-colors self-center"
                            aria-label="Edit document"
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
            </div>
        </div>
    );
};
