/**
 * SavedRoutesSelector — the Saved Routes label, picker, loading/empty states
 * and the yours/shared count line.
 *
 * Moved verbatim out of components/CrewManagement.tsx. Presentational only:
 * every decision (which rows exist, what selecting one does) still belongs to
 * CrewManagement.
 *
 * 2026-10-06, the page's tier-1 look: an uppercase eyebrow, the picker as the
 * Plan page's Trip tile with the count as its subline, and glass cards for the
 * loading and empty states (with the count beneath them, as before).
 */
import React from 'react';
import { SavedRoutePicker, type SavedRoutePickerRow } from '../crew/SavedRoutePicker';
import { type VoyageRow } from './types';
import { RouteGlyph } from '../crew/crewGlyphs';

interface SavedRoutesSelectorProps {
    draftVoyages: VoyageRow[];
    savedRoutePickerRows: SavedRoutePickerRow[];
    selectedPassageId: string;
    handlePassageSelection: (id: string) => Promise<void>;
    savedRoutesLoading: boolean;
    ownVoyageCount: number;
    sharedVoyageCount: number;
    /** Replaces the "N yours · M shared" line (the crewing view: "2 shared from Petrel"). */
    countLabel?: string;
    /** Replaces the empty state's title and hint. */
    emptyTitle?: string;
    emptyHint?: string;
}

export const SavedRoutesSelector: React.FC<SavedRoutesSelectorProps> = ({
    draftVoyages,
    savedRoutePickerRows,
    selectedPassageId,
    handlePassageSelection,
    savedRoutesLoading,
    ownVoyageCount,
    sharedVoyageCount,
    countLabel,
    emptyTitle,
    emptyHint,
}) => {
    const count = countLabel ?? (
        <>
            {ownVoyageCount} yours
            {sharedVoyageCount > 0 ? ` · ${sharedVoyageCount} shared` : ''}
        </>
    );
    return (
        <div className="mb-5">
            <h2 className="crew-eyebrow mb-2">Saved Routes</h2>
            {draftVoyages.length > 0 ? (
                // The count rides in the tile as its subline (the Plan Trip
                // tile's face). Route removal lives in the dedicated Saved
                // Routes library (Vessel → Saved Routes), where each route is
                // reviewed and confirmed individually.
                <SavedRoutePicker
                    rows={savedRoutePickerRows}
                    selectedId={selectedPassageId}
                    onSelect={(id) => void handlePassageSelection(id)}
                    subline={count}
                />
            ) : (
                <>
                    {savedRoutesLoading ? (
                        <div role="status" aria-live="polite" className="crew-card flex items-center gap-3 px-3.5 py-3">
                            <span aria-hidden="true" className="crew-pulse" />
                            <div className="min-w-0">
                                <p className="text-xs font-semibold text-white">Loading saved routes…</p>
                                <p className="crew-card-sub mt-0.5">
                                    Your on-device routes appear first, then this library checks for updates.
                                </p>
                            </div>
                        </div>
                    ) : (
                        // Empty state is deliberate: a route only enters this
                        // library after the skipper saves it, never as a
                        // placeholder passage.
                        <div className="crew-card flex items-center gap-3 px-3.5 py-3">
                            <span aria-hidden="true" className="crew-tile-icon">
                                <RouteGlyph />
                            </span>
                            <div className="min-w-0">
                                <p className="text-xs font-semibold text-white">
                                    {emptyTitle ?? 'No saved routes yet'}
                                </p>
                                <p className="crew-card-sub mt-0.5">
                                    {emptyHint ?? 'Plan a route from the Plan tab; saved routes will appear here.'}
                                </p>
                            </div>
                        </div>
                    )}
                    <p className="crew-muted mt-1.5 px-1 text-[11px] font-semibold">{count}</p>
                </>
            )}
        </div>
    );
};
