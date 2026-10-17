import { supabase } from '../supabase';
import { GpsService } from '../GpsService';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { BoatPresenceController, type PresenceContext } from './BoatPresenceController';

function context(): PresenceContext {
    const auth = getAuthIdentityScope(),
        s = useSettingsStore.getState();
    const vessel = s.vesselFleet.find(
        (v) => v.id === s.activeVesselId && v.owner_id === auth.userId && !v.archived_at && !v.releasedAt,
    );
    const identity = `${auth.key}:${auth.generation}`;
    return {
        identity,
        key: `${identity}|${s.activeVesselId ?? ''}|${vessel?.id ?? ''}`,
        userId: auth.userId,
        vesselId: vessel?.id ?? null,
        allowed:
            !!auth.userId &&
            !s.settings.satelliteMode &&
            (typeof navigator === 'undefined' || navigator.onLine !== false),
    };
}
async function request(action: string, input: Record<string, unknown>, captured: PresenceContext): Promise<unknown> {
    const client = supabase;
    if (!client) throw new Error('Boat presence is unavailable');
    const current = () => {
        const c = context();
        return (
            c.allowed &&
            c.userId === captured.userId &&
            c.identity === captured.identity &&
            (action === 'end' || c.key === captured.key)
        );
    };
    if (!current()) throw new Error('Presence context changed');
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            abort.abort();
            reject(new Error('Presence request timed out'));
        }, 6000);
    });
    const run = async () => {
        const { data, error } = await client.auth.getSession();
        if (abort.signal.aborted || error || data.session?.user.id !== captured.userId || !current())
            throw new Error('Sign in again to use boat presence');
        const response = await client
            .rpc('boat_presence_control', { p_action: action, p_input: input })
            .abortSignal(abort.signal);
        if (abort.signal.aborted || !current()) throw new Error('Presence context changed');
        if (response.error) throw new Error('Presence request refused; reload controls and check your connection');
        return response.data as unknown;
    };
    try {
        return await Promise.race([run(), timeout]);
    } finally {
        clearTimeout(timer);
    }
}
export const boatPresence = new BoatPresenceController({
    context,
    request,
    fix: () => GpsService.getLastKnownPosition(),
    uuid: () => crypto.randomUUID(),
    wall: () => Date.now(),
    monotonic: () => performance.now(),
});
let previous = context();
function fence() {
    const next = context();
    if (next.key !== previous.key || next.allowed !== previous.allowed)
        boatPresence.retire('Account, vessel or connection changed; start again explicitly');
    previous = next;
}
subscribeAuthIdentityScope(fence);
useSettingsStore.subscribe(fence);
if (typeof window !== 'undefined') {
    window.addEventListener('offline', fence);
    window.addEventListener('online', fence);
    window.addEventListener('pagehide', () => boatPresence.setForeground(false));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') boatPresence.setForeground(false);
    });
}
