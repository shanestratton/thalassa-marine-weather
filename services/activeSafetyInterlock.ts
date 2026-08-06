/**
 * Prevent deliberate account departure while a device safety monitor is live.
 *
 * Involuntary session loss is handled by device-authoritative MOB/Anchor
 * recovery. Manual sign-out and destructive account deletion are different:
 * the skipper is present, so require an explicit Clear MOB / Weigh Anchor first
 * instead of silently changing identity underneath an armed monitor.
 */

import { Preferences } from '@capacitor/preferences';

import { authScopedStorageKey, getAuthIdentityScope } from './authIdentityScope';
import { hasAnchorWatchRecovery } from './anchorWatchRecoveryStorage';

export type AccountExitAction = 'sign out' | 'delete this account';

const MOB_RECOVERY_KEY = 'thalassa_mob_active_v1';
let liveMob = false;
let liveAnchor = false;

/** Lightweight live-state bridge. Keeping this module free of the full safety
 * services avoids initializing native listeners merely to press Sign Out. */
export function setLiveMobSafetyState(active: boolean): void {
    liveMob = active;
}

export function setLiveAnchorSafetyState(active: boolean): void {
    liveAnchor = active;
}

export class ActiveSafetyInterlockError extends Error {
    readonly code = 'ACTIVE_SAFETY_INTERLOCK';

    constructor(message: string) {
        super(message);
        this.name = 'ActiveSafetyInterlockError';
    }
}

export async function assertNoActiveSafetyMonitor(action: AccountExitAction): Promise<void> {
    const scope = getAuthIdentityScope();
    let mobRecoveryPresent = false;
    let anchorRecoveryPresent = false;
    try {
        const [deviceMob, legacyMob, secureAnchorRecoveryPresent] = await Promise.all([
            Preferences.get({ key: MOB_RECOVERY_KEY }),
            Preferences.get({ key: authScopedStorageKey(MOB_RECOVERY_KEY, scope) }),
            hasAnchorWatchRecovery(scope),
        ]);
        mobRecoveryPresent = deviceMob.value !== null || legacyMob.value !== null;
        anchorRecoveryPresent = secureAnchorRecoveryPresent;
    } catch (error) {
        throw new ActiveSafetyInterlockError(
            `Thalassa could not verify whether a safety monitor is active. Open Man Overboard and Anchor Watch, ` +
                `confirm both are clear, then try to ${action} again. (${String(error)})`,
        );
    }

    const mobActive = liveMob || mobRecoveryPresent;
    const anchorActive = liveAnchor || anchorRecoveryPresent;
    if (!mobActive && !anchorActive) return;

    const requiredActions = [mobActive ? 'Clear the Man Overboard emergency' : '', anchorActive ? 'Weigh Anchor' : '']
        .filter(Boolean)
        .join(' and ');
    const activeNames = [mobActive ? 'Man Overboard' : '', anchorActive ? 'Anchor Watch' : '']
        .filter(Boolean)
        .join(' and ');
    throw new ActiveSafetyInterlockError(
        `${activeNames} ${mobActive && anchorActive ? 'are' : 'is'} active on this device. ` +
            `${requiredActions} before you ${action}.`,
    );
}
