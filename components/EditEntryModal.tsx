/**
 * Edit Entry Modal - Edit existing log entries
 */

import React, { useState, useEffect } from 'react';
import { ShipLogEntry } from '../types';
import { useFocusTrap } from '../hooks/useAccessibility';

interface EditEntryModalProps {
    isOpen: boolean;
    entry: ShipLogEntry | null;
    onClose: () => void;
    onSave: (entryId: string, updates: { notes?: string; waypointName?: string }) => void;
}

export const EditEntryModal: React.FC<EditEntryModalProps> = ({ isOpen, entry, onClose, onSave }) => {
    const [notes, setNotes] = useState('');
    const [waypointName, setWaypointName] = useState('');
    const [saving, setSaving] = useState(false);

    // Reset form when entry changes
    useEffect(() => {
        if (entry) {
            setNotes(entry.notes || '');
            setWaypointName(entry.waypointName || '');
        }
    }, [entry]);

    if (!isOpen || !entry) return null;

    const focusTrapRef = useFocusTrap(isOpen);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);

        onSave(entry.id, {
            notes: notes.trim() || undefined,
            waypointName: waypointName.trim() || undefined
        });

        setSaving(false);
        onClose();
    };

    const timestamp = new Date(entry.timestamp);
    const timeStr = timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const dateStr = timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    return (
        <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="edit-entry-title" ref={focusTrapRef}>
            <div className="bg-slate-900 border border-white/20 rounded-t-2xl sm:rounded-2xl p-4 w-full sm:max-w-md sm:mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="flex justify-between items-start mb-4">
                    <div>
                        <h2 id="edit-entry-title" className="text-xl font-bold text-white">Edit Entry</h2>
                        <div className="text-xs text-slate-400 mt-1 flex items-center gap-2">
                            <span className="font-mono">{timeStr}</span>
                            <span>•</span>
                            <span>{dateStr}</span>
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
                    {/* Waypoint Name (if waypoint entry) */}
                    {entry.entryType === 'waypoint' && (
                        <div>
                            <label className="block text-sm text-slate-300 mb-2">Waypoint Name</label>
                            <input
                                type="text"
                                value={waypointName}
                                onChange={(e) => setWaypointName(e.target.value)}
                                placeholder="e.g., Cape Moreton"
                                className="w-full px-4 py-3 bg-slate-800 border border-white/10 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                            />
                        </div>
                    )}

                    {/* Notes */}
                    <div>
                        <label className="block text-sm text-slate-300 mb-2">Notes</label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Add or edit notes..."
                            className="w-full px-4 py-3 bg-slate-800 border border-white/10 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 min-h-[100px] resize-none"
                        />
                    </div>

                    {/* Position Info (read-only) */}
                    <div className="bg-slate-800/50 rounded-lg p-3 text-xs text-slate-400">
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <span className="text-slate-500">Position:</span>
                                <span className="ml-1 text-white font-mono">{entry.positionFormatted}</span>
                            </div>
                            {entry.speedKts !== undefined && (
                                <div>
                                    <span className="text-slate-500">Speed:</span>
                                    <span className="ml-1 text-white">{entry.speedKts.toFixed(1)} kts</span>
                                </div>
                            )}
                        </div>
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
                            className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold transition-colors disabled:opacity-50"
                            disabled={saving}
                        >
                            {saving ? 'Saving...' : 'Save Changes'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
