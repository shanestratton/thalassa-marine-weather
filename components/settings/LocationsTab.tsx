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
import { RowChevron, Section, type SettingsTabProps } from './SettingsPrimitives';
import { MapPinIcon, PartlyCloudyIcon, TrashIcon } from '../Icons';
import { buildRemoveLocationPatch } from '../../utils/savedLocations';
import { UndoToast } from '../ui/UndoToast';

interface LocationsTabProps extends SettingsTabProps {
    onLocationSelect: (location: string) => void;
}

/** Goes to a tab the way the tab bar does (App's 'thalassa:navigate'). */
const openTab = (tab: 'dashboard' | 'voyage') =>
    window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab } }));

/**
 * The two places a port is saved from, as buttons that go there: the hint
 * named them and linked to neither, so the page was a soft dead end (UX
 * scorecard run 10). Each goes to that tab, exactly as the tab bar would.
 * Each name starts with the words printed on the button.
 */
const AddFrom: React.FC = () => (
    <div className="flex gap-2 px-4 pb-4">
        <button
            type="button"
            onClick={() => openTab('dashboard')}
            aria-label="The Glass: save a port from its star menu"
            className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 text-sm font-bold text-white hover:bg-white/10"
        >
            The Glass
            <RowChevron className="h-3.5 w-3.5 text-gray-400" />
        </button>
        <button
            type="button"
            onClick={() => openTab('voyage')}
            aria-label="Route planner: save a departure or destination"
            className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 text-sm font-bold text-white hover:bg-white/10"
        >
            Route planner
            <RowChevron className="h-3.5 w-3.5 text-gray-400" />
        </button>
    </div>
);

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
                {/* 'Saved places', not a third 'ports & anchorages' under the
                    page's own subtitle (UX scorecard run 10). */}
                <Section title="Saved places">
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
                    {(settings.savedLocations || []).length === 0 && <AddFrom />}
                    {/* Flat rows in the section card (no card-in-card), each a real
                        button. "Show weather for", not "Navigate to": in a marine
                        app that reads as plotting a route. It ends in a weather
                        glyph and 'Show', not a chevron, because the tap leaves
                        Settings for The Glass rather than opening a detail page;
                        and a divider plus a gap keep it clear of Remove at the
                        thumb edge (UX scorecard run 7). */}
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
                                    className="flex flex-1 min-w-0 min-h-11 items-center gap-3 py-3 pl-4 pr-4 text-left"
                                >
                                    <span className="p-2 rounded-full bg-sky-500/20 text-sky-400 shrink-0">
                                        <MapPinIcon className="w-5 h-5" />
                                    </span>
                                    {/* The name gets the whole line; the Default port chip
                                        sits under it, so the name is never cut short by it. */}
                                    <span className="block min-w-0 flex-1">
                                        <span className="block font-bold text-white text-sm wrap-break-word">
                                            {loc}
                                        </span>
                                        {(isDefault || coords) && (
                                            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                                                {isDefault && (
                                                    <span className="shrink-0 rounded-full border border-sky-400/30 bg-sky-500/10 px-2 py-0.5 text-xs font-bold text-sky-200">
                                                        Default port
                                                    </span>
                                                )}
                                                {coords && (
                                                    <span className="text-xs font-mono text-sky-300/70">
                                                        {coords.lat.toFixed(4)}°{coords.lat >= 0 ? 'N' : 'S'} ·{' '}
                                                        {coords.lon.toFixed(4)}°{coords.lon >= 0 ? 'E' : 'W'}
                                                    </span>
                                                )}
                                            </span>
                                        )}
                                    </span>
                                    {/* Says what the tap shows, not a bare 'Show' (UX
                                        scorecard run 10); one word, so the place name
                                        keeps its line at 375 pt. */}
                                    <span
                                        aria-hidden="true"
                                        className="inline-flex shrink-0 items-center gap-1.5 text-xs font-bold text-sky-300"
                                    >
                                        <PartlyCloudyIcon className="h-4 w-4" />
                                        Weather
                                    </span>
                                </button>
                                <span
                                    aria-hidden="true"
                                    className="w-px self-stretch my-3 shrink-0 bg-white/10 [.display-light_&]:bg-slate-300"
                                />
                                <button
                                    type="button"
                                    onClick={() => removeLocation(loc)}
                                    className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0 mx-3"
                                    aria-label={`Remove ${loc}`}
                                >
                                    <TrashIcon className="w-5 h-5" />
                                </button>
                            </div>
                        );
                    })}
                    {(settings.savedLocations || []).length > 0 && (
                        <div>
                            <p className="px-4 pt-3 pb-2 text-xs leading-snug text-gray-400">
                                Add more from the ★ menu on The Glass, or by saving a departure or destination in the
                                route planner.
                            </p>
                            <AddFrom />
                        </div>
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
