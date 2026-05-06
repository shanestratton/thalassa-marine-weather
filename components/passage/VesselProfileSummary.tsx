/**
 * VesselProfileSummary — Read-only summary of the active vessel.
 *
 * Replaces the old VesselProfileCard which had a separate localStorage
 * key (`thalassa_vessel_profile`) and was NOT used by the routing
 * engine — a data-divergence trap. The user already configures their
 * vessel during onboarding and in Settings → Vessel Profile, and that's
 * the canonical record (`settings.vessel`) that the isochrone router
 * actually reads.
 *
 * This card just confirms which vessel the route will be calculated
 * for. Tapping the edit link opens the SettingsModal with the Vessel
 * tab focused, so the user can edit the canonical record in one place.
 *
 * Reactivity:
 *   `useSettings()` is a Context-backed hook — every change to vessel
 *   profile / vesselUnits / units fires a re-render here automatically.
 *   No additional listeners or polling required; the displayed values
 *   always match the canonical settings record on the next paint.
 */

import React, { useEffect } from 'react';
import { useSettings } from '../../context/SettingsContext';
import { ftToM, ktsToKmh, ktsToMph, ktsToMps } from '../../utils/units';

interface VesselProfileSummaryProps {
    /** Crew/Passage Intelligence calls this with `true` once vessel exists. */
    onReviewedChange?: (ready: boolean) => void;
}

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

export const VesselProfileSummary: React.FC<VesselProfileSummaryProps> = ({ onReviewedChange }) => {
    const { settings } = useSettings();
    const vessel = settings.vessel;
    const ready = !!vessel && !!vessel.name && !!vessel.cruisingSpeed;

    // Pulse the readiness gate up to the parent (CrewManagement /
    // ReadinessCardStack) so the chip flips green automatically whenever
    // the user's onboarded vessel data is present — no separate save
    // required for this card.
    useEffect(() => {
        onReviewedChange?.(ready);
    }, [ready, onReviewedChange]);

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
        </div>
    );
};
