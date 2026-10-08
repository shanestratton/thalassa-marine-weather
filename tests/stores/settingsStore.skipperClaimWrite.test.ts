import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The claim's cloud writes (build 125, 125-12).
 *
 * The heartbeat and the automatic handover write the claim themselves, so the
 * write must not clobber a claim that changed in the cloud since this device
 * last looked: user_settings is written only through merge_user_settings (no
 * compare-and-swap without a migration), so writeSkipperClaimIfUnchanged
 * re-reads the cloud claim first and stands down when it moved — applying the
 * newer claim here instead, which is how a displaced device finds out.
 *
 * The claim rides in settings, which sync last-writer-wins: two devices
 * claiming while offline means one silently loses, and the loser must FIND
 * OUT. refreshSkipperClaim also waits for this device's own in-flight settings
 * write, so a takeover made a moment ago is not reverted by a read that beat
 * it to the server.
 */

const harness = vi.hoisted(() => ({
    preferences: {} as Record<string, string>,
    cloudClaim: {} as Record<string, Record<string, unknown> | null>,
    claimSelects: 0,
    cloudPatches: [] as Array<Record<string, unknown>>,
    failNextRpc: false,
    /** When set, the next merge_user_settings call waits for this to resolve. */
    holdRpc: null as Promise<void> | null,
    /** When set, the next claim read answers with what the cloud held when it
     *  was SENT, but only once this resolves (a slow round trip). */
    holdRead: null as Promise<void> | null,
    rpcUser: 'skipper-1',
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: harness.preferences[key] ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            harness.preferences[key] = value;
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            delete harness.preferences[key];
        }),
    },
}));

vi.mock('../../services/supabase', () => ({
    supabase: {
        from: vi.fn((table: string) => {
            let eqValue = '';
            let selectStr = '';
            const builder = {
                select: (s: string) => {
                    selectStr = s;
                    return builder;
                },
                eq: (_column: string, value: string) => {
                    eqValue = value;
                    return builder;
                },
                maybeSingle: async () => {
                    if (table === 'user_settings' && selectStr === 'settings->skipperDevice') {
                        harness.claimSelects += 1;
                        const claim = harness.cloudClaim[eqValue];
                        if (harness.holdRead) {
                            const hold = harness.holdRead;
                            harness.holdRead = null;
                            await hold;
                        }
                        return { data: claim === undefined ? null : { skipperDevice: claim }, error: null };
                    }
                    return { data: null, error: null };
                },
            };
            return builder;
        }),
        rpc: vi.fn(async (name: string, args?: { p_patch?: Record<string, unknown> }) => {
            if (name !== 'merge_user_settings' || !args?.p_patch) return { data: null, error: null };
            if (harness.holdRpc) {
                const hold = harness.holdRpc;
                harness.holdRpc = null;
                await hold;
            }
            if (harness.failNextRpc) {
                harness.failNextRpc = false;
                return { data: null, error: { message: 'network unreachable' } };
            }
            harness.cloudPatches.push(args.p_patch);
            // The server's shallow merge: a patched key replaces the stored one,
            // so the LAST write of skipperDevice wins.
            if (Object.prototype.hasOwnProperty.call(args.p_patch, 'skipperDevice')) {
                harness.cloudClaim[harness.rpcUser] = (args.p_patch.skipperDevice as Record<string, unknown>) ?? null;
            }
            return { data: null, error: null };
        }),
    },
}));

vi.mock('../../services/PiCacheService', () => ({
    piCache: { boot: vi.fn(), setDiaryRelayInternetPolicy: vi.fn(async () => false) },
}));
vi.mock('../../services/SubscriptionService', () => ({
    tierIsPro: (tier: string | undefined) => tier === 'crew' || tier === 'owner',
}));
vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('@capacitor/geolocation', () => ({
    Geolocation: { requestPermissions: vi.fn(async () => ({ location: 'granted' })) },
}));

type SettingsModule = typeof import('../../stores/settingsStore');

// Fictional devices (the repo is public).
const OLD_INSTALL = {
    deviceId: 'dev-fictional-old-install',
    deviceName: 'iPhone/iPad · 7e1a',
    claimedAt: '2026-09-07T00:00:00.000Z',
};
const THIS_PHONE = {
    deviceId: 'dev-fictional-this-phone',
    deviceName: 'iPhone · 9f3a',
    claimedAt: '2026-10-09T06:15:00.000Z',
};
const THE_TABLET = {
    deviceId: 'dev-fictional-tablet',
    deviceName: 'iPad · 77c1',
    claimedAt: '2026-10-09T06:16:00.000Z',
};

async function freshStore(): Promise<SettingsModule> {
    vi.resetModules();
    for (const key of Object.keys(harness.preferences)) delete harness.preferences[key];
    for (const key of Object.keys(harness.cloudClaim)) delete harness.cloudClaim[key];
    harness.claimSelects = 0;
    harness.cloudPatches.length = 0;
    harness.failNextRpc = false;
    harness.holdRpc = null;
    harness.holdRead = null;
    localStorage.clear();
    const identity = await import('../../services/authIdentityScope');
    const settings = await import('../../stores/settingsStore');
    identity.setAuthIdentityScope('skipper-1');
    settings.useSettingsStore.getState()._setUserId('skipper-1');
    await settings.awaitSettingsLoaded();
    harness.cloudPatches.length = 0;
    return settings;
}

const localClaim = (settings: SettingsModule) => settings.useSettingsStore.getState().settings.skipperDevice;
const setLocalClaim = (settings: SettingsModule, claim: unknown) =>
    settings.useSettingsStore.setState((s) => ({
        settings: { ...s.settings, skipperDevice: claim as typeof s.settings.skipperDevice },
    }));

beforeEach(() => {
    vi.clearAllMocks();
});

describe('writeSkipperClaimIfUnchanged', () => {
    it('writes when the cloud still holds the claim this device last saw, and applies it here', async () => {
        const settings = await freshStore();
        setLocalClaim(settings, OLD_INSTALL);
        harness.cloudClaim['skipper-1'] = { ...OLD_INSTALL };

        await expect(settings.writeSkipperClaimIfUnchanged(OLD_INSTALL, THIS_PHONE)).resolves.toBe('written');

        expect(harness.cloudPatches).toEqual([{ skipperDevice: THIS_PHONE }]);
        expect(localClaim(settings)).toEqual(THIS_PHONE);
        // Persisted, so a cold boot does not resurrect the old claim.
        expect(Object.values(harness.preferences).some((v) => v.includes('dev-fictional-this-phone'))).toBe(true);
    });

    it('stands down and applies the newer cloud claim when it moved (a heartbeat or a takeover landed)', async () => {
        const settings = await freshStore();
        setLocalClaim(settings, OLD_INSTALL);
        const heartbeat = { ...OLD_INSTALL, lastSeenAt: '2026-10-09T06:10:00.000Z' };
        harness.cloudClaim['skipper-1'] = heartbeat;

        await expect(settings.writeSkipperClaimIfUnchanged(OLD_INSTALL, THIS_PHONE)).resolves.toBe('changed');

        expect(harness.cloudPatches).toHaveLength(0);
        expect(localClaim(settings)).toEqual(heartbeat);
    });

    it('a failed write leaves the local claim alone', async () => {
        const settings = await freshStore();
        setLocalClaim(settings, OLD_INSTALL);
        harness.cloudClaim['skipper-1'] = { ...OLD_INSTALL };
        harness.failNextRpc = true;

        await expect(settings.writeSkipperClaimIfUnchanged(OLD_INSTALL, THIS_PHONE)).resolves.toBe('failed');
        expect(localClaim(settings)).toEqual(OLD_INSTALL);
    });
});

describe('a Release tapped on this device while a heartbeat is in flight', () => {
    const beat = { ...THIS_PHONE, lastSeenAt: '2026-10-09T06:45:00.000Z' };

    it('during the heartbeat’s read: the heartbeat stands down and the release stands', async () => {
        const settings = await freshStore();
        setLocalClaim(settings, THIS_PHONE);
        harness.cloudClaim['skipper-1'] = { ...THIS_PHONE };
        let answer!: () => void;
        harness.holdRead = new Promise<void>((resolve) => {
            answer = resolve;
        });

        const write = settings.writeSkipperClaimIfUnchanged(THIS_PHONE, beat);
        await new Promise((resolve) => setTimeout(resolve, 5));
        // The skipper taps "Release — stop being primary" (null on the wire).
        await settings.useSettingsStore.getState().updateSettings({ skipperDevice: null });
        await new Promise((resolve) => setTimeout(resolve, 5));
        answer();

        await expect(write).resolves.toBe('changed');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(localClaim(settings) ?? null).toBeNull();
        expect(harness.cloudClaim['skipper-1']).toBeNull();
        expect(harness.cloudPatches).toEqual([{ skipperDevice: null }]);
    });

    it('during the heartbeat’s write: this device’s release is sent again, so it lands last', async () => {
        const settings = await freshStore();
        setLocalClaim(settings, THIS_PHONE);
        harness.cloudClaim['skipper-1'] = { ...THIS_PHONE };
        let land!: () => void;
        harness.holdRpc = new Promise<void>((resolve) => {
            land = resolve;
        });

        const write = settings.writeSkipperClaimIfUnchanged(THIS_PHONE, beat);
        await new Promise((resolve) => setTimeout(resolve, 5));
        // The release overtakes the slow heartbeat to the server…
        await settings.useSettingsStore.getState().updateSettings({ skipperDevice: null });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(harness.cloudClaim['skipper-1']).toBeNull();
        // …and the heartbeat lands after it, bringing the claim back.
        land();

        await expect(write).resolves.toBe('changed');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(localClaim(settings) ?? null).toBeNull();
        // The release was sent again on this device's ordered queue: last word.
        expect(harness.cloudClaim['skipper-1']).toBeNull();
        expect(harness.cloudPatches).toEqual([
            { skipperDevice: null },
            { skipperDevice: beat },
            { skipperDevice: null },
        ]);
    });

    it('a claim already changed here before the heartbeat started is not even read', async () => {
        const settings = await freshStore();
        setLocalClaim(settings, null);
        harness.cloudClaim['skipper-1'] = { ...THIS_PHONE };
        await expect(settings.writeSkipperClaimIfUnchanged(THIS_PHONE, beat)).resolves.toBe('changed');
        expect(harness.claimSelects).toBe(0);
        expect(harness.cloudPatches).toEqual([]);
    });
});

describe('refreshSkipperClaim and the heartbeat', () => {
    it('lands the holder’s heartbeat on the other device (same holder, new lastSeenAt)', async () => {
        const settings = await freshStore();
        setLocalClaim(settings, OLD_INSTALL);
        const beat = { ...OLD_INSTALL, deviceName: 'iPad · 7e1a', lastSeenAt: '2026-10-09T06:00:00.000Z' };
        harness.cloudClaim['skipper-1'] = beat;

        await settings.refreshSkipperClaim({ maxAgeMs: 0 });

        expect(localClaim(settings)).toEqual(beat);
        expect(harness.cloudPatches).toHaveLength(0);
    });

    it('waits for this device’s own takeover to reach the server before reading', async () => {
        const settings = await freshStore();
        setLocalClaim(settings, OLD_INSTALL);
        harness.cloudClaim['skipper-1'] = { ...OLD_INSTALL };
        let release!: () => void;
        harness.holdRpc = new Promise<void>((resolve) => {
            release = resolve;
        });

        await settings.useSettingsStore.getState().updateSettings({ skipperDevice: THIS_PHONE });
        const refresh = settings.refreshSkipperClaim({ maxAgeMs: 0 });
        await new Promise((resolve) => setTimeout(resolve, 10));
        // The read has not raced the write and reverted the takeover.
        expect(localClaim(settings)).toEqual(THIS_PHONE);
        release();
        await refresh;
        expect(localClaim(settings)).toEqual(THIS_PHONE);
        expect(harness.cloudClaim['skipper-1']).toEqual(THIS_PHONE);
    });
});

describe('two devices claiming while offline', () => {
    it('the last write wins, and the loser finds out on its next refresh', async () => {
        const settings = await freshStore();
        const skipper = await import('../../services/skipperDevice');
        // This phone claimed while offline; its write reached the server first.
        localStorage.setItem('thalassa_device_id', THIS_PHONE.deviceId);
        setLocalClaim(settings, THIS_PHONE);
        skipper.rememberHeld(true);
        harness.cloudClaim['skipper-1'] = { ...THIS_PHONE };
        // The tablet claimed offline too, and its write landed LAST.
        harness.rpcUser = 'skipper-1';
        const { supabase } = await import('../../services/supabase');
        await supabase!.rpc('merge_user_settings', { p_patch: { skipperDevice: THE_TABLET } });
        expect(harness.cloudClaim['skipper-1']).toEqual(THE_TABLET);

        await settings.refreshSkipperClaim({ maxAgeMs: 0 });

        const now = localClaim(settings);
        expect(now).toEqual(THE_TABLET);
        expect(skipper.holdsClaim(now)).toBe(false);
        expect(skipper.mayPublish(now)).toBe(false);
        expect(skipper.hasBeenDisplaced(now, skipper.readRememberedHeld())).toBe(true);
    });
});
