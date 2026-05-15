/**
 * Vessel Readiness — Settings tab.
 *
 * Houses the four vessel-wide pre-departure cards (reserves, vessel
 * pre-check, medical, comms) so the skipper can tick them off any
 * time — not only when a passage is selected on the Passage Planning
 * page. Same cards still render inside ReadinessCardStack when a
 * passage IS selected; this tab is a second access point, not a
 * replacement.
 *
 * voyageId is intentionally omitted on every card. Each card's
 * useReadinessSync hook is a no-op when voyageId is undefined, and
 * the underlying localStorage state is vessel-wide (one key per
 * card), so ticks flow through correctly. When the same cards
 * render with a voyageId inside passage planning, they ALSO sync
 * to readiness_checks for that voyage — both surfaces stay
 * consistent.
 *
 * The boolean callbacks (onReviewedChange) drive a small summary
 * pill at the top of the tab so the skipper can see at a glance
 * which categories are complete.
 */

import React, { useState } from 'react';
import { EssentialReservesCard } from '../passage/EssentialReservesCard';
import { VesselCheckCard } from '../passage/VesselCheckCard';
import { MedicalFirstAidCard } from '../passage/MedicalFirstAidCard';
import { CommsPlanCard } from '../passage/CommsPlanCard';
import type { SettingsTabProps } from './SettingsPrimitives';

export const VesselReadinessTab: React.FC<SettingsTabProps> = () => {
    const [reservesReady, setReservesReady] = useState(false);
    const [vesselChecked, setVesselChecked] = useState(false);
    const [medicalReady, setMedicalReady] = useState(false);
    const [commsReady, setCommsReady] = useState(false);

    const readyCount = [reservesReady, vesselChecked, medicalReady, commsReady].filter(Boolean).length;
    const totalCount = 4;
    const allReady = readyCount === totalCount;

    return (
        <div className="px-4 pb-8">
            <p className="text-sm text-gray-400 mb-4">
                Vessel-wide pre-departure checks. Tick these off whenever you provision, service, or audit the boat —
                they're not tied to any specific passage. When you start passage planning, the same lists appear there
                too, so what you've ticked here carries over.
            </p>

            {/* Summary pill */}
            <div
                className={`mb-6 rounded-xl px-4 py-2.5 border flex items-center justify-between gap-3 ${
                    allReady
                        ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                        : 'bg-amber-500/[0.07] border-amber-500/20 text-amber-300/90'
                }`}
            >
                <span className="text-xs font-bold uppercase tracking-wider">
                    {allReady ? 'All Categories Ready' : 'Vessel Readiness'}
                </span>
                <span className="text-[11px] font-mono tabular-nums shrink-0">
                    {readyCount} / {totalCount}
                </span>
            </div>

            {/* The four cards — each manages its own localStorage state.
                Passing no voyageId puts useReadinessSync in offline-only
                mode for this surface; the cards still tick correctly and
                a per-voyage sync layer kicks in when the same cards
                render inside passage planning later. */}
            <div className="space-y-4">
                <EssentialReservesCard onReviewedChange={setReservesReady} />
                <VesselCheckCard onReviewedChange={setVesselChecked} />
                <MedicalFirstAidCard onReviewedChange={setMedicalReady} />
                <CommsPlanCard onReviewedChange={setCommsReady} />
            </div>
        </div>
    );
};
