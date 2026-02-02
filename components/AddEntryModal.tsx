/**
 * Manual Entry Modal - Add custom log entries
 * For waypoints, notes, and manual observations
 */

import React, { useState } from 'react';
import { ShipLogService } from '../services/ShipLogService';

interface AddEntryModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

export const AddEntryModal: React.FC<AddEntryModalProps> = ({ isOpen, onClose, onSuccess }) => {
    const [notes, setNotes] = useState('');
    const [waypointName, setWaypointName] = useState('');
    const [isWaypoint, setIsWaypoint] = useState(false);
    const [saving, setSaving] = useState(false);

    if (!isOpen) return null;

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
                trimmedWaypoint
            );

            setNotes('');
            setWaypointName('');
            setIsWaypoint(false);
            onSuccess();
            onClose();
        } catch (error) {
            alert('Failed to add entry. Check console for details.');
            console.error('Error adding manual entry:', error);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-slate-900 border border-white/20 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-bold text-white">Add Log Entry</h2>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-white transition-colors"
                    >
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="space-y-4">
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

                    {/* Waypoint Name (conditional) */}
                    {isWaypoint && (
                        <div>
                            <label className="block text-sm text-slate-300 mb-2">Waypoint Name *</label>
                            <input
                                type="text"
                                value={waypointName}
                                onChange={(e) => setWaypointName(e.target.value)}
                                placeholder="e.g., Cape Moreton, Fuel Stop, Reef Entrance"
                                className="w-full px-4 py-3 bg-slate-800 border border-white/10 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                                autoFocus
                            />
                        </div>
                    )}

                    {/* Notes */}
                    <div>
                        <label className="block text-sm text-slate-300 mb-2">
                            Notes {!isWaypoint && '*'}
                        </label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="e.g., Changed course due to weather, Crew rotation, Equipment maintenance"
                            className="w-full px-4 py-3 bg-slate-800 border border-white/10 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 min-h-[120px] resize-none"
                            autoFocus={!isWaypoint}
                        />
                    </div>

                    {/* Info Box */}
                    <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-300">
                        📍 Current GPS position, speed, course, and weather will be captured automatically
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
