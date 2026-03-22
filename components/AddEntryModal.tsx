/**
 * Manual Entry Modal - Add custom deck log entries
 * IMO-compliant with event categories and watch period display
 */

import React, { useState } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('AddEntryModal');
import { ShipLogService } from '../services/ShipLogService';
import { formatTime24Colon, getWatchPeriod, getWatchPeriodName } from '../utils/marineFormatters';
import { useFocusTrap } from '../hooks/useAccessibility';
import { LocalMaintenanceService } from '../services/vessel/LocalMaintenanceService';
import { GpsService } from '../services/GpsService';
import { toast } from './Toast';
import { scrollInputAboveKeyboard } from '../utils/keyboardScroll';

// Event category type for type safety
type EventCategory =
    | 'navigation'
    | 'weather'
    | 'equipment'
    | 'crew'
    | 'arrival'
    | 'departure'
    | 'safety'
    | 'observation';

// Event categories with icons and descriptions
const EVENT_CATEGORIES: { value: EventCategory; label: string; icon: string }[] = [
    { value: 'observation', label: 'General', icon: '👁️' },
    { value: 'navigation', label: 'Navigation', icon: '🧭' },
    { value: 'weather', label: 'Weather', icon: '🌤️' },
    { value: 'arrival', label: 'Arrival', icon: '⚓' },
    { value: 'departure', label: 'Departure', icon: '🚢' },
    { value: 'equipment', label: 'Repair', icon: '🔧' },
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
    const [fetchingPos, setFetchingPos] = useState(false);
    const [listening, setListening] = useState(false);
    const [polishing, setPolishing] = useState(false);

    // Current watch info
    const now = new Date();
    const currentTime = formatTime24Colon(now);
    const currentWatch = getWatchPeriod(now.getHours());

    // MUST be called before any early returns (Rules of Hooks)
    const focusTrapRef = useFocusTrap(isOpen);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!notes.trim() && !isWaypoint) {
            toast.error('Please enter notes or create a waypoint');
            return;
        }

        if (isWaypoint && !waypointName.trim()) {
            toast.error('Please enter a waypoint name');
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
                selectedVoyageId || undefined, // Add to selected voyage if available
            );

            // Auto-create a Repair task in R&M when event type is Repair
            if (eventCategory === 'equipment' && trimmedNotes) {
                try {
                    await LocalMaintenanceService.createTask({
                        title: trimmedNotes.slice(0, 80), // Use notes as task title (truncated)
                        description: trimmedNotes.length > 80 ? trimmedNotes : null,
                        category: 'Repair',
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        trigger_type: 'monthly' as any, // Ad-hoc — no schedule enforced
                        interval_value: null,
                        next_due_date: null,
                        next_due_hours: null,
                        last_completed: null,
                        is_active: true,
                    });
                    toast.success('Repair task added to R&M');
                } catch (err) {
                    log.error('[AddEntry] Failed to create repair task:', err);
                }
            }

            setNotes('');
            setWaypointName('');
            setIsWaypoint(false);
            setEventCategory('observation');
            onSuccess();
            onClose();
        } catch (error) {
            toast.error('Failed to add entry. Please try again.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/80"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-entry-title"
            ref={focusTrapRef}
        >
            <div
                className="bg-slate-900 border-t border-x border-white/20 rounded-t-2xl p-4 w-full shadow-2xl h-[calc(100%-10px)] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header with Watch Info */}
                <div className="flex justify-between items-start mb-4">
                    <div>
                        <h2 id="add-entry-title" className="text-xl font-bold text-white">
                            Add Log Entry
                        </h2>
                        <div className="text-xs text-slate-400 mt-1 flex items-center gap-2">
                            <span className="font-mono">{currentTime}</span>
                            <span>•</span>
                            <span>{getWatchPeriodName(currentWatch)}</span>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-white transition-colors p-1"
                        aria-label="Close"
                    >
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                            />
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
                                    aria-label="Event Category"
                                    key={cat.value}
                                    type="button"
                                    onClick={() => setEventCategory(cat.value)}
                                    className={`p-2 rounded-lg border text-center transition-colors ${
                                        eventCategory === cat.value
                                            ? 'bg-sky-500/20 border-sky-500/50 text-sky-400'
                                            : 'bg-slate-800 border-white/10 text-slate-400 hover:border-white/20'
                                    }`}
                                >
                                    <div className="text-lg">{cat.icon}</div>
                                    <div className="text-[11px] mt-0.5 truncate">{cat.label}</div>
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
                            className="w-5 h-5 rounded border-slate-600 bg-slate-800 text-sky-600 focus:ring-2 focus:ring-sky-500"
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
                            onFocus={scrollInputAboveKeyboard}
                            placeholder="e.g., Cape Moreton, Fuel Stop"
                            disabled={!isWaypoint}
                            className={`w-full px-4 py-3 bg-slate-800 border border-white/10 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 ${!isWaypoint ? 'cursor-not-allowed' : ''}`}
                        />
                    </div>

                    {/* Notes */}
                    <div>
                        <label className="block text-sm text-slate-300 mb-2">Notes {!isWaypoint && '*'}</label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            onFocus={scrollInputAboveKeyboard}
                            placeholder="e.g., Course change, Crew rotation, Equipment issue"
                            className="w-full px-4 py-3 bg-slate-800 border border-white/10 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 min-h-[80px] resize-none"
                        />
                    </div>

                    {/* Position | Voice | Polish — 3-column toolbar */}
                    <div className="flex gap-2">
                        {/* Position — 2/3 width */}
                        <button
                            aria-label="Fetching Pos"
                            type="button"
                            disabled={fetchingPos}
                            onClick={async () => {
                                setFetchingPos(true);
                                try {
                                    const pos = await GpsService.getCurrentPosition({
                                        staleLimitMs: 30_000,
                                        timeoutSec: 10,
                                    });
                                    if (!pos) throw new Error('No position');
                                    const lat = pos.latitude;
                                    const lon = pos.longitude;
                                    const latDir = lat >= 0 ? 'N' : 'S';
                                    const lonDir = lon >= 0 ? 'E' : 'W';
                                    const coordStr = `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
                                    setNotes((prev) =>
                                        prev ? `${prev}\nPosition: ${coordStr}` : `Position: ${coordStr}`,
                                    );
                                    toast.success('Position added');
                                } catch (e) {
                                    toast.error('Could not get position');
                                } finally {
                                    setFetchingPos(false);
                                }
                            }}
                            className="flex-[2] flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-800 border border-white/10 rounded-lg text-sm font-bold transition-colors hover:bg-slate-700 active:scale-[0.97] disabled:opacity-50"
                        >
                            {fetchingPos ? (
                                <div className="w-4 h-4 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                            ) : (
                                <svg
                                    className="w-4 h-4 text-sky-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
                                    />
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                                    />
                                </svg>
                            )}
                            <span className="text-sky-400">Position</span>
                        </button>

                        {/* Voice — 1/6 width */}
                        <button
                            aria-label="SR"
                            type="button"
                            onClick={() => {
                                const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
                                if (!SR) {
                                    toast.error('Speech recognition not supported');
                                    return;
                                }
                                if (listening) return;
                                const recognition = new SR();
                                recognition.lang = 'en-AU';
                                recognition.interimResults = false;
                                recognition.maxAlternatives = 1;
                                recognition.continuous = false;
                                setListening(true);
                                recognition.onresult = (event: {
                                    results: { length: number; 0: { 0: { transcript: string } } };
                                }) => {
                                    const transcript = event.results[0][0].transcript;
                                    setNotes((prev) => (prev ? `${prev} ${transcript}` : transcript));
                                    toast.success('Voice captured');
                                };
                                recognition.onerror = () => {
                                    toast.error('Voice capture failed');
                                };
                                recognition.onend = () => setListening(false);
                                recognition.start();
                            }}
                            className={`flex-1 flex items-center justify-center px-2 py-2.5 border rounded-lg text-sm font-bold transition-colors active:scale-[0.97] ${
                                listening
                                    ? 'bg-red-500/20 border-red-500/30 text-red-400 animate-pulse'
                                    : 'bg-slate-800 border-white/10 text-amber-400 hover:bg-slate-700'
                            }`}
                        >
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
                                />
                            </svg>
                        </button>

                        {/* Polish — 1/6 width */}
                        <button
                            aria-label="Polishing"
                            type="button"
                            disabled={polishing || !notes.trim()}
                            onClick={() => {
                                if (!notes.trim()) return;
                                setPolishing(true);
                                try {
                                    // Simple client-side polish: capitalise sentences, fix spacing
                                    let polished = notes.trim();
                                    // Capitalise first letter of each sentence
                                    polished = polished.replace(
                                        /(^|[.!?]\s+)([a-z])/g,
                                        (_, prefix, letter) => prefix + letter.toUpperCase(),
                                    );
                                    // Capitalise first character overall
                                    polished = polished.charAt(0).toUpperCase() + polished.slice(1);
                                    // Clean up multiple spaces
                                    polished = polished.replace(/ {2,}/g, ' ');
                                    // Ensure ends with full stop
                                    if (!/[.!?]$/.test(polished)) polished += '.';
                                    setNotes(polished);
                                    toast.success('Notes polished');
                                } finally {
                                    setPolishing(false);
                                }
                            }}
                            className="flex-1 flex items-center justify-center px-2 py-2.5 bg-slate-800 border border-white/10 rounded-lg text-sm font-bold text-emerald-400 transition-colors hover:bg-slate-700 active:scale-[0.97] disabled:opacity-30"
                        >
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
                                />
                            </svg>
                        </button>
                    </div>

                    {/* Buttons */}
                    <div className="flex gap-3 pt-2">
                        <button
                            aria-label="Close"
                            type="button"
                            onClick={onClose}
                            className="flex-1 px-4 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-bold transition-colors"
                            disabled={saving}
                        >
                            Cancel
                        </button>
                        <button
                            aria-label="Save"
                            type="submit"
                            className="flex-1 px-4 py-3 bg-sky-600 hover:bg-sky-700 text-white rounded-lg font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
