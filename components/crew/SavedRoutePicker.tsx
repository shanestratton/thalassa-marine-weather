/**
 * SavedRoutePicker — the Saved Routes chooser as a proper sheet.
 *
 * Replaces the native <select> (Shane 2026-08-27: "maybe a very nice modal
 * would be better than that horrible apple style box") and gives the list
 * STRUCTURE instead of a flat wheel: passages first with their legs indented
 * beneath them, then standalone routes — groups in date order, newest first
 * ("passage first. then the first leg, then the second leg. then the day
 * sail").
 *
 * ARIA: the trigger is a combobox (aria-haspopup=listbox, aria-expanded);
 * the sheet is a listbox of options with aria-selected. Selection goes
 * through the same handler the old <select> used.
 */
import React, { useMemo, useRef, useState } from 'react';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { triggerHaptic } from '../../utils/system';

export interface SavedRoutePickerRow {
    id: string;
    name: string;
    /** Secondary line — distance / legs / shared-by. */
    detail: string | null;
    kind: 'passage' | 'leg' | 'standalone';
    /** 1-based within its trip; orders legs under their passage. */
    legOrdinal?: number;
    /** Group identity — a trip id for passage/leg rows, own id otherwise. */
    groupKey: string;
    /** Newest activity in the group decides group order (ms epoch). */
    stamp: number;
}

interface SavedRoutePickerProps {
    rows: SavedRoutePickerRow[];
    selectedId: string;
    onSelect: (id: string) => void;
}

const kindRank = (kind: SavedRoutePickerRow['kind']): number => (kind === 'passage' ? 0 : kind === 'leg' ? 1 : 2);

export const SavedRoutePicker: React.FC<SavedRoutePickerProps> = ({ rows, selectedId, onSelect }) => {
    const [open, setOpen] = useState(false);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(open, {
        initialFocusRef: closeButtonRef,
        onEscape: () => setOpen(false),
    });

    const ordered = useMemo(() => {
        const groupStamp = new Map<string, number>();
        for (const row of rows) {
            groupStamp.set(row.groupKey, Math.max(groupStamp.get(row.groupKey) ?? 0, row.stamp));
        }
        return [...rows].sort((a, b) => {
            if (a.groupKey !== b.groupKey) {
                const byStamp = (groupStamp.get(b.groupKey) ?? 0) - (groupStamp.get(a.groupKey) ?? 0);
                if (byStamp !== 0) return byStamp;
                return a.groupKey.localeCompare(b.groupKey);
            }
            const byKind = kindRank(a.kind) - kindRank(b.kind);
            if (byKind !== 0) return byKind;
            return (a.legOrdinal ?? 0) - (b.legOrdinal ?? 0);
        });
    }, [rows]);

    const selected = rows.find((row) => row.id === selectedId) ?? null;

    return (
        <>
            <button
                type="button"
                role="combobox"
                aria-label="Saved Routes"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls="saved-route-picker-listbox"
                onClick={() => {
                    triggerHaptic('light');
                    setOpen(true);
                }}
                className="w-full flex items-center justify-between gap-2 bg-white/[0.06] border border-white/[0.12] rounded-lg px-3 py-2.5 text-sm text-left focus:outline-none focus:border-violet-500/40"
            >
                <span className={selected ? 'text-white' : 'text-gray-400'}>
                    {selected ? selected.name : 'Choose a saved route…'}
                </span>
                <svg
                    className="w-4 h-4 shrink-0 text-violet-300"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {open && (
                <OverlayPortal>
                    <div className="fixed inset-0 z-[10050] flex items-end justify-center">
                        <button
                            type="button"
                            aria-label="Close saved routes"
                            className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
                            onClick={() => setOpen(false)}
                        />
                        <div
                            ref={dialogRef}
                            role="dialog"
                            aria-modal="true"
                            aria-label="Saved Routes"
                            className="relative w-full max-w-lg max-h-[75vh] flex flex-col rounded-t-3xl border border-white/10 border-b-0 bg-slate-900 shadow-2xl shadow-black/60"
                        >
                            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/[0.06]">
                                <div>
                                    <p className="text-[11px] font-black uppercase tracking-[0.2em] text-violet-300">
                                        Saved Routes
                                    </p>
                                    <p className="mt-0.5 text-[11px] text-gray-500">
                                        Passages first, legs beneath them, day sails after.
                                    </p>
                                </div>
                                <button
                                    ref={closeButtonRef}
                                    type="button"
                                    onClick={() => setOpen(false)}
                                    className="min-h-[40px] rounded-xl border border-white/10 px-3 py-1.5 text-xs font-black text-gray-300"
                                >
                                    Close
                                </button>
                            </div>
                            <div
                                id="saved-route-picker-listbox"
                                role="listbox"
                                aria-label="Saved Routes"
                                className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5"
                                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
                            >
                                {
                                    <button
                                        type="button"
                                        role="option"
                                        aria-selected={false}
                                        onClick={() => {
                                            triggerHaptic('light');
                                            setOpen(false);
                                            onSelect('');
                                        }}
                                        className="w-full flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-left text-xs font-bold text-gray-400 hover:bg-white/[0.05]"
                                    >
                                        <span aria-hidden="true">✕</span>
                                        <span>Clear selection</span>
                                    </button>
                                }
                                {ordered.map((row) => {
                                    const isSelected = row.id === selectedId;
                                    const isLeg = row.kind === 'leg';
                                    return (
                                        <button
                                            key={row.id}
                                            type="button"
                                            role="option"
                                            aria-selected={isSelected}
                                            onClick={() => {
                                                triggerHaptic('light');
                                                setOpen(false);
                                                onSelect(row.id);
                                            }}
                                            className={`w-full flex items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${
                                                isLeg ? 'ml-5 w-[calc(100%-1.25rem)]' : ''
                                            } ${
                                                isSelected
                                                    ? 'bg-violet-500/[0.14] border-violet-400/40'
                                                    : 'bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.06]'
                                            }`}
                                        >
                                            <span aria-hidden="true" className="text-base leading-none">
                                                {row.kind === 'passage' ? '🧭' : isLeg ? '↳' : '📍'}
                                            </span>
                                            <span className="flex-1 min-w-0">
                                                <span
                                                    className={`block truncate text-sm ${
                                                        row.kind === 'passage'
                                                            ? 'font-black text-white'
                                                            : 'font-semibold text-slate-100'
                                                    }`}
                                                >
                                                    {row.name}
                                                </span>
                                                {row.detail && (
                                                    <span className="block text-[11px] text-gray-500">
                                                        {row.detail}
                                                    </span>
                                                )}
                                            </span>
                                            {isSelected && (
                                                <span aria-hidden="true" className="text-violet-300 font-black">
                                                    ✓
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </OverlayPortal>
            )}
        </>
    );
};
