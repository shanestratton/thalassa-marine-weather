/**
 * Manual Entry Modal - Add custom deck log entries
 * IMO-compliant with event categories and watch period display
 */

import React, { useState } from 'react';
import { ShipLogService } from '../services/ShipLogService';
import { formatTime24Colon, getWatchPeriod, getWatchPeriodName } from '../utils/marineFormatters';
import { useFocusTrap } from '../hooks/useAccessibility';

// Event category type for type safety
type EventCategory = 'navigation' | 'weather' | 'equipment' | 'crew' | 'arrival' | 'departure' | 'safety' | 'observation';

// Event categories with icons and descriptions
const EVENT_CATEGORIES: { value: EventCategory; label: string; icon: string }[] = [
    { value: 'observation', label: 'General', icon: '👁️' },
    { value: 'navigation', label: 'Navigation', icon: '🧭' },
    { value: 'weather', label: 'Weather', icon: '🌤️' },
    { value: 'arrival', label: 'Arrival', icon: '⚓' },
    { value: 'departure', label: 'Departure', icon: '🚢' },
    { value: 'equipment', label: 'Equipment', icon: '🔧' },
    { value: 'crew', label: 'Crew', icon: '👥' },
    { value: 'safety', label: 'Safety', icon: '🛟' },
];

interface AddEntryModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
    selectedVoyageId?: string | null;
}

export const AddEntryModal: React.FC<AddEntryModalProps> = ({ isOpen, onClose, onSuccess, selectedVoyageId }) => {
    const [notes, setNotes] = useState('');
    const [waypointName, setWaypointName] = useState('');
    const [isWaypoint, setIsWaypoint] = useState(false);
    const [eventCategory, setEventCategory] = useState<EventCategory>('observation');
    const [saving, setSaving] = useState(false);

    // Current watch info
    const now = new Date();
    const currentTime = formatTime24Colon(now);
    const currentWatch = getWatchPeriod(now.getHours());

    if (!isOpen) return null;

    const focusTrapRef = useFocusTrap(isOpen);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!notes.trim() && !isWaypoint) {
            alert('Please enter notes or create a waypoint');
            return;
        }

        if (isWaypoint && !waypointName.trim()) {
            alert('Please enter a waypoint name');
            return;
        }

        setSaving(true);
        try {
            const trimmedNotes = notes.trim();
            const trimmedWaypoint = isWaypoint ? waypointName.trim() : undefined;

            await ShipLogService.addManualEntry(
                trimmedNotes || undefined,
                trimmedWaypoint,
                eventCategory,
                undefined, // engineStatus
                selectedVoyageId || undefined // Add to selected voyage if available
            );

            setNotes('');
            setWaypointName('');
            setIsWaypoint(false);
            setEventCategory('observation');
            onSuccess();
            onClose();
        } catch (error) {
            alert('Failed to add entry. Please try again.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/80 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="add-entry-title" ref={focusTrapRef}>
            <div className="bg-slate-900 border-t border-x border-white/20 rounded-t-2xl p-4 w-full shadow-2xl h-[calc(100%-10px)] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                {/* Header with Watch Info */}
                <div className="flex justify-between items-start mb-4">
                    <div>
                        <h2 id="add-entry-title" className="text-xl font-bold text-white">Add Log Entry</h2>
                        <div className="text-xs text-slate-400 mt-1 flex items-center gap-2">
                            <span className="font-mono">{currentTime}</span>
                            <span>•</span>
                            <span>{getWatchPeriodName(currentWatch)}</span>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-white transition-colors p-1"
                    >
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="space-y-4">
                    {/* Event Category Selector */}
                    <div>
                        <label className="block text-sm text-slate-300 mb-2">Event Type</label>
                        <div className="grid grid-cols-4 gap-2">
                            {EVENT_CATEGORIES.map((cat) => (
                                <button
                                    key={cat.value}
                                    type="button"
                                    onClick={() => setEventCategory(cat.value)}
                                    className={`p-2 rounded-lg border text-center transition-colors ${eventCategory === cat.value
                                        ? 'bg-sky-500/20 border-sky-500/50 text-sky-400'
                                        : 'bg-slate-800 border-white/10 text-slate-400 hover:border-white/20'
                                        }`}
                                >
                                    <div className="text-lg">{cat.icon}</div>
                                    <div className="text-[9px] mt-0.5 truncate">{cat.label}</div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Waypoint Toggle */}
                    <div className="flex items-center gap-3">
                        <input
                            type="checkbox"
                            id="waypoint-toggle"
                            checked={isWaypoint}
                            onChange={(e) => setIsWaypoint(e.target.checked)}
                            className="w-5 h-5 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-2 focus:ring-blue-500"
                        />
                        <label htmlFor="waypoint-toggle" className="text-white font-medium cursor-pointer">
                            Mark as Waypoint
                        </label>
                    </div>

                    {/* Waypoint Name - Always visible, disabled when not waypoint */}
                    <div className={isWaypoint ? '' : 'opacity-40'}>
                        <label className="block text-sm text-slate-300 mb-2">Waypoint Name {isWaypoint && '*'}</label>
                        <input
                            type="text"
                            value={waypointName}
                            onChange={(e) => setWaypointName(e.target.value)}
                            placeholder="e.g., Cape Moreton, Fuel Stop"
                            disabled={!isWaypoint}
                            className={`w-full px-4 py-3 bg-slate-800 border border-white/10 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 ${!isWaypoint ? 'cursor-not-allowed' : ''}`}
                        />
                    </div>

                    {/* Notes */}
                    <div>
                        <label className="block text-sm text-slate-300 mb-2">
                            Notes {!isWaypoint && '*'}
                        </label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="e.g., Course change, Crew rotation, Equipment issue"
                            className="w-full px-4 py-3 bg-slate-800 border border-white/10 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 min-h-[80px] resize-none"
                        />
                    </div>

                    {/* Buttons */}
                    <div className="flex gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 px-4 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-bold transition-colors"
                            disabled={saving}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            disabled={saving}
                        >
                            {saving ? 'Adding...' : 'Add Entry'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
