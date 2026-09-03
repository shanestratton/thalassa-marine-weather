/**
 * SavedRoutesSelector — the Saved Routes label, picker, loading/empty states
 * and the yours/shared count line.
 *
 * Moved verbatim out of components/CrewManagement.tsx. Presentational only:
 * every decision (which rows exist, what selecting one does) still belongs to
 * CrewManagement.
 */
import React from 'react';
import { CompassIcon } from '../Icons';
import { SavedRoutePicker, type SavedRoutePickerRow } from '../crew/SavedRoutePicker';
import { type VoyageRow } from './types';

interface SavedRoutesSelectorProps {
    draftVoyages: VoyageRow[];
    savedRoutePickerRows: SavedRoutePickerRow[];
    selectedPassageId: string;
    handlePassageSelection: (id: string) => Promise<void>;
    savedRoutesLoading: boolean;
    ownVoyageCount: number;
    sharedVoyageCount: number;
}

export const SavedRoutesSelector: React.FC<SavedRoutesSelectorProps> = ({
    draftVoyages,
    savedRoutePickerRows,
    selectedPassageId,
    handlePassageSelection,
    savedRoutesLoading,
    ownVoyageCount,
    sharedVoyageCount,
}) => {
    return (
        <div className="mb-4">
            <label className="text-[11px] uppercase font-bold text-violet-400/60 tracking-wider mb-1.5 flex items-center gap-1.5">
                <CompassIcon className="w-3 h-3" rotation={0} />
                <span>Saved Routes</span>
            </label>
            {draftVoyages.length > 0 ? (
                <SavedRoutePicker
                    rows={savedRoutePickerRows}
                    selectedId={selectedPassageId}
                    onSelect={(id) => void handlePassageSelection(id)}
                />
            ) : savedRoutesLoading ? (
                <div
                    role="status"
                    aria-live="polite"
                    className="bg-white/3 border border-dashed border-white/10 rounded-lg px-3 py-4 text-center"
                >
                    <p className="text-xs font-semibold text-slate-200">Loading saved routes…</p>
                    <p className="mt-0.5 text-[11px] text-slate-400 leading-relaxed">
                        Your on-device routes appear first, then this library checks for updates.
                    </p>
                </div>
            ) : (
                // Empty state is deliberate: a route only enters this
                // library after the skipper saves it, never as a
                // placeholder passage.
                <div className="bg-white/3 border border-dashed border-white/10 rounded-lg px-3 py-4 text-center">
                    <div className="w-9 h-9 mx-auto mb-2 rounded-full bg-sky-500/8 border border-sky-500/15 flex items-center justify-center">
                        <svg
                            className="w-4 h-4 text-sky-400/70"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.8}
                            aria-hidden="true"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                            />
                        </svg>
                    </div>
                    <p className="text-xs font-semibold text-slate-200 mb-0.5">No saved routes yet</p>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                        Plan a route from the Plan tab; saved routes will appear here.
                    </p>
                </div>
            )}

            {/* A compact count is enough context here. Route removal
                        lives in the dedicated Saved Routes library (Vessel →
                        Saved Routes), where each route is reviewed and
                        confirmed individually. */}
            <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
                <span className="text-[10px] text-gray-500 font-mono">
                    {ownVoyageCount} yours
                    {sharedVoyageCount > 0 ? ` · ${sharedVoyageCount} shared` : ''}
                </span>
            </div>
        </div>
    );
};
