import { getAuthIdentityScope } from './authIdentityScope';
import { useSettingsStore } from '../stores/settingsStore';

let vesselRevision = 0;
useSettingsStore.subscribe((next, previous) => {
    if ((next.activeVesselId ?? null) !== (previous.activeVesselId ?? null)) vesselRevision++;
});
/** A/B/A is a new edit context even when the selected vessel id is the same again. */
export function anchorSafeZoneContextKey(): string {
    const scope = getAuthIdentityScope();
    return JSON.stringify([
        scope.key,
        scope.generation,
        useSettingsStore.getState().activeVesselId ?? null,
        vesselRevision,
    ]);
}
