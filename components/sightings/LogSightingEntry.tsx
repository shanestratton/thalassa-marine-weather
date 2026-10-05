/**
 * The Log page's way in when this phone is NOT recording (accepted crew, and
 * a skipper who has not cast off in the app): the same Sighting pill, at the
 * top of the voyage list, whenever there is a boat to log from (your own, or
 * one you crew on). While recording, the pill rides on the live map instead
 * (pages/log/LiveVoyageCard.tsx).
 */
import React, { useSyncExternalStore } from 'react';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { useCrewingVessel } from '../../hooks/useCrewingVessel';
import { LogSightingPill } from './LogSightingPill';

const subscribeIdentity = (notify: () => void) => subscribeAuthIdentityScope(() => notify());
const userIdNow = () => getAuthIdentityScope().userId;

export const LogSightingEntry: React.FC<{
    /** The voyage cards' mini maps unmount while the sheet is up (iOS paints Leaflet above it). */
    onOpenChange?: (open: boolean) => void;
}> = ({ onOpenChange }) => {
    const userId = useSyncExternalStore(subscribeIdentity, userIdNow, userIdNow);
    const ownBoatId = useSettingsStore((s) => s.activeVesselId);
    const { vessel: crewing } = useCrewingVessel();
    if (!userId || (!ownBoatId && !crewing)) return null;
    return (
        <div className="mb-3 flex items-center justify-between gap-3" data-testid="log-sighting-entry">
            <p className="min-w-0 text-[13px] font-semibold text-slate-400">Seen something from the boat?</p>
            <LogSightingPill onOpenChange={onOpenChange} />
        </div>
    );
};
