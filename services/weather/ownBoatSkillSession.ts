/** Loaded only by explicit private scorecard review. No cloud instrument writes. */
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    OWN_BOAT_SKILL_CAPABILITY_KEY,
    subscribeAuthIdentityScope,
} from '../authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { getAuthenticatedFunctionHeaders } from '../supabaseAuth';
import * as pairing from '../PiPairingService';
import { piCache } from '../PiCacheService';
import { isPinnedTransportAvailable } from '../piTls';
import { withDeadline } from '../../utils/deadline';
import {
    OWN_BOAT_SKILL,
    ownBoatExact,
    ownBoatHex,
    ownBoatRecord,
    parseOwnBoatConsent,
    type OwnBoatCapability,
} from '../../utils/ownBoatSkill';
import { createPrivateBoatSession, type PrivateBoatSession } from './ownBoatSkillTransaction';
let pending = 0;
export async function openOwnBoatSkillReview(): Promise<PrivateBoatSession> {
    const scope = getAuthIdentityScope(),
        settings = useSettingsStore.getState(),
        vessel = settings.vesselFleet.find((v) => v.id === settings.activeVesselId),
        pair = pairing.getPairing(),
        base = piCache.lanBaseUrlNow(),
        revision = pairing.getPiEquipmentReadRevision();
    if (
        !scope.userId ||
        !vessel ||
        vessel.owner_id !== scope.userId ||
        vessel.archived_at ||
        vessel.releasedAt ||
        !Number.isSafeInteger(vessel.revision) ||
        !pair ||
        !base ||
        !isPinnedTransportAvailable()
    )
        throw Error('Sign in, select an owned vessel and connect to its paired Pi on boat Wi-Fi.');
    const pairKey = JSON.stringify([pair.deviceId, pair.publicKeySpki, pair.pairedAt]);
    const samePi = () =>
        pairing.getPiEquipmentReadRevision() === revision &&
        piCache.lanBaseUrlNow() === base &&
        isPinnedTransportAvailable() &&
        JSON.stringify([
            pairing.getPairing()?.deviceId,
            pairing.getPairing()?.publicKeySpki,
            pairing.getPairing()?.pairedAt,
        ]) === pairKey;
    let retired = false;
    const ownedContextCurrent = () => {
        const state = useSettingsStore.getState(),
            value = state.vesselFleet.find((v) => v.id === vessel.id);
        return (
            !retired &&
            isAuthIdentityScopeCurrent(scope) &&
            samePi() &&
            state.activeVesselId === vessel.id &&
            value?.owner_id === scope.userId &&
            !value.archived_at &&
            !value.releasedAt &&
            value.revision === vessel.revision
        );
    };
    const current = () => ownedContextCurrent() && document.visibilityState !== 'hidden';
    const guard = () => {
        if (!current()) throw Error('Private vessel or paired Pi review changed.');
    };
    guard();
    const { App } = await import('@capacitor/app');
    guard();
    const setup = await withDeadline(Promise.all([pairing.getChartDevice(), App.getState()]), 5000, 'Private Pi setup');
    guard();
    if (!setup[0] || !setup[1].isActive) throw Error('Enroll this phone on the paired Pi before private review.');
    const controllerId = setup[0].chartDeviceId;
    const key = authScopedStorageKey(OWN_BOAT_SKILL_CAPABILITY_KEY, scope);
    let saved: OwnBoatCapability | null = null;
    try {
        const text = localStorage.getItem(key);
        if (text && text.length <= 8192) {
            const row = JSON.parse(text),
                cap = ownBoatRecord(row) && ownBoatRecord(row.value) ? row.value : null;
            const consent = cap ? parseOwnBoatConsent(cap.consent) : null;
            if (
                ownBoatRecord(row) &&
                ownBoatExact(row, ['schema', 'pairKey', 'value']) &&
                row.schema === 1 &&
                row.pairKey === pairKey &&
                cap &&
                ownBoatExact(cap, ['schema', 'capability', 'consent']) &&
                cap.schema === 1 &&
                ownBoatHex(cap.capability) &&
                consent
            )
                saved = { schema: 1, capability: cap.capability, consent };
        }
    } catch {
        /* Corrupt storage grants no access. Explicit review can replace it. */
    }
    let offAuth = () => {},
        offSettings = () => {},
        appListener: Promise<{ remove(): Promise<void> }> | null = null;
    const release = () => {
        if (retired) return;
        retired = true;
        offAuth();
        offSettings();
        document.removeEventListener('visibilitychange', hidden);
        void appListener?.then((h) => h.remove()).catch(() => undefined);
    };
    const session = createPrivateBoatSession({
        ownerId: scope.userId,
        vesselId: vessel.id,
        vesselRevision: vessel.revision!,
        vesselName: vessel.profile.name,
        piDeviceId: pair.deviceId,
        controllerId,
        current,
        samePi,
        saved,
        now: Date.now,
        monotonic: () => performance.now(),
        onRelease: release,
        save(value) {
            if (value) {
                guard();
                const text = JSON.stringify({ schema: 1, pairKey, value });
                localStorage.setItem(key, text);
                if (localStorage.getItem(key) !== text) throw Error('Private access storage unavailable.');
            } else localStorage.removeItem(key);
        },
        async jwt() {
            guard();
            const headers = await withDeadline(getAuthenticatedFunctionHeaders(), 5000, 'Private owner verification');
            guard();
            if (!headers.Authorization?.startsWith('Bearer ')) throw Error('Fresh owner sign-in is required.');
            return headers.Authorization.slice(7);
        },
        async request(path, body, jwt, cleanup) {
            if (cleanup ? !samePi() : !current()) throw Error('Original paired Pi unavailable.');
            if (pending >= 2) throw Error('Private Pi request capacity is held. Try again after it settles.');
            pending++;
            try {
                const reply = await pairing.pinnedPiRequest({
                    url: base + '/api/own-boat-skill/' + path,
                    method: body === undefined ? 'GET' : 'POST',
                    data: body,
                    headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: 'Bearer ' + jwt } : {}) },
                    connectTimeout: 2500,
                    readTimeout: OWN_BOAT_SKILL.piReadMs,
                    responseType: 'text',
                    isCurrent: cleanup ? samePi : current,
                });
                if (
                    reply.status !== 200 ||
                    typeof reply.data !== 'string' ||
                    reply.data.length > OWN_BOAT_SKILL.responseBytes ||
                    new TextEncoder().encode(reply.data).length > OWN_BOAT_SKILL.responseBytes
                )
                    throw Error('Private Pi scorecard could not be confirmed.');
                // Deliver late grants to the transaction's cleanup; never adopt
                // them under a new account or vessel.
                return JSON.parse(reply.data);
            } finally {
                pending--;
            }
        },
    });
    const hidden = () => {
        if (document.visibilityState === 'hidden') session.release();
    };
    offAuth = subscribeAuthIdentityScope(() => session.retire());
    offSettings = useSettingsStore.subscribe(() => {
        if (!ownedContextCurrent()) session.retire();
    });
    document.addEventListener('visibilitychange', hidden);
    appListener = App.addListener('appStateChange', (state) => {
        if (!state.isActive) session.release();
    });
    if (retired) void appListener.then((h) => h.remove()).catch(() => undefined);
    if (!current()) {
        session.release();
        throw Error('Private review retired during setup.');
    }
    return session;
}
