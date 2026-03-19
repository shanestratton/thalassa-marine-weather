/**
 * LocationsTab — Saved ports & anchorages management.
 * Extracted from SettingsModal to reduce component size.
 */
import React from 'react';
import { Section, type SettingsTabProps } from './SettingsPrimitives';
import { MapPinIcon, TrashIcon } from '../Icons';

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
                        <p className="text-xs mt-1">Search for a port on the weather page to save it here.</p>
                    </div>
                )}
                {(settings.savedLocations || []).map((loc, i) => (
                    <div
                        key={i}
                        className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-xl group hover:bg-white/10 transition-colors"
                    >
                        <div
                            className="flex items-center gap-4 flex-1 cursor-pointer"
                            onClick={() => onLocationSelect(loc)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === 'Enter' && onLocationSelect(loc)}
                            aria-label={`Navigate to ${loc}`}
                        >
                            <div className="p-2 rounded-full bg-sky-500/20 text-sky-400">
                                <MapPinIcon className="w-5 h-5" />
                            </div>
                            <span className="font-bold text-white text-sm">{loc}</span>
                        </div>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onSave({
                                    savedLocations: settings.savedLocations.filter((l) => l !== loc),
                                });
                            }}
                            className="p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            aria-label={`Remove ${loc}`}
                        >
                            <TrashIcon className="w-5 h-5" />
                        </button>
                    </div>
                ))}
            </div>
        </Section>
    </div>
);
