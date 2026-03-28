/**
 * CastOffPanel — Manual voyage activation flow.
 *
 * Three-step process:
 *  1. Select Draft Voyage from list
 *  2. Pre-Departure Summary (crew, stores, weather)
 *  3. Safety Confirm toggle + CAST OFF button
 *
 * State protection: blocks if another voyage is already ACTIVE.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
    getDraftVoyages,
    getActiveVoyage,
    castOff,
    endVoyage,
    createVoyage,
    type Voyage,
} from '../../services/VoyageService';
import { getActiveLeg, getLegsForVoyage, closeLeg, startLeg, getLegSummary } from '../../services/VoyageLegService';
import type { PassageLeg } from '../../types/navigation';
import { triggerHaptic } from '../../utils/system';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import { ChatService } from '../../services/ChatService';

interface CastOffPanelProps {
    onCastOff?: (voyage: Voyage) => void;
    onClose: () => void;
    onNavigateToGalley?: () => void;
}

type Step = 'select' | 'create' | 'preflight' | 'track_prompt' | 'active' | 'arrive' | 'depart_leg';

export const CastOffPanel: React.FC<CastOffPanelProps> = ({ onCastOff, onClose, onNavigateToGalley }) => {
    const [step, setStep] = useState<Step>('select');
    const [drafts, setDrafts] = useState<Voyage[]>([]);
    const [selected, setSelected] = useState<Voyage | null>(null);
    const [activeVoyage, setActiveVoyage] = useState<Voyage | null>(null);
    const [loading, setLoading] = useState(true);
    const [casting, setCasting] = useState(false);
    const [error, setError] = useState('');
    const [safetyConfirmed, setSafetyConfirmed] = useState(false);

    // Pre-departure checklist state
    const [crewReady, setCrewReady] = useState(false);
    const [storesCleared, setStoresCleared] = useState(false);
    const [weatherChecked, setWeatherChecked] = useState(false);

    // Quick-create state
    const [newName, setNewName] = useState('');
    const [newFrom, setNewFrom] = useState('');
    const [newTo, setNewTo] = useState('');
    const [newCrew, setNewCrew] = useState(2);
    const [creating, setCreating] = useState(false);

    // Passage legs state
    const [currentLeg, setCurrentLeg] = useState<PassageLeg | null>(null);
    const [completedLegs, setCompletedLegs] = useState<PassageLeg[]>([]);
    const [arrivalPort, setArrivalPort] = useState('');

    // Load drafts + check active
    useEffect(() => {
        const load = async () => {
            setLoading(true);
            const [d, active] = await Promise.all([getDraftVoyages(), getActiveVoyage()]);
            setDrafts(d);
            if (active) {
                setActiveVoyage(active);
                setStep('active');
                // Load leg state
                const activeLeg = getActiveLeg(active.id);
                setCurrentLeg(activeLeg);
                const allLegs = getLegsForVoyage(active.id).filter((l) => l.status === 'completed');
                setCompletedLegs(allLegs);
            }
            setLoading(false);
        };
        load();
    }, []);

    const handleSelect = useCallback((voyage: Voyage) => {
        setSelected(voyage);
        setStep('preflight');
        setSafetyConfirmed(false);
        setCrewReady(false);
        setStoresCleared(false);
        setWeatherChecked(false);
        triggerHaptic('light');

        // Fire-and-forget: create private voyage channel for planning
        ChatService.createVoyageChannel(voyage.id, voyage.voyage_name).catch(() => {
            /* non-critical — channel can be created later */
        });
    }, []);

    const handleCreateVoyage = useCallback(async () => {
        if (!newName.trim()) return;
        setCreating(true);
        setError('');
        try {
            const result = await createVoyage({
                voyage_name: newName.trim(),
                departure_port: newFrom.trim() || null,
                destination_port: newTo.trim() || null,
                crew_count: newCrew,
            });
            if (result.voyage) {
                setDrafts((prev) => [...prev, result.voyage!]);
                setStep('select');
                setNewName('');
                setNewFrom('');
                setNewTo('');
                setNewCrew(2);
                triggerHaptic('medium');
            } else {
                setError(result.error || 'Failed to create voyage');
            }
        } catch (e) {
            console.warn('Suppressed:', e);
            setError('Failed to create voyage');
        }
        setCreating(false);
    }, [newName, newFrom, newTo, newCrew]);

    const handleCastOff = useCallback(async () => {
        if (!selected || !safetyConfirmed) return;
        setCasting(true);
        setError('');
        triggerHaptic('heavy');

        const result = await castOff(selected.id);
        if (result.ok && result.voyage) {
            setActiveVoyage(result.voyage);
            setStep('track_prompt'); // Ask about track logging before going to active
            onCastOff?.(result.voyage);
        } else {
            setError(result.error || 'Cast off failed');
        }
        setCasting(false);
    }, [selected, safetyConfirmed, onCastOff]);

    const handleStartTracking = useCallback(async () => {
        triggerHaptic('medium');
        try {
            const { ShipLogService } = await import('../../services/ShipLogService');
            await ShipLogService.startTracking(false);
        } catch (e) {
            /* best effort — tracking can be started manually */
        }
        setStep('active');
    }, []);

    const handleEndVoyage = useCallback(async () => {
        if (!activeVoyage) return;
        triggerHaptic('medium');
        await endVoyage(activeVoyage.id, 'completed');
        setActiveVoyage(null);
        setCurrentLeg(null);
        setCompletedLegs([]);
        setStep('select');
        // Reload drafts
        const d = await getDraftVoyages();
        setDrafts(d);
    }, [activeVoyage]);

    // ── Passage Leg Handlers ──

    const handleArriveAtPort = useCallback(() => {
        if (!activeVoyage || !currentLeg) return;
        triggerHaptic('light');
        setArrivalPort(activeVoyage.destination_port || '');
        setStep('arrive');
    }, [activeVoyage, currentLeg]);

    const handleConfirmArrival = useCallback(() => {
        if (!activeVoyage || !arrivalPort.trim()) return;
        triggerHaptic('medium');
        const closed = closeLeg(activeVoyage.id, arrivalPort.trim());
        if (closed) {
            setCompletedLegs((prev) => [...prev, closed]);
            setCurrentLeg(null);
            setStep('depart_leg');
        }
    }, [activeVoyage, arrivalPort]);

    const handleDepartNextLeg = useCallback(() => {
        if (!activeVoyage || !arrivalPort.trim()) return;
        triggerHaptic('heavy');
        // The departure port for the next leg = the arrival port of the previous leg
        const newLeg = startLeg(activeVoyage.id, arrivalPort.trim());
        setCurrentLeg(newLeg);
        setArrivalPort('');
        setStep('active');
    }, [activeVoyage, arrivalPort]);

    const handleSkipToActive = useCallback(() => {
        setArrivalPort('');
        setStep('active');
    }, []);

    return (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-stretch justify-center">
            <div className="w-full max-w-lg bg-[#0a0e14] overflow-y-auto pb-24" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between p-5 pb-3">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-amber-500/10">
                            <span className="text-xl">⛵</span>
                        </div>
                        <div>
                            <h2 className="text-base font-black text-white">
                                {step === 'active'
                                    ? 'Active Voyage'
                                    : step === 'track_prompt'
                                      ? 'Cast Off!'
                                      : step === 'preflight'
                                        ? 'Ready to Sail?'
                                        : step === 'create'
                                          ? 'New Voyage'
                                          : step === 'arrive'
                                            ? 'Port Arrival'
                                            : step === 'depart_leg'
                                              ? 'Next Leg'
                                              : 'Select Voyage'}
                            </h2>
                            <p className="text-[10px] text-amber-400/60 uppercase tracking-widest">
                                {step === 'active'
                                    ? 'Watch Mode'
                                    : step === 'track_prompt'
                                      ? 'Track Logging'
                                      : step === 'preflight'
                                        ? 'Pre-Departure Check'
                                        : step === 'create'
                                          ? 'Quick Create'
                                          : step === 'arrive'
                                            ? 'Passage Legs'
                                            : step === 'depart_leg'
                                              ? 'Passage Legs'
                                              : 'Draft Voyages'}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-9 h-9 rounded-full bg-white/5 text-gray-400 flex items-center justify-center hover:bg-white/10"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                {loading && (
                    <div className="p-10 text-center">
                        <div className="w-6 h-6 border-2 border-amber-400/30 rounded-full border-t-amber-400 animate-spin mx-auto" />
                        <p className="text-xs text-gray-500 mt-3">Loading voyages…</p>
                    </div>
                )}

                {/* ── Track Logging Prompt ── */}
                {step === 'track_prompt' && (
                    <div className="p-5 pt-2 space-y-4">
                        <div className="text-center py-4">
                            <div className="text-5xl mb-3">🛠️</div>
                            <h3 className="text-lg font-black text-white mb-1">Log This Track?</h3>
                            <p className="text-sm text-gray-400 max-w-xs mx-auto">
                                Start GPS track logging for this voyage. Your track will be saved to the Ship's Log.
                            </p>
                        </div>

                        <button
                            onClick={handleStartTracking}
                            className="w-full py-4 bg-gradient-to-r from-emerald-500 to-teal-500 rounded-xl text-base font-black text-black uppercase tracking-[0.15em] transition-all active:scale-[0.96] shadow-lg shadow-emerald-500/20"
                        >
                            📡 Yes — Start Logging
                        </button>

                        <button
                            onClick={() => setStep('active')}
                            className="w-full py-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                        >
                            Skip — I'll start later
                        </button>
                    </div>
                )}

                {/* ── Step 1: Active Voyage Warning ── */}
                {step === 'active' && activeVoyage && (
                    <div className="p-5 pt-2 space-y-4">
                        <div className="p-4 rounded-2xl bg-emerald-500/[0.06] border border-emerald-500/15 space-y-3">
                            <div className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                <span className="text-xs font-bold text-emerald-400 uppercase tracking-widest">
                                    Live
                                </span>
                                {currentLeg && (
                                    <span className="ml-auto px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-sky-500/10 text-sky-400 border border-sky-500/15">
                                        Leg {currentLeg.leg_number}
                                    </span>
                                )}
                            </div>
                            <h3 className="text-lg font-black text-white">{activeVoyage.voyage_name}</h3>
                            <div className="grid grid-cols-2 gap-2 text-[11px]">
                                {currentLeg ? (
                                    <div className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                                        <span className="text-gray-500">From</span>
                                        <p className="text-white font-bold">{currentLeg.departure_port}</p>
                                    </div>
                                ) : (
                                    activeVoyage.departure_port && (
                                        <div className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                                            <span className="text-gray-500">From</span>
                                            <p className="text-white font-bold">{activeVoyage.departure_port}</p>
                                        </div>
                                    )
                                )}
                                {activeVoyage.destination_port && (
                                    <div className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                                        <span className="text-gray-500">To</span>
                                        <p className="text-white font-bold">{activeVoyage.destination_port}</p>
                                    </div>
                                )}
                                <div className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                                    <span className="text-gray-500">Crew</span>
                                    <p className="text-white font-bold">{activeVoyage.crew_count}</p>
                                </div>
                                {activeVoyage.departure_time && (
                                    <div className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                                        <span className="text-gray-500">Departed</span>
                                        <p className="text-white font-bold">
                                            {new Date(activeVoyage.departure_time).toLocaleString([], {
                                                month: 'short',
                                                day: 'numeric',
                                                hour: '2-digit',
                                                minute: '2-digit',
                                            })}
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Completed legs timeline */}
                        {completedLegs.length > 0 && (
                            <div className="space-y-1.5">
                                <div className="flex items-center gap-2 px-1">
                                    <div className="w-1 h-3 rounded-full bg-sky-500" />
                                    <span className="text-[10px] font-bold text-sky-400 uppercase tracking-widest">
                                        Passage Legs
                                    </span>
                                </div>
                                {completedLegs.map((leg) => {
                                    const summary = getLegSummary(leg);
                                    return (
                                        <div
                                            key={leg.id}
                                            className="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.04] flex items-center gap-2.5"
                                        >
                                            <span className="w-6 h-6 rounded-full bg-emerald-500/10 text-emerald-400 text-[10px] font-black flex items-center justify-center shrink-0">
                                                {summary.legNumber}
                                            </span>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[11px] font-bold text-white truncate">
                                                    {summary.route}
                                                </p>
                                                <p className="text-[10px] text-gray-500">
                                                    {summary.durationHours ? `${summary.durationHours}h` : '—'}
                                                    {summary.distanceNm ? ` · ${summary.distanceNm.toFixed(0)} NM` : ''}
                                                </p>
                                            </div>
                                            <span className="text-emerald-400 text-[10px]">✓</span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Arrive at Port — Stopover */}
                        {currentLeg && (
                            <button
                                onClick={handleArriveAtPort}
                                className="w-full py-3.5 bg-sky-500/10 border border-sky-500/20 rounded-xl text-sm font-bold text-sky-400 uppercase tracking-widest hover:bg-sky-500/20 transition-colors active:scale-[0.97]"
                            >
                                ⚓ Arrive at Port
                            </button>
                        )}

                        <button
                            onClick={handleEndVoyage}
                            className="w-full py-3.5 bg-red-500/10 border border-red-500/20 rounded-xl text-sm font-bold text-red-400 uppercase tracking-widest hover:bg-red-500/20 transition-colors active:scale-[0.97]"
                        >
                            🏁 End Voyage &amp; Archive
                        </button>
                    </div>
                )}

                {/* ── Arrive at Port (close current leg) ── */}
                {step === 'arrive' && activeVoyage && (
                    <div className="p-5 pt-2 space-y-4">
                        <div className="text-center py-2">
                            <div className="text-4xl mb-2">⚓</div>
                            <h3 className="text-lg font-black text-white mb-1">Arrive at Port</h3>
                            <p className="text-xs text-gray-400">
                                Close Leg {currentLeg?.leg_number || completedLegs.length + 1} and log your arrival
                            </p>
                        </div>

                        <div>
                            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 block">
                                Arrival Port *
                            </label>
                            <input
                                type="text"
                                value={arrivalPort}
                                onChange={(e) => setArrivalPort(e.target.value)}
                                onFocus={scrollInputAboveKeyboard}
                                placeholder="e.g. Nouméa, New Caledonia"
                                className="w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-sky-500/40 outline-none transition-colors"
                                autoFocus
                            />
                        </div>

                        <div className="space-y-2">
                            <button
                                onClick={handleConfirmArrival}
                                disabled={!arrivalPort.trim()}
                                className="w-full py-3.5 bg-gradient-to-r from-sky-500 to-sky-500 rounded-xl text-sm font-black text-white uppercase tracking-[0.15em] transition-all active:scale-[0.97] disabled:opacity-20 shadow-lg shadow-sky-500/20"
                            >
                                ⚓ Confirm Arrival
                            </button>
                            <button
                                onClick={handleSkipToActive}
                                className="w-full py-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                            >
                                ← Back
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Depart on Next Leg (or end voyage) ── */}
                {step === 'depart_leg' && activeVoyage && (
                    <div className="p-5 pt-2 space-y-4">
                        <div className="text-center py-2">
                            <div className="text-4xl mb-2">🚢</div>
                            <h3 className="text-lg font-black text-white mb-1">Arrived at {arrivalPort || 'port'}</h3>
                            <p className="text-xs text-gray-400">
                                Leg {completedLegs.length} complete. Ready to depart on the next leg?
                            </p>
                        </div>

                        {/* Quick leg summary */}
                        {completedLegs.length > 0 && (
                            <div className="p-3 rounded-xl bg-emerald-500/[0.04] border border-emerald-500/10">
                                {completedLegs.map((leg) => {
                                    const s = getLegSummary(leg);
                                    return (
                                        <div key={leg.id} className="flex items-center gap-2 py-1 text-[11px]">
                                            <span className="text-emerald-400 font-black">L{s.legNumber}</span>
                                            <span className="text-gray-300 truncate flex-1">{s.route}</span>
                                            <span className="text-gray-500">
                                                {s.durationHours ? `${s.durationHours}h` : ''}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        <div className="space-y-2">
                            <button
                                onClick={handleDepartNextLeg}
                                className="w-full py-4 bg-gradient-to-r from-amber-500 to-orange-500 rounded-xl text-base font-black text-black uppercase tracking-[0.15em] transition-all active:scale-[0.96] shadow-lg shadow-amber-500/20"
                            >
                                🚢 Depart — Start Leg {completedLegs.length + 1}
                            </button>
                            <button
                                onClick={handleEndVoyage}
                                className="w-full py-3.5 bg-red-500/10 border border-red-500/20 rounded-xl text-sm font-bold text-red-400 uppercase tracking-widest hover:bg-red-500/20 transition-colors active:scale-[0.97]"
                            >
                                🏁 End Voyage Here
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step 1: Draft Selection ── */}
                {step === 'select' && !loading && (
                    <div className="p-5 pt-2 space-y-3">
                        {drafts.length === 0 ? (
                            <div className="text-center py-6">
                                <span className="text-4xl">🗺️</span>
                                <p className="text-sm text-gray-400 mt-3">No draft voyages yet</p>
                                <p className="text-[11px] text-gray-600 mt-1 mb-4">
                                    Create your first passage to get started
                                </p>
                                <button
                                    onClick={() => {
                                        setStep('create');
                                        triggerHaptic('light');
                                    }}
                                    className="px-6 py-3 bg-gradient-to-r from-amber-500 to-orange-500 rounded-xl text-sm font-black text-black uppercase tracking-widest active:scale-[0.97] shadow-lg shadow-amber-500/20"
                                >
                                    + New Voyage
                                </button>
                            </div>
                        ) : (
                            <>
                                {drafts.map((v) => (
                                    <button
                                        key={v.id}
                                        onClick={() => handleSelect(v)}
                                        className="w-full p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] text-left hover:bg-white/[0.05] hover:border-amber-500/20 transition-all active:scale-[0.98] group"
                                    >
                                        <div className="flex items-start justify-between">
                                            <div>
                                                <h3 className="text-sm font-bold text-white group-hover:text-amber-300 transition-colors">
                                                    {v.voyage_name}
                                                </h3>
                                                <p className="text-[11px] text-gray-500 mt-0.5">
                                                    {v.departure_port || '?'} → {v.destination_port || '?'}
                                                </p>
                                            </div>
                                            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-sky-500/10 text-sky-400 border border-sky-500/15">
                                                Draft
                                            </span>
                                        </div>
                                        <div className="flex gap-3 mt-2 text-[10px] text-gray-500">
                                            <span>👥 {v.crew_count} crew</span>
                                            {v.eta && <span>ETA: {new Date(v.eta).toLocaleDateString()}</span>}
                                        </div>
                                    </button>
                                ))}

                                {/* Add button when drafts exist */}
                                <button
                                    onClick={() => {
                                        setStep('create');
                                        triggerHaptic('light');
                                    }}
                                    className="w-full py-3 text-xs font-bold text-amber-400/60 uppercase tracking-widest hover:text-amber-300 transition-colors"
                                >
                                    + New Voyage
                                </button>
                            </>
                        )}
                    </div>
                )}

                {/* ── Step: Quick Create Voyage ── */}
                {step === 'create' && (
                    <div className="p-5 pt-2 space-y-4">
                        <div>
                            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 block">
                                Voyage Name *
                            </label>
                            <input
                                type="text"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                onFocus={scrollInputAboveKeyboard}
                                placeholder="e.g. Tangalooma Day Trip"
                                className="w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-amber-500/40 outline-none transition-colors"
                                autoFocus
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 block">
                                    From
                                </label>
                                <input
                                    type="text"
                                    value={newFrom}
                                    onChange={(e) => setNewFrom(e.target.value)}
                                    onFocus={scrollInputAboveKeyboard}
                                    placeholder="Departure port"
                                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-3 py-2.5 text-xs text-white placeholder-gray-600 focus:border-amber-500/40 outline-none transition-colors"
                                />
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 block">
                                    To
                                </label>
                                <input
                                    type="text"
                                    value={newTo}
                                    onChange={(e) => setNewTo(e.target.value)}
                                    onFocus={scrollInputAboveKeyboard}
                                    placeholder="Destination"
                                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-3 py-2.5 text-xs text-white placeholder-gray-600 focus:border-amber-500/40 outline-none transition-colors"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 block">
                                Crew Count
                            </label>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => setNewCrew((c) => Math.max(1, c - 1))}
                                    className="w-9 h-9 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white hover:bg-white/[0.1] active:scale-90"
                                >
                                    −
                                </button>
                                <span className="text-xl font-black text-amber-400 w-8 text-center tabular-nums">
                                    {newCrew}
                                </span>
                                <button
                                    onClick={() => setNewCrew((c) => Math.min(20, c + 1))}
                                    className="w-9 h-9 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white hover:bg-white/[0.1] active:scale-90"
                                >
                                    +
                                </button>
                            </div>
                        </div>

                        {error && <p className="text-sm text-red-400 text-center">{error}</p>}

                        <div className="space-y-2">
                            <button
                                onClick={handleCreateVoyage}
                                disabled={!newName.trim() || creating}
                                className="w-full py-3.5 bg-gradient-to-r from-amber-500 to-orange-500 rounded-xl text-sm font-black text-black uppercase tracking-[0.15em] transition-all active:scale-[0.97] disabled:opacity-30 shadow-lg shadow-amber-500/20"
                            >
                                {creating ? '⏳ Creating…' : '✨ Create Draft Voyage'}
                            </button>
                            <button
                                onClick={() => setStep('select')}
                                className="w-full py-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                            >
                                ← Back
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step 2: Pre-Departure Summary ── */}
                {step === 'preflight' && selected && (
                    <div className="p-5 pt-2 space-y-4">
                        {/* Voyage title */}
                        <div className="text-center pb-2">
                            <h3 className="text-lg font-black text-white">{selected.voyage_name}</h3>
                            <p className="text-[11px] text-gray-500">
                                {selected.departure_port || '?'} → {selected.destination_port || '?'}
                            </p>
                        </div>

                        {/* Checklist */}
                        <div className="space-y-2">
                            <CheckItem
                                label="Crew Confirmed"
                                detail={`${selected.crew_count} crew aboard`}
                                icon="👥"
                                checked={crewReady}
                                onToggle={() => setCrewReady((v) => !v)}
                            />
                            <CheckItem
                                label="Stores Shortfalls Cleared"
                                detail="All provisions aboard"
                                icon="📦"
                                checked={storesCleared}
                                onToggle={() => setStoresCleared((v) => !v)}
                            />
                            <CheckItem
                                label="Weather GRIBs Updated"
                                detail="Forecast current"
                                icon="🌤️"
                                checked={weatherChecked}
                                onToggle={() => setWeatherChecked((v) => !v)}
                            />
                        </div>

                        {/* Galley & Meals Quick Access */}
                        <button
                            onClick={() => {
                                onClose();
                                onNavigateToGalley?.();
                            }}
                            className="w-full flex items-center gap-3 p-3 rounded-xl bg-emerald-500/[0.06] border border-emerald-500/15 hover:bg-emerald-500/10 transition-colors"
                        >
                            <span className="text-2xl">🍳</span>
                            <div className="text-left flex-1">
                                <p className="text-xs font-bold text-emerald-300">Galley & Meals</p>
                                <p className="text-[10px] text-gray-500">Plan provisions for this voyage</p>
                            </div>
                            <span className="text-gray-600 text-sm">→</span>
                        </button>

                        {/* Safety Confirm */}
                        <div className="p-4 rounded-xl bg-amber-500/[0.04] border border-amber-500/15">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <div
                                    className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                                        safetyConfirmed
                                            ? 'bg-amber-500 border-amber-500'
                                            : 'border-gray-600 bg-transparent'
                                    }`}
                                    onClick={() => {
                                        setSafetyConfirmed((v) => !v);
                                        triggerHaptic('medium');
                                    }}
                                >
                                    {safetyConfirmed && (
                                        <svg
                                            className="w-4 h-4 text-black"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={3}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M4.5 12.75l6 6 9-13.5"
                                            />
                                        </svg>
                                    )}
                                </div>
                                <div>
                                    <p className="text-xs font-bold text-amber-300">Confirm Safety</p>
                                    <p className="text-[10px] text-gray-500">
                                        Vessel is ready to depart for this voyage
                                    </p>
                                </div>
                            </label>
                        </div>

                        {error && <p className="text-sm text-red-400 text-center">{error}</p>}

                        {/* Actions */}
                        <div className="space-y-2">
                            <button
                                onClick={handleCastOff}
                                disabled={!safetyConfirmed || casting}
                                className="w-full py-4 bg-gradient-to-r from-amber-500 to-orange-500 rounded-xl text-base font-black text-black uppercase tracking-[0.2em] transition-all active:scale-[0.96] disabled:opacity-20 disabled:cursor-not-allowed shadow-lg shadow-amber-500/20"
                            >
                                {casting ? '⏳ Casting Off…' : '⚓ CAST OFF'}
                            </button>
                            <button
                                onClick={() => {
                                    setStep('select');
                                    setSelected(null);
                                }}
                                className="w-full py-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                            >
                                ← Back to Draft Selection
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

/** Pre-departure checklist item */
const CheckItem: React.FC<{
    label: string;
    detail: string;
    icon: string;
    checked: boolean;
    onToggle: () => void;
}> = ({ label, detail, icon, checked, onToggle }) => (
    <button
        onClick={() => {
            onToggle();
            triggerHaptic('light');
        }}
        className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all active:scale-[0.98] ${
            checked
                ? 'bg-emerald-500/[0.06] border-emerald-500/15'
                : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]'
        }`}
    >
        <span className="text-lg">{icon}</span>
        <div className="flex-1 text-left">
            <p className={`text-xs font-bold ${checked ? 'text-emerald-400' : 'text-white'}`}>{label}</p>
            <p className="text-[10px] text-gray-500">{detail}</p>
        </div>
        <div
            className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                checked ? 'bg-emerald-500 border-emerald-500' : 'border-gray-600'
            }`}
        >
            {checked && (
                <svg
                    className="w-3 h-3 text-black"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
            )}
        </div>
    </button>
);
