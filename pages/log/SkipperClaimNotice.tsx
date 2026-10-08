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
 * page says so — and since build 125 it fixes it in place. Shane 2026-10-09:
 * "tapping 'Publish from this device' on the Vessel page will fix it - - i
 * cannot find that message??" The button used to be a signpost to a Vessel
 * card that said something else (and, with the Pi primary, offered nothing).
 * It now opens the same deliberate confirm the card uses, naming the holder
 * and what we know about it (components/vessel/SkipperTakeover.tsx). A holder
 * forgotten for 6 h is taken over automatically by the trickle; this is for
 * the one seen recently, where a second device is a real conflict.
 */
import React, { useCallback, useEffect } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { claimSeenPhrase, holdsClaim, type SkipperClaim } from '../../services/skipperDevice';
import { SKIPPER_TAKEOVER_LABEL, useSkipperTakeover } from '../../components/vessel/SkipperTakeover';

interface SkipperClaimNoticeProps {
    /** Only meaningful while a voyage is recording. */
    isTracking: boolean;
}

export const SkipperClaimNotice: React.FC<SkipperClaimNoticeProps> = ({ isTracking }) => {
    const liveShare = useSettingsStore((s) => s.settings.liveTrackShare);
    const claim = useSettingsStore((s) => s.settings.skipperDevice) ?? null;
    const updateSettings = useSettingsStore((s) => s.updateSettings);
    const authenticatedUserId = useAuthStore((s) => s.user?.id ?? null);
    const apply = useCallback(
        (next: SkipperClaim) => {
            void updateSettings({ skipperDevice: next });
        },
        [updateSettings],
    );
    const takeover = useSkipperTakeover({ claim, authenticatedUserId, apply });

    // Nothing to say when the skipper isn't publishing anyway, isn't recording,
    // or already holds the claim. `holdsClaim` mirrors the trickle's own gate —
    // no claim at all means publishing is allowed, so that is silence too.
    const visible = isTracking && !!liveShare && !!claim?.deviceId && !holdsClaim(claim);
    const { cancel } = takeover;
    useEffect(() => {
        if (!visible) cancel();
    }, [cancel, visible]);
    if (!visible || !claim) return null;

    const holder = claim.deviceName?.trim() || 'Another device';

    return (
        <div className="shrink-0 px-4 pb-3">
            <div className="rounded-2xl border border-amber-500/25 bg-linear-to-br from-amber-500/10 via-amber-500/4 to-transparent p-3.5">
                <div className="flex items-start gap-2.5">
                    <span className="mt-px text-base leading-none" aria-hidden="true">
                        ⚓
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-black uppercase tracking-widest text-amber-300">
                            Recording, not publishing
                        </div>
                        <p
                            data-testid="skipper-claim-notice-text"
                            className="mt-1 text-[12px] leading-snug text-gray-300"
                        >
                            Live share is on, but <span className="font-bold text-white">{holder}</span> holds your
                            public page ({claimSeenPhrase(claim)}). This passage is being logged safely — it just
                            isn&apos;t being published from here.
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => takeover.ask()}
                    disabled={!takeover.canTakeOver}
                    className="mt-2.5 h-11 w-full rounded-xl bg-amber-500/20 px-3 text-xs font-black uppercase tracking-[0.06em] text-amber-200 transition-colors active:brightness-110 disabled:opacity-50"
                >
                    {SKIPPER_TAKEOVER_LABEL}
                </button>
            </div>
            {takeover.dialog}
        </div>
    );
};

SkipperClaimNotice.displayName = 'SkipperClaimNotice';
