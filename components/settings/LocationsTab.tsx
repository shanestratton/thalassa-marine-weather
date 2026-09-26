/**
 * LocationsTab — Saved ports & anchorages management.
 * Extracted from SettingsModal to reduce component size.
 *
 * Entries are name-strings in `settings.savedLocations`. Locations
 * saved via the route planner (map pick / GPS / "★ Save") also have
 * an entry in `settings.savedLocationCoords` keyed by the same name,
 * so the route planner can hydrate exact coords on recall. Entries
 * without coords still render and re-geocode at planner time.
 */
import React, { useState } from 'react';
import { Section, RowChevron, type SettingsTabProps } from './SettingsPrimitives';
import { MapPinIcon, TrashIcon } from '../Icons';
import { buildRemoveLocationPatch } from '../../utils/savedLocations';
import { UndoToast } from '../ui/UndoToast';

interface LocationsTabProps extends SettingsTabProps {
    onLocationSelect: (location: string) => void;
}

export const LocationsTab: React.FC<LocationsTabProps> = ({ settings, onSave, onLocationSelect }) => {
    // A hand-saved port must not vanish on one unguarded tap. The removal is
    // immediate, but the toast keeps the snapshot to put back (Shane
    // 2026-09-26: the smaller state items were my call).
    const [removed, setRemoved] = useState<{
        name: string;
        savedLocations: string[];
        savedLocationCoords: Record<string, { lat: number; lon: number }>;
    } | null>(null);
    const removeLocation = (loc: string) => {
        setRemoved({
            name: loc,
            savedLocations: [...(settings.savedLocations || [])],
            savedLocationCoords: { ...(settings.savedLocationCoords || {}) },
        });
        onSave(buildRemoveLocationPatch(settings.savedLocations, settings.savedLocationCoords, loc));
    };
    // The Default Port (Preferences) is a free-text name; match it loosely.
    const defaultPort = settings.defaultLocation?.trim().toLowerCase() || '';
    const undoRemove = () => {
        if (!removed) return;
        onSave({ savedLocations: removed.savedLocations, savedLocationCoords: removed.savedLocationCoords });
        setRemoved(null);
    };
    return (
        <>
            <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
                <Section title="Saved Ports & Anchorages">
                    {(settings.savedLocations || []).length === 0 && (
                        <div className="text-center px-4 py-8 text-gray-400">
                            <MapPinIcon className="w-8 h-8 mx-auto mb-2 opacity-50" />
                            <p className="text-sm font-bold text-gray-300">No saved locations</p>
                            {/* "The Glass", not "the weather page" — that is what
                                the tab is called. Ports are saved from its ★ menu. */}
                            <p className="text-xs mt-1">
                                Save a port from the ★ menu on The Glass, or save a departure or destination in the
                                route planner, to add it here.
                            </p>
                        </div>
                    )}
                    {/* Flat rows in the section card (no card-in-card), each a real
                        button with a chevron like every other settings row that
                        opens something. "Show weather for", not "Navigate to":
                        in a marine app that reads as plotting a route. */}
                    {(settings.savedLocations || []).map((loc, i) => {
                        const coords = settings.savedLocationCoords?.[loc];
                        const isDefault = !!defaultPort && loc.trim().toLowerCase() === defaultPort;
                        return (
                            <div
                                key={i}
                                className="flex items-center border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors"
                            >
                                <button
                                    type="button"
                                    onClick={() => onLocationSelect(loc)}
                                    aria-label={`Show weather for ${loc}${isDefault ? ', default port' : ''}`}
                                    className="flex flex-1 min-w-0 min-h-11 items-center gap-3 py-3 pl-4 pr-2 text-left"
                                >
                                    <span className="p-2 rounded-full bg-sky-500/20 text-sky-400 shrink-0">
                                        <MapPinIcon className="w-5 h-5" />
                                    </span>
                                    <span className="block min-w-0 flex-1">
                                        <span className="flex min-w-0 items-center gap-2">
                                            <span className="font-bold text-white text-sm truncate">{loc}</span>
                                            {isDefault && (
                                                <span className="shrink-0 rounded-full border border-sky-400/30 bg-sky-500/10 px-2 py-0.5 text-xs font-bold text-sky-200">
                                                    Default port
                                                </span>
                                            )}
                                        </span>
                                        {coords && (
                                            <span className="block text-xs font-mono text-sky-300/70 mt-0.5">
                                                {coords.lat.toFixed(4)}°{coords.lat >= 0 ? 'N' : 'S'} ·{' '}
                                                {coords.lon.toFixed(4)}°{coords.lon >= 0 ? 'E' : 'W'}
                                            </span>
                                        )}
                                    </span>
                                    <RowChevron />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => removeLocation(loc)}
                                    className="hit-target-44 p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0 mr-2"
                                    aria-label={`Remove ${loc}`}
                                >
                                    <TrashIcon className="w-5 h-5" />
                                </button>
                            </div>
                        );
                    })}
                    {(settings.savedLocations || []).length > 0 && (
                        <p className="px-4 py-3 text-xs leading-snug text-gray-400">
                            Add more from the ★ menu on The Glass, or by saving a departure or destination in the route
                            planner.
                        </p>
                    )}
                </Section>
            </div>
            <UndoToast
                isOpen={!!removed}
                message={`Removed ${removed?.name ?? ''}`}
                onUndo={undoRemove}
                onDismiss={() => setRemoved(null)}
            />
        </>
    );
};
