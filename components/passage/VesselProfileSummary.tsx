/**
 * VesselProfileSummary — summary and per-passage confirmation of the active vessel.
 *
 * Replaces the old VesselProfileCard which had a separate localStorage
 * key (`thalassa_vessel_profile`) and was NOT used by the routing
 * engine — a data-divergence trap. The user already configures their
 * vessel during onboarding and in Settings → Vessel Profile, and that's
 * the canonical record (`settings.vessel`) that the isochrone router
 * actually reads.
 *
 * The canonical vessel profile is deliberately separate from passage
 * readiness. A completed profile makes a routeable boat available, but it
 * must not silently mark every new passage as reviewed. The skipper confirms
 * it for each passage here; that confirmation is stored and synced with the
 * passage so a saved route resumes at its real level of completeness.
 *
 * Reactivity:
 *   `useSettings()` is a Context-backed hook — every change to vessel
 *   profile / vesselUnits / units fires a re-render here automatically.
 *   No additional listeners or polling required; the displayed values
 *   always match the canonical settings record on the next paint.
 */

import React, { useCallback, useEffect } from 'react';
import { useSettings } from '../../context/SettingsContext';
import { useReadinessSync, useScopedReadinessStorageState } from '../../hooks/useReadinessSync';
import { ftToM, ktsToKmh, ktsToMph, ktsToMps } from '../../utils/units';

interface VesselProfileSummaryProps {
    /** The confirmation is deliberately scoped to this one passage. */
    voyageId?: string;
    /** Crew/Passage Intelligence receives the real per-passage readiness. */
    onReviewedChange?: (ready: boolean) => void;
}

const STORAGE_KEY = 'thalassa_vessel_profile_confirmation';
const CONFIRMATION_KEY = 'confirmed';

/** Convert canonical feet → user's preferred length unit. */
function lengthInUnit(ft: number, unit: 'ft' | 'm' | undefined): { value: number; unit: 'ft' | 'm' } {
    if (unit === 'm') return { value: ftToM(ft), unit: 'm' };
    return { value: ft, unit: 'ft' };
}

/** Convert canonical knots → user's preferred speed unit. */
function speedInUnit(
    kts: number,
    unit: 'kts' | 'mph' | 'kmh' | 'mps' | undefined,
): { value: number; unit: 'kt' | 'mph' | 'km/h' | 'm/s' } {
    if (unit === 'mph') return { value: ktsToMph(kts), unit: 'mph' };
    if (unit === 'kmh') return { value: ktsToKmh(kts), unit: 'km/h' };
    if (unit === 'mps') return { value: ktsToMps(kts), unit: 'm/s' };
    return { value: kts, unit: 'kt' };
}

const fmtInt = (n: number) => Math.round(n).toString();
const fmt1 = (n: number) => {
    const r = Math.round(n * 10) / 10;
    // Drop trailing .0 — "6 kt" reads cleaner than "6.0 kt"
    return Number.isInteger(r) ? r.toString() : r.toFixed(1);
};

export const VesselProfileSummary: React.FC<VesselProfileSummaryProps> = ({ voyageId, onReviewedChange }) => {
    const { settings } = useSettings();
    const vessel = settings.vessel;
    const profileComplete = !!vessel && !!vessel.name && !!vessel.cruisingSpeed;
    const [confirmation, setConfirmation] = useScopedReadinessStorageState<Record<string, boolean>>(
        STORAGE_KEY,
        voyageId,
        {},
    );
    const { syncCheck } = useReadinessSync(voyageId, 'vessel_profile', confirmation, setConfirmation, STORAGE_KEY);
    const confirmedForPassage = confirmation[CONFIRMATION_KEY] === true;
    const ready = profileComplete && confirmedForPassage;

    // A configured vessel is necessary but not sufficient: the skipper must
    // explicitly confirm it for this passage. This prevents a new route from
    // inheriting a green card merely because onboarding has a vessel profile.
    useEffect(() => {
        onReviewedChange?.(ready);
    }, [ready, onReviewedChange]);

    const toggleConfirmation = useCallback(() => {
        if (!profileComplete) return;
        const nextConfirmed = !confirmedForPassage;
        setConfirmation({ ...confirmation, [CONFIRMATION_KEY]: nextConfirmed });
        syncCheck(CONFIRMATION_KEY, nextConfirmed, {
            confirmed_at: nextConfirmed ? new Date().toISOString() : null,
        });
    }, [confirmation, confirmedForPassage, profileComplete, setConfirmation, syncCheck]);

    if (!vessel) {
        return (
            <div className="rounded-xl bg-amber-500/10 border border-amber-500/25 p-4">
                <p className="text-sm font-bold text-amber-300">No vessel configured</p>
                <p className="mt-1 text-[12px] text-amber-300/70">
                    Add your vessel in Settings → Vessel Profile so the routing engine knows what boat it's planning
                    for.
                </p>
            </div>
        );
    }

    // Stored values are CANONICAL — every numeric field on settings.vessel
    // is in standard units (feet for lengths, knots for speed, lbs for
    // weight). VesselTab's MetricInput strips the user's unit choice and
    // writes back the standard-unit value, so the routing engine and
    // every read site sees the same number regardless of which unit the
    // input was typed in. Display here just converts back to whatever
    // unit the user picked in settings.
    //
    // Until 2026-05-08 this card hard-coded "ft" for length and "m" for
    // draft (treating the canonical-feet draft value as if it were
    // already in meters), so a Tayana 55 with a 7.9 ft draft showed as
    // "7.9 m draft" — three times the actual depth. Fixed below by
    // routing every dimension through the conversion + unit helpers.
    const typeLabel = vessel.type === 'sail' ? 'Sail' : vessel.type === 'power' ? 'Power' : 'Observer';

    const lengthDisplay = vessel.length
        ? (() => {
              const { value, unit } = lengthInUnit(vessel.length, settings.vesselUnits?.length);
              return `${fmtInt(value)} ${unit}`;
          })()
        : '';

    const draftDisplay = vessel.draft
        ? (() => {
              const { value, unit } = lengthInUnit(vessel.draft, settings.vesselUnits?.draft);
              return `${fmt1(value)} ${unit} draft`;
          })()
        : '';

    const speedDisplay = vessel.cruisingSpeed
        ? (() => {
              const { value, unit } = speedInUnit(vessel.cruisingSpeed, settings.units?.speed);
              return `${fmt1(value)} ${unit} cruise`;
          })()
        : '';

    const summaryParts = [typeLabel, lengthDisplay, speedDisplay, draftDisplay].filter(Boolean);

    return (
        <div className="space-y-3">
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/25 p-4">
                <div className="flex items-center gap-3">
                    <span className="text-2xl">⚓</span>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-white truncate">{vessel.name}</p>
                        <p className="mt-0.5 text-[11px] text-emerald-300/80">{summaryParts.join(' · ')}</p>
                    </div>
                </div>
                <p className="mt-3 text-[11px] text-emerald-300/60">
                    The isochrone router uses this vessel's polar / cruising speed / draft / comfort caps. Edit in
                    Settings → Vessel Profile to change.
                </p>
            </div>

            {profileComplete ? (
                <button
                    type="button"
                    aria-pressed={confirmedForPassage}
                    onClick={toggleConfirmation}
                    className={`w-full rounded-xl border px-4 py-3 text-left transition-all active:scale-[0.99] ${
                        confirmedForPassage
                            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15'
                            : 'border-violet-500/25 bg-violet-500/8 text-violet-200 hover:bg-violet-500/13'
                    }`}
                >
                    <span className="block text-xs font-bold">
                        {confirmedForPassage
                            ? '✓ Vessel confirmed for this passage'
                            : 'Confirm vessel for this passage'}
                    </span>
                    <span className="mt-0.5 block text-[11px] opacity-75">
                        {confirmedForPassage
                            ? 'Saved with this route and carried to your other signed-in devices.'
                            : 'Check that this is the boat, profile, and limits you intend to sail with.'}
                    </span>
                </button>
            ) : (
                <p className="rounded-xl border border-amber-500/20 bg-amber-500/6 px-4 py-3 text-[11px] text-amber-200/80">
                    Complete the vessel name and cruising speed in Settings → Vessel Profile before confirming it for
                    this passage.
                </p>
            )}
        </div>
    );
};
