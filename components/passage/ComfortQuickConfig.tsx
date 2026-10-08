/**
 * ComfortQuickConfig — Inline comfort-profile control for the
 * RoutePlanner form.
 *
 * Sits at the top of the route form (above origin/destination) so the
 * user can dial in their boat's comfort thresholds before calculating
 * a route. The values write directly to settings.comfortParams (the
 * canonical store) and the isochrone engine reads them at compute time
 * to drop candidate bearings whose wind/wave conditions or wind angle
 * exceed the user's tolerance.
 *
 * This replaces the old ComfortProfileCard under Passage Intelligence
 * which:
 *   - Stored to a separate localStorage key (third source of truth)
 *   - Wrote to ComfortProfileService, never read by the routing engine
 *   - Was inconvenient (you had to navigate to Crew → PI → expand → save
 *     before the values mattered)
 *
 * The new control is collapsible: defaults to a one-line summary
 * showing the current caps (so the form stays clean), tap to expand and
 * tweak. State is per-user-global (settings.comfortParams), not
 * per-voyage — your boat's comfort threshold doesn't change between
 * passages.
 *
 * Multi-select preferred angles: pill toggles for the five sailing
 * angle bands (beating / close-reach / beam-reach / broad-reach /
 * running). Tap to add/remove. Empty selection or all five = no angle
 * preference. Cruisers who hate beating typically select the four
 * non-beating bands.
 */

import React, { useState } from 'react';
import { useSettings } from '../../context/SettingsContext';
import type { PreferredAngle, ComfortParams } from '../../types';

const ANGLE_PILLS: { key: PreferredAngle; label: string; desc: string }[] = [
    { key: 'beating', label: 'Beating', desc: 'Close-hauled (TWA 0–50°)' },
    { key: 'close_reach', label: 'Close Reach', desc: 'TWA 50–80°' },
    { key: 'beam_reach', label: 'Beam Reach', desc: 'TWA 80–110°' },
    { key: 'broad_reach', label: 'Broad Reach', desc: 'TWA 110–150°' },
    { key: 'running', label: 'Running', desc: 'Downwind (TWA 150–180°)' },
];

const ALL_ANGLES: PreferredAngle[] = ANGLE_PILLS.map((a) => a.key);

interface ComfortQuickConfigProps {
    /**
     * Optional controlled-component props. When both are provided, the
     * parent owns the expand/collapse state — used by RoutePlanner to
     * auto-collapse the panel the moment the user taps into the
     * origin/destination/departure inputs (otherwise the open accordion
     * pushes those inputs off-screen and the keyboard covers what's
     * left of them).
     *
     * If omitted, the component falls back to internal useState for
     * standalone use cases.
     */
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
    /**
     * Plan Your Day's Sources and limits (build 124): the limits in force
     * where none is set here (her boat's, or a typical cruiser's), so the
     * sliders start where the plan is rather than at 35 kt / 4 m, which read
     * as her limits and made "dragging down" loosen them. Adds a gust slider;
     * leaves out the angle bands, which only the router reads.
     */
    inForce?: { windKts: number; gustKts: number; waveM: number; from: string | null };
}

const one = (v: number) => Math.round(v * 10) / 10;

export const ComfortQuickConfig: React.FC<ComfortQuickConfigProps> = ({
    expanded: expandedProp,
    onExpandedChange,
    inForce,
}) => {
    const { settings, updateSettings } = useSettings();
    const [internalExpanded, setInternalExpanded] = useState(false);
    // Controlled-or-uncontrolled: prefer parent-provided state when present
    const isControlled = expandedProp !== undefined && onExpandedChange !== undefined;
    const expanded = isControlled ? expandedProp! : internalExpanded;
    const setExpanded = (next: boolean | ((prev: boolean) => boolean)) => {
        const resolved = typeof next === 'function' ? (next as (p: boolean) => boolean)(expanded) : next;
        if (isControlled) onExpandedChange!(resolved);
        else setInternalExpanded(resolved);
    };

    const params: ComfortParams = settings.comfortParams ?? {};
    // The route planner's own use is unchanged: its 35 kt / 4 m stand-ins, unrounded.
    const maxWind = inForce ? one(params.maxWindKts ?? inForce.windKts) : (params.maxWindKts ?? 35);
    const maxWave = inForce ? one(params.maxWaveM ?? inForce.waveM) : (params.maxWaveM ?? 4);
    const maxGust = inForce ? one(params.maxGustKts ?? inForce.gustKts) : null;
    const unset = !!inForce && [params.maxWindKts, params.maxGustKts, params.maxWaveM].some((v) => v === undefined);
    const angles = params.preferredAngles ?? [];

    // "Effective" angles = selected, OR all if empty (= no preference).
    // Used for chip display + isochrone engine handling.
    const effectiveAngles = angles.length === 0 ? ALL_ANGLES : angles;
    const allSelected = effectiveAngles.length === ALL_ANGLES.length;

    const updateField = <K extends keyof ComfortParams>(key: K, value: ComfortParams[K]) => {
        updateSettings({
            comfortParams: { ...params, [key]: value },
        });
    };

    const toggleAngle = (key: PreferredAngle) => {
        // `undefined` means "no preference" = ALL five selected (that is what
        // the pills show). Starting from [] instead inverted the gesture: a
        // cruiser deselecting Beating got ONLY Beating (audit 2026-09-02).
        const cur = effectiveAngles;
        const next = cur.includes(key) ? cur.filter((a) => a !== key) : [...cur, key];
        // If user selected all five, store as undefined (= "no preference"
        // — saves a comparison in the engine and reads cleaner in the
        // settings export).
        const final = next.length === ALL_ANGLES.length ? undefined : next;
        updateSettings({
            comfortParams: { ...params, preferredAngles: final },
        });
    };

    // Summary chip for the collapsed state.
    const angleSummary = allSelected
        ? 'all angles'
        : effectiveAngles.length === 1
          ? ANGLE_PILLS.find((a) => a.key === effectiveAngles[0])?.label
          : `${effectiveAngles.length} angles`;
    const summary = inForce
        ? `≤${maxWind}kt · gusts ≤${maxGust}kt · ≤${maxWave}m`
        : `≤${maxWind}kt · ≤${maxWave}m · ${angleSummary}`;

    return (
        <div className="rounded-xl bg-slate-900/40 border border-white/10 overflow-hidden">
            {/* Header — always visible, click to expand */}
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-white/3 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <span className="text-base">🎚️</span>
                    <span className="text-[11px] font-bold text-white uppercase tracking-widest">Comfort</span>
                </div>
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] text-slate-300 truncate">{summary}</span>
                    <svg
                        className={`w-4 h-4 text-slate-500 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                </div>
            </button>

            {/* Expanded panel */}
            {expanded && (
                <div className="px-4 pb-4 pt-1 space-y-4 border-t border-white/5 animate-in fade-in duration-200">
                    {/* Max Wind */}
                    <div>
                        <div className="flex justify-between items-center mb-1.5">
                            <span className="text-[11px] font-bold text-slate-300 uppercase tracking-widest">
                                💨 Max Wind
                            </span>
                            <span className="text-xs font-bold text-cyan-400 tabular-nums">{maxWind} kt</span>
                        </div>
                        <input
                            type="range"
                            min={10}
                            max={50}
                            step={1}
                            value={maxWind}
                            onChange={(e) => updateField('maxWindKts', Number(e.target.value))}
                            className="w-full accent-cyan-500"
                            aria-label="Max acceptable wind speed"
                        />
                        <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
                            <span>10 kt</span>
                            <span>30 kt</span>
                            <span>50 kt</span>
                        </div>
                    </div>

                    {maxGust !== null && (
                        <div>
                            <div className="flex justify-between items-center mb-1.5">
                                <span className="text-[11px] font-bold text-slate-300 uppercase tracking-widest">
                                    💨 Max Gust
                                </span>
                                <span className="text-xs font-bold text-cyan-400 tabular-nums">{maxGust} kt</span>
                            </div>
                            <input
                                type="range"
                                min={10}
                                max={60}
                                step={1}
                                value={maxGust}
                                onChange={(e) => updateField('maxGustKts', Number(e.target.value))}
                                className="w-full accent-cyan-500"
                                aria-label="Max acceptable gust"
                            />
                        </div>
                    )}

                    {/* Max Wave */}
                    <div>
                        <div className="flex justify-between items-center mb-1.5">
                            <span className="text-[11px] font-bold text-slate-300 uppercase tracking-widest">
                                🌊 Max Wave
                            </span>
                            <span className="text-xs font-bold text-cyan-400 tabular-nums">{maxWave} m</span>
                        </div>
                        <input
                            type="range"
                            min={0.5}
                            max={6}
                            step={inForce ? 0.1 : 0.5}
                            value={maxWave}
                            onChange={(e) => updateField('maxWaveM', Number(e.target.value))}
                            className="w-full accent-cyan-500"
                            aria-label="Max acceptable wave height"
                        />
                        <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
                            <span>0.5 m</span>
                            <span>3 m</span>
                            <span>6 m</span>
                        </div>
                    </div>

                    {unset && inForce?.from && (
                        <p className="text-xs text-slate-400 leading-relaxed">
                            Sliders you haven&rsquo;t moved show {inForce.from}&rsquo;s limits.
                        </p>
                    )}

                    {/* Multi-select Wind Angles: the router's alone */}
                    {!inForce && (
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[11px] font-bold text-slate-300 uppercase tracking-widest">
                                    🧭 Acceptable Wind Angles
                                </span>
                                {!allSelected && (
                                    <button
                                        type="button"
                                        onClick={() => updateField('preferredAngles', undefined)}
                                        className="min-h-[44px] text-[10px] text-slate-500 hover:text-slate-300 underline-offset-2 hover:underline"
                                    >
                                        select all
                                    </button>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {ANGLE_PILLS.map(({ key, label, desc }) => {
                                    const active = effectiveAngles.includes(key);
                                    return (
                                        <button
                                            key={key}
                                            type="button"
                                            onClick={() => toggleAngle(key)}
                                            title={desc}
                                            aria-pressed={active}
                                            className={`px-2.5 py-1 min-h-[44px] rounded-full text-[11px] font-bold border transition-colors active:scale-[0.97] ${
                                                active
                                                    ? 'bg-violet-500/20 border-violet-500/40 text-violet-200'
                                                    : 'bg-white/2 border-white/10 text-slate-500 hover:text-slate-300'
                                            }`}
                                        >
                                            {label}
                                        </button>
                                    );
                                })}
                            </div>
                            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
                                Routes whose true wind angle falls outside your selection are dropped. Empty / all = no
                                preference. Cruisers who hate beating typically deselect it.
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
