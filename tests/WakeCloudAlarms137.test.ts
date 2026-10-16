import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const f = vi.hoisted(() => ({
    owner: '00000000-0000-4000-8000-000000000001',
    pi: '00000000-0000-4000-8000-000000000002',
    scope: { key: 'owner', userId: '00000000-0000-4000-8000-000000000001', generation: 1 },
    pair: { deviceId: '00000000-0000-4000-8000-000000000002', pairedAt: 'fictional' },
    satellite: false,
    sessionOwner: '00000000-0000-4000-8000-000000000001',
    queries: [] as unknown[],
    rpc: [] as unknown[],
    answers: [] as Array<unknown | (() => Promise<unknown>)>,
    rpcAnswer: { data: 1, error: null } as unknown,
    listeners: [] as (() => void)[],
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => f.scope,
    isAuthIdentityScopeCurrent: (s: unknown) => s === f.scope,
    subscribeAuthIdentityScope: (cb: () => void) => {
        f.listeners.push(cb);
        return () => {};
    },
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => f.pair }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => f.satellite }));
vi.mock('@capacitor/app', () => ({
    App: {
        getState: async () => ({ isActive: document.visibilityState !== 'hidden' }),
        addListener: async () => ({ remove: async () => {} }),
    },
}));
vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getSession: async () => ({ data: { session: { user: { id: f.sessionOwner } } } }) },
        from: (table: string) => {
            const log: unknown[] = [table];
            f.queries.push(log);
            const chain: Record<string, unknown> = {};
            for (const method of ['select', 'eq', 'in', 'is', 'limit', 'order'])
                chain[method] = (...args: unknown[]) => {
                    log.push([method, ...args]);
                    return chain;
                };
            chain.abortSignal = () => {
                const next = f.answers.shift();
                return typeof next === 'function' ? next() : Promise.resolve(next ?? { data: [], error: null });
            };
            return chain;
        },
        rpc: (name: string, args: unknown) => {
            f.rpc.push([name, args]);
            return { abortSignal: () => Promise.resolve(f.rpcAnswer) };
        },
    },
}));
const at = Date.parse('2026-10-17T00:00:00Z'),
    revision = '00000000-0000-4000-8000-000000000006',
    digest = 'c'.repeat(64),
    source = 'd'.repeat(64);
const key = `wake-wind:aaaaaaaaaaaa:${at - 1000}`;
function fixtures() {
    const kinds = [
        'wake-depth',
        'wake-wind',
        'wake-speed',
        'wake-pressure',
        'wake-coolant',
        'wake-oil',
        'wake-rpm',
        'wake-battery',
    ];
    const profile = {
        binding: {
            ownerId: f.owner,
            piDeviceId: f.pi,
            pairingId: 'a'.repeat(64),
            deviceId: '00000000-0000-4000-8000-000000000003',
            enrollmentRevision: 'b'.repeat(64),
            feedId: `pi:${f.pi}:${'a'.repeat(24)}`,
        },
        rulesDigest: digest,
        configurationRevision: '00000000-0000-4000-8000-000000000004',
        instance: '00000000-0000-4000-8000-000000000005',
        rules: kinds.map((kind) => ({ kind, enabled: true, sourceKey: source, threshold: 25, quietHours: null })),
    };
    const contexts = [{ revision, profile }],
        event = {
            owner_id: f.owner,
            context_revision: revision,
            rules_digest: digest,
            kind: 'wake-wind',
            alarm_key: key,
            source_key: source,
            raised_at_ms: at - 1000,
            source_at_ms: at,
            measured_value: 30,
            threshold: 25,
            quiet: false,
            source_qualified: true,
        };
    const ref = { ownerId: f.owner, piDeviceId: f.pi, contextRevision: revision, rulesDigest: digest, key };
    return { contexts, event, ref };
}
beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(at);
    f.satellite = false;
    f.sessionOwner = f.owner;
    f.queries = [];
    f.rpc = [];
    f.answers = [];
    f.listeners = [];
    f.scope = { key: 'owner', userId: f.owner, generation: 1 };
    f.pair = { deviceId: f.pi, pairedAt: 'fictional' };
    f.rpcAnswer = { data: 1, error: null };
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});
describe('wake cloud cards and explicit acknowledgements', () => {
    it('uses original source time and keeps stale/unknown alarms without fabricated measured values', async () => {
        const { wakeCloudCards } = await import('../services/alarms/wakeCloudAlarms'),
            { contexts, event } = fixtures();
        expect(wakeCloudCards([event], contexts, f.owner, f.pi, at)[0].value).toBe(30);
        expect(wakeCloudCards([event], contexts, f.owner, f.pi, at + 13_001)[0]).toMatchObject({
            value: null,
            status: 'unknown',
        });
        expect(
            wakeCloudCards([{ ...event, source_qualified: false }], contexts, f.owner, f.pi, at)[0].value,
        ).toBeNull();
        for (const patch of [
            { owner_id: 'other' },
            { rules_digest: 'e'.repeat(64) },
            { source_key: 'e'.repeat(64) },
            { threshold: 26 },
            { source_at_ms: at + 1001 },
            { measured_value: -1 },
            { kind: 'collision' },
            { alarm_key: `wake-rpm:aaaaaaaaaaaa:${at - 1000}` },
        ])
            expect(() => wakeCloudCards([{ ...event, ...patch }], contexts, f.owner, f.pi, at)).toThrow();
    });
    it('only an explicit valid user ACK sends the fixed RPC; missing session/Satellite Mode/foreign context sends none', async () => {
        const { acknowledgeWakeAlarm } = await import('../services/alarms/wakeAlarmAcknowledgement'),
            { contexts, ref } = fixtures();
        f.answers = [{ data: contexts, error: null }];
        expect(await acknowledgeWakeAlarm(ref)).toBe(true);
        expect(f.rpc).toEqual([['acknowledge_pi_wake_alarm', { p_alarm_key: key, p_rules_digest: digest }]]);
        f.rpc = [];
        f.satellite = true;
        expect(await acknowledgeWakeAlarm(ref)).toBe(false);
        expect(f.rpc).toEqual([]);
        f.satellite = false;
        f.sessionOwner = 'other';
        expect(await acknowledgeWakeAlarm(ref)).toBe(false);
        expect(f.rpc).toEqual([]);
        f.sessionOwner = f.owner;
        f.answers = [
            {
                data: [{ ...contexts[0], profile: { ...contexts[0].profile, rulesDigest: 'e'.repeat(64) } }],
                error: null,
            },
        ];
        expect(await acknowledgeWakeAlarm(ref)).toBe(false);
        expect(f.rpc).toEqual([]);
        expect(await acknowledgeWakeAlarm({ ...ref, key: 'collision::123456789' })).toBe(false);
    });
    it('account/pair change while context is being read cannot send or optimistically confirm ACK', async () => {
        const { acknowledgeWakeAlarm } = await import('../services/alarms/wakeAlarmAcknowledgement'),
            { contexts, ref } = fixtures();
        let finish!: (v: unknown) => void;
        f.answers = [
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        ];
        const pending = acknowledgeWakeAlarm(ref);
        await vi.waitFor(() => expect(f.queries).toHaveLength(1));
        f.scope = { ...f.scope, generation: 2 };
        f.pair = { ...f.pair, pairedAt: 'replacement' };
        finish({ data: contexts, error: null });
        expect(await pending).toBe(false);
        expect(f.rpc).toEqual([]);
    });
    it('never retries an uncertain ACK or treats zero/malformed affected counts as success', async () => {
        const { acknowledgeWakeAlarm } = await import('../services/alarms/wakeAlarmAcknowledgement'),
            { contexts, ref } = fixtures();
        for (const response of [
            { data: 0, error: null },
            { data: '1', error: null },
            { data: null, error: { code: 'synthetic' } },
        ]) {
            f.answers = [{ data: contexts, error: null }];
            f.rpcAnswer = response;
            expect(await acknowledgeWakeAlarm(ref)).toBe(false);
        }
        expect(f.rpc).toHaveLength(3);
    });
    it('bounds a hung context read and cannot send after its timeout later resolves', async () => {
        const { acknowledgeWakeAlarm } = await import('../services/alarms/wakeAlarmAcknowledgement'),
            { contexts, ref } = fixtures();
        let finish!: (r: unknown) => void;
        f.answers = [
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        ];
        const pending = acknowledgeWakeAlarm(ref);
        await vi.waitFor(() => expect(f.queries).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(8000);
        expect(await pending).toBe(false);
        finish({ data: contexts, error: null });
        await Promise.resolve();
        expect(f.rpc).toEqual([]);
    });
    it('rechecks current context before publishing, bounds queries, and retires old cards on a changed profile', async () => {
        const { refreshWakeCloudAlarms } = await import('../services/alarms/wakeCloudAlarms'),
            { WakeAlarmStore } = await import('../services/alarms/wakeAlarmStore'),
            { contexts, event } = fixtures();
        f.answers = [
            { data: contexts, error: null },
            { data: [event], error: null },
            { data: contexts, error: null },
        ];
        await refreshWakeCloudAlarms();
        expect(WakeAlarmStore.get()).toHaveLength(1);
        expect(f.rpc).toHaveLength(0);
        expect(JSON.stringify(f.queries)).toContain('profile->binding->>piDeviceId');
        expect(JSON.stringify(f.queries)).toContain('["limit",16]');
        f.answers = [
            { data: contexts, error: null },
            { data: [event], error: null },
            { data: [], error: null },
        ];
        await refreshWakeCloudAlarms();
        expect(WakeAlarmStore.get()).toEqual([]);
    });
    it('Satellite/background reads make zero WAN calls; original values expire locally after a failed or blocked refresh', async () => {
        const { refreshWakeCloudAlarms, wakeCloudCards } = await import('../services/alarms/wakeCloudAlarms'),
            { WakeAlarmStore } = await import('../services/alarms/wakeAlarmStore'),
            { contexts, event } = fixtures();
        WakeAlarmStore.publishCloud(wakeCloudCards([event], contexts, f.owner, f.pi, at));
        f.satellite = true;
        await refreshWakeCloudAlarms();
        expect(f.queries).toEqual([]);
        await vi.advanceTimersByTimeAsync(13_001);
        expect(WakeAlarmStore.get()[0]).toMatchObject({ value: null, status: 'unknown' });
        f.satellite = false;
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        await refreshWakeCloudAlarms();
        expect(f.queries).toEqual([]);
        f.scope = { ...f.scope, generation: 2 };
        for (const listener of f.listeners) listener();
        expect(WakeAlarmStore.get()).toEqual([]);
    });
});
