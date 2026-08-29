/**
 * SavedRoutePicker — the Saved Routes chooser as a proper sheet.
 *
 * Replaces the native <select> (Shane 2026-08-27: "maybe a very nice modal
 * would be better than that horrible apple style box") and gives the list
 * STRUCTURE instead of a flat wheel: passages first with their legs listed
 * beneath them, then standalone routes — groups in date order, newest first
 * ("passage first. then the first leg, then the second leg. then the day
 * sail"). Legs sit flush under the passage name — the ↳ dog-leg arrow alone
 * marks them as legs (Shane 2026-08-27: "not have the legs indented").
 *
 * ARIA: the trigger is a combobox (aria-haspopup=listbox, aria-expanded);
 * the sheet is a listbox of options with aria-selected. Selection goes
 * through the same handler the old <select> used.
 *
 * 2026-08-30: the ordering moved to services/savedRouteOrder and the row
 * markup to components/routes/SavedRouteRows, so the PLAN tab's saved-routes
 * modal and the cast-off "Following a route?" sheet can wear the same layout.
 * This file keeps the trigger and the sheet chrome — the parts that are only
 * true here.
 */
import React, { useId, useMemo, useRef, useState } from 'react';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { triggerHaptic } from '../../utils/system';
import { orderSavedRouteRows, type SavedRoutePickerRow } from '../../services/savedRouteOrder';
import { SavedRouteList } from '../routes/SavedRouteRows';

export type { SavedRoutePickerRow };

interface SavedRoutePickerProps {
    rows: SavedRoutePickerRow[];
    selectedId: string;
    onSelect: (id: string) => void;
}

export const SavedRoutePicker: React.FC<SavedRoutePickerProps> = ({ rows, selectedId, onSelect }) => {
    const [open, setOpen] = useState(false);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    /* Generated, not a literal. A second surface mounting this list with a
       hard-coded id would emit duplicate DOM ids and make a listbox query by
       accessible name ambiguous. */
    const listboxId = useId();
    const dialogRef = useFocusTrap<HTMLDivElement>(open, {
        initialFocusRef: closeButtonRef,
        onEscape: () => setOpen(false),
    });

    const ordered = useMemo(() => orderSavedRouteRows(rows), [rows]);

    const choose = (id: string) => {
        setOpen(false);
        onSelect(id);
    };

    const selected = rows.find((row) => row.id === selectedId) ?? null;

    return (
        <>
            <button
                type="button"
                role="combobox"
                aria-label="Saved Routes"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={listboxId}
                onClick={() => {
                    triggerHaptic('light');
                    setOpen(true);
                }}
                className="w-full flex items-center justify-between gap-2 bg-white/[0.06] border border-white/[0.12] rounded-lg px-3 py-2.5 text-sm text-left focus:outline-none focus:border-violet-500/40"
            >
                <span className={selected ? 'text-white' : 'text-gray-400'}>
                    {selected ? [selected.name, selected.legBadge].filter(Boolean).join(' ') : 'Choose a saved route…'}
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
                    <div className="fixed inset-0 z-[10050] flex items-center justify-center p-4">
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
                            className="relative w-full max-w-lg max-h-[75vh] flex flex-col rounded-3xl border border-white/10 bg-slate-900 shadow-2xl shadow-black/60"
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
                            <SavedRouteList
                                rows={ordered}
                                selectedId={selectedId}
                                onSelect={choose}
                                listboxId={listboxId}
                            >
                                <button
                                    type="button"
                                    role="option"
                                    aria-selected={false}
                                    onClick={() => {
                                        triggerHaptic('light');
                                        choose('');
                                    }}
                                    className="w-full flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-left text-xs font-bold text-gray-400 hover:bg-white/[0.05]"
                                >
                                    <span aria-hidden="true">✕</span>
                                    <span>Clear selection</span>
                                </button>
                            </SavedRouteList>
                        </div>
                    </div>
                </OverlayPortal>
            )}
        </>
    );
};
