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
import React from 'react';
import { Section, type SettingsTabProps } from './SettingsPrimitives';
import { MapPinIcon, TrashIcon } from '../Icons';
import { buildRemoveLocationPatch } from '../../utils/savedLocations';

interface LocationsTabProps extends SettingsTabProps {
    onLocationSelect: (location: string) => void;
}

export const LocationsTab: React.FC<LocationsTabProps> = ({ settings, onSave, onLocationSelect }) => (
    <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
        <Section title="Saved Ports & Anchorages">
            <div className="flex flex-col gap-2 p-2">
                {(settings.savedLocations || []).length === 0 && (
                    <div className="text-center py-8 text-gray-400">
                        <MapPinIcon className="w-8 h-8 mx-auto mb-2 opacity-50" />
                        <p className="text-sm font-bold text-gray-300">No saved locations</p>
                        <p className="text-xs mt-1">
                            Search for a port on the weather page or save a departure / destination from the route
                            planner to add it here.
                        </p>
                    </div>
                )}
                {(settings.savedLocations || []).map((loc, i) => {
                    const coords = settings.savedLocationCoords?.[loc];
                    return (
                        <div
                            key={i}
                            className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-xl group hover:bg-white/10 transition-colors"
                        >
                            <div
                                className="flex items-center gap-4 flex-1 cursor-pointer min-w-0"
                                onClick={() => onLocationSelect(loc)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => e.key === 'Enter' && onLocationSelect(loc)}
                                aria-label={`Navigate to ${loc}`}
                            >
                                <div className="p-2 rounded-full bg-sky-500/20 text-sky-400 shrink-0">
                                    <MapPinIcon className="w-5 h-5" />
                                </div>
                                <div className="min-w-0">
                                    <div className="font-bold text-white text-sm truncate">{loc}</div>
                                    {coords && (
                                        <div className="text-[10px] font-mono text-sky-300/70 mt-0.5">
                                            {coords.lat.toFixed(4)}°{coords.lat >= 0 ? 'N' : 'S'} ·{' '}
                                            {coords.lon.toFixed(4)}°{coords.lon >= 0 ? 'E' : 'W'}
                                        </div>
                                    )}
                                </div>
                            </div>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onSave(
                                        buildRemoveLocationPatch(
                                            settings.savedLocations,
                                            settings.savedLocationCoords,
                                            loc,
                                        ),
                                    );
                                }}
                                className="p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0 ml-2"
                                aria-label={`Remove ${loc}`}
                            >
                                <TrashIcon className="w-5 h-5" />
                            </button>
                        </div>
                    );
                })}
            </div>
        </Section>
    </div>
);
