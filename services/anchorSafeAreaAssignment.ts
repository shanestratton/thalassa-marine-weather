import { getPairing } from './PiPairingService';
import { useSettingsStore } from '../stores/settingsStore';
import { getAuthIdentityScope } from './authIdentityScope';
import { parseAnchorBoundary, type AnchorBoundaryEnvelope } from '../utils/anchorSafeZone';

export interface AnchorAreaAssignment {
    anchorLat: number;
    anchorLon: number;
    swingRadius: number;
    safeZone?: unknown;
}
export function anchorAssignmentSafeArea(a: AnchorAreaAssignment): AnchorBoundaryEnvelope | null {
    return a.safeZone === undefined
        ? null
        : parseAnchorBoundary({
              version: 1,
              frame: { latitude: a.anchorLat, longitude: a.anchorLon, radiusM: a.swingRadius },
              zone: a.safeZone,
          });
}
export function anchorSafeAreaPairKey(): string | null {
    const p = getPairing();
    return p ? JSON.stringify([p.deviceId, p.publicKeySpki, p.fingerprint, p.pairedAt]) : null;
}
export const anchorSafeAreaVesselId = () => useSettingsStore.getState().activeVesselId ?? null;
/** A custom-area command must stay with the same account generation, vessel revision and full pairing. */
export async function captureAnchorAreaLease() {
    const owner = getAuthIdentityScope(),
        pairKey = anchorSafeAreaPairKey(),
        vesselId = anchorSafeAreaVesselId();
    const { anchorSafeZoneContextKey } = await import('./anchorSafeZoneContext');
    if (
        !pairKey ||
        getAuthIdentityScope().generation !== owner.generation ||
        anchorSafeAreaPairKey() !== pairKey ||
        anchorSafeAreaVesselId() !== vesselId
    )
        return null;
    const context = anchorSafeZoneContextKey();
    return {
        pairKey,
        vesselId,
        ownerKey: owner.key,
        current: () => anchorSafeZoneContextKey() === context && anchorSafeAreaPairKey() === pairKey,
    };
}
