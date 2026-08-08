/**
 * SkipperClaimNotice — say out loud that this device is recording but NOT
 * publishing.
 *
 * The single-publisher veto in services/shiplog/LiveTrickle.ts is correct: one
 * device speaks for the boat, and a second must take over deliberately rather
 * than quietly becoming a rival source of truth. What was wrong is that it was
 * SILENT. Live share reads ON in Settings, the cast-off sheet confirms the
 * followed route, the Log records a flawless passage — and the public page
 * shows nothing at all, because `live_track` never receives a point. The only
 * explanation was one console warn, which nobody standing on a boat is reading.
 *
 * That has now cost two field days (2026-08-03 with a stale claim from a
 * previous install; 2026-08-08 after a sign-out minted this device a fresh id
 * while the cloud claim went on naming the old one). Both times every other
 * link in the chain was healthy, which is exactly what made it unfindable.
 *
 * So: while tracking, with live share ON and the claim held elsewhere, the Log
 * page says so and points at the fix.
 *
 * Deliberately NOT a takeover button. Takeover is a considered act with a
 * confirm that names the holder and when it was last seen (VesselHub's skipper
 * card), and the claim already has a documented history of gaining writers it
 * didn't need. This is a signpost, not a fifth door.
 */
import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { claimAgeLabel, holdsClaim } from '../../services/skipperDevice';

interface SkipperClaimNoticeProps {
    /** Only meaningful while a voyage is recording. */
    isTracking: boolean;
    /** Take the skipper to the Vessel page, where the takeover card lives. */
    onOpenVessel: () => void;
}

export const SkipperClaimNotice: React.FC<SkipperClaimNoticeProps> = ({ isTracking, onOpenVessel }) => {
    const liveShare = useSettingsStore((s) => s.settings.liveTrackShare);
    const claim = useSettingsStore((s) => s.settings.skipperDevice) ?? null;

    // Nothing to say when the skipper isn't publishing anyway, isn't recording,
    // or already holds the claim. `holdsClaim` mirrors the trickle's own gate —
    // no claim at all means publishing is allowed, so that is silence too.
    if (!isTracking || !liveShare || !claim?.deviceId || holdsClaim(claim)) return null;

    const holder = claim.deviceName?.trim() || 'Another device';

    return (
        <div className="shrink-0 px-4 pb-3">
            <div className="rounded-2xl border border-amber-500/25 bg-gradient-to-br from-amber-500/[0.10] via-amber-500/[0.04] to-transparent p-3.5">
                <div className="flex items-start gap-2.5">
                    <span className="mt-px text-base leading-none" aria-hidden="true">
                        ⚓
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-black uppercase tracking-widest text-amber-300">
                            Recording, not publishing
                        </div>
                        <p className="mt-1 text-[12px] leading-snug text-gray-300">
                            Live share is on, but <span className="font-bold text-white">{holder}</span> holds the
                            skipper claim
                            {claim.claimedAt ? ` (active ${claimAgeLabel(claim)})` : ''}. This passage is being logged
                            safely — it just isn&apos;t reaching your public page.
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onOpenVessel}
                    aria-label="Open the Vessel page to take over skipper publishing"
                    className="mt-2.5 h-10 w-full rounded-xl bg-amber-500/20 px-3 text-[10px] font-black uppercase tracking-[0.06em] text-amber-200 transition-colors active:brightness-110"
                >
                    Publish from this device
                </button>
            </div>
        </div>
    );
};

SkipperClaimNotice.displayName = 'SkipperClaimNotice';
