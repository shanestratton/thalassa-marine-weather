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
 */

import React, { useEffect } from 'react';
import { useSettings } from '../../context/SettingsContext';

interface VesselProfileSummaryProps {
    /** Crew/Passage Intelligence calls this with `true` once vessel exists. */
    onReviewedChange?: (ready: boolean) => void;
}

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

    const typeLabel = vessel.type === 'sail' ? 'Sail' : vessel.type === 'power' ? 'Power' : 'Observer';
    const lengthDisplay = vessel.length ? `${vessel.length}ft` : '';
    const speedDisplay = vessel.cruisingSpeed ? `${vessel.cruisingSpeed}kt cruise` : '';
    const draftDisplay = vessel.draft ? `${vessel.draft}m draft` : '';
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
