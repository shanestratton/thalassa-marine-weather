import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const f = vi.hoisted(() => ({
    paired: true,
    native: true,
    base: 'https://boat.local:8080' as string | null,
    foreground: true,
    pairing: {
        deviceId: '22222222-2222-4222-8222-222222222222',
        publicKeySpki: 'fictional-pin',
        pairedAt: '2026-10-16',
    },
    chart: vi.fn(),
    request: vi.fn(),
    app: null as null | ((s: { isActive: boolean }) => void),
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => (f.paired ? f.pairing : null),
    getChartDevice: f.chart,
    pinnedPiRequest: f.request,
}));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => f.native }));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => f.base } }));
vi.mock('@capacitor/app', () => ({
    App: {
        getState: async () => ({ isActive: f.foreground }),
        addListener: async (_event: string, cb: (s: { isActive: boolean }) => void) => {
            f.app = cb;
            return {
                remove: async () => {
                    if (f.app === cb) f.app = null;
                },
            };
        },
    },
}));
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { defaultWakeRules, wakeRulesCanonical } from '../utils/wakeRule';
import { saveWakeRulePreferences } from '../services/alarms/wakeRulePreferences';
import { getWakeRuleSources } from '../services/alarms/wakeRuleSources';
import { WakeRuleWatchClass } from '../services/alarms/WakeRuleWatch';
import { parseWakePiSensors, parseWakePiStatus } from '../services/alarms/wakePiWire';
const OWNER = '11111111-1111-4111-8111-111111111111',
    DEVICE = '33333333-3333-4333-8333-333333333333';
const REV = '44444444-4444-4444-8444-444444444444',
    INSTANCE = '55555555-5555-4555-8555-555555555555';
const NOW = Date.parse('2026-10-16T00:00:00Z');
const binding = () => ({
    ownerId: OWNER,
    piDeviceId: f.pairing.deviceId,
    pairingId: 'a'.repeat(64),
    deviceId: DEVICE,
    enrollmentRevision: 'b'.repeat(64),
    feedId: `pi:${f.pairing.deviceId}:${'c'.repeat(24)}`,
});
const selection = () => ({ feedId: binding().feedId, sensorId: 'sounder.1', reference: 'below-keel' });
let at = NOW,
    depth = 2;
const pressure = { state: 'unavailable', sampleCount: 0, spanMs: 0 };
const sensors = () => ({
    schema: 1,
    update: 7,
    binding: binding(),
    draftM: null,
    servedAt: Date.now(),
    truncated: false,
    pressure,
    options: [
        {
            preset: 'depth-below-keel',
            selection: selection(),
            label: 'Sounder below keel',
            measuredAt: at,
            reading: { preset: 'depth-below-keel', selection: selection(), value: depth, at, depthBasis: 'below-keel' },
        },
    ],
});
const status = () => ({
    schema: 1,
    update: 7,
    instance: INSTANCE,
    binding: binding(),
    configured: false,
    configuration: null,
    running: false,
    reason: 'off',
    proof: null,
    rules: [],
    pressure,
    push: { state: 'unavailable', capability: 0 },
    servedAt: Date.now(),
});
const response = (data: unknown, status = 200) => ({ data: JSON.stringify(data), status });
const savedConfiguration = () => ({
    schema: 1,
    revision: REV,
    binding: { ...binding(), deviceId: '77777777-7777-4777-8777-777777777777', enrollmentRevision: 'd'.repeat(64) },
    draftM: null,
    rules: defaultWakeRules(),
    rulesDigest: createHash('sha256').update(wakeRulesCanonical(defaultWakeRules(), null)).digest('hex'),
    configuredAt: NOW,
});
const audio = { acquire: vi.fn(async () => 'owned-wake-lease'), releaseEventually: vi.fn() };
const service = new WakeRuleWatchClass(async () => audio);
const flush = async () => {
    for (let n = 0; n < 8; n++) await Promise.resolve();
};
const selectedRules = () => {
    const r = defaultWakeRules();
    r[0] = { ...r[0], enabled: true, selection: selection(), minimumDurationMs: 0, clearDurationMs: 0 };
    return r;
};
beforeEach(() => {
    service.stop('off', true);
    localStorage.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope(OWNER);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('crypto', {
        subtle: {
            digest: async (_algorithm: string, bytes: Uint8Array) =>
                Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
        },
    });
    f.paired = f.native = f.foreground = true;
    f.base = 'https://boat.local:8080';
    f.pairing.pairedAt = '2026-10-16';
    f.chart.mockReset().mockResolvedValue({ chartDeviceId: DEVICE });
    f.request.mockReset();
    audio.acquire.mockClear();
    audio.releaseEventually.mockClear();
    at = NOW;
    depth = 2;
    saveWakeRulePreferences(defaultWakeRules(), getAuthIdentityScope());
    f.request.mockImplementation(async (o: { url: string }) =>
        response(o.url.endsWith('/status') ? status() : sensors()),
    );
});
afterEach(() => {
    service.stop('off', true);
    setAuthIdentityScope(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
describe('bounded wake wire', () => {
    it('preserves a bounded current cloud conflict summary for explicit review and rejects unknown policy fields', () => {
        const conflict = {
            revision: REV,
            configurationRevision: REV,
            rulesDigest: 'c'.repeat(64),
            feedMatches: false,
            retired: true,
            rules: defaultWakeRules().map((r) => ({
                preset: r.preset,
                enabled: false,
                threshold: null,
                sourceMatches: false,
                quietHours: null,
            })),
        };
        const raw = { ...status(), push: { state: 'conflict', capability: 0, conflict } };
        expect(parseWakePiStatus(JSON.stringify(raw), NOW).push.conflict).toEqual(conflict);
        expect(() =>
            parseWakePiStatus(
                JSON.stringify({
                    ...raw,
                    push: { ...raw.push, conflict: { ...conflict, url: 'https://invalid.example' } },
                }),
                NOW,
            ),
        ).toThrow();
        const malformed = structuredClone(raw);
        Object.assign(malformed.push.conflict.rules[0], {
            quietHours: { startMinute: 0, endMinute: 0, utcOffsetMinutes: 0 },
        });
        expect(() => parseWakePiStatus(JSON.stringify(malformed), NOW)).toThrow();
    });
    it('preserves the arming phone’s binding in a keeper proof read by another enrolled phone', () => {
        const rules = selectedRules();
        const configuration = {
            ...savedConfiguration(),
            rules,
            rulesDigest: createHash('sha256').update(wakeRulesCanonical(rules, null)).digest('hex'),
        };
        const proof = {
            update: 7,
            ownerId: OWNER,
            feedId: binding().feedId,
            rulesDigest: configuration.rulesDigest,
            running: true,
            evaluatedAt: NOW,
            binding: { ...configuration.binding },
            revision: REV,
            instance: INSTANCE,
        };
        const parsed = parseWakePiStatus(
            JSON.stringify({ ...status(), configured: true, running: true, reason: 'watching', configuration, proof }),
            NOW,
        );
        expect(parsed.binding).toEqual(binding());
        expect(parsed.proof?.binding).toEqual(configuration.binding);
        expect(parsed.proof?.binding.deviceId).not.toBe(parsed.binding?.deviceId);
        for (const changed of [{ running: false }, { reason: 'awaiting-sensors' }]) {
            expect(() =>
                parseWakePiStatus(
                    JSON.stringify({
                        ...status(),
                        configured: true,
                        running: true,
                        reason: 'watching',
                        configuration,
                        proof,
                        ...changed,
                    }),
                    NOW,
                ),
            ).toThrow();
        }
        proof.binding = binding();
        expect(() =>
            parseWakePiStatus(
                JSON.stringify({
                    ...status(),
                    configured: true,
                    running: true,
                    reason: 'watching',
                    configuration,
                    proof,
                }),
                NOW,
            ),
        ).toThrow();
    });
    it('shows another enrolled phone’s saved rules for the same boat without borrowing its caller authority', () => {
        const configuration = savedConfiguration();
        const s = { ...status(), configured: true, configuration };
        expect(parseWakePiStatus(JSON.stringify(s), NOW).configuration?.binding.deviceId).toBe(
            configuration.binding.deviceId,
        );
        s.configuration.binding.ownerId = '88888888-8888-4888-8888-888888888888';
        expect(() => parseWakePiStatus(JSON.stringify(s), NOW)).toThrow();
    });
    it('retains an old feed configuration solely for explicit binding-changed review and never accepts its running proof', () => {
        const configuration = savedConfiguration();
        configuration.binding.feedId = `pi:${binding().piDeviceId}:${'e'.repeat(24)}`;
        const s = { ...status(), configured: true, configuration, reason: 'binding-changed' };
        expect(parseWakePiStatus(JSON.stringify(s), NOW).proof).toBeNull();
        expect(() => parseWakePiStatus(JSON.stringify({ ...s, reason: 'watching' }), NOW)).toThrow();
    });
    it('retains the original source clock and matches selections independent of JSON key order', () => {
        const s = sensors();
        s.options[0].reading.selection = { reference: 'below-keel', sensorId: 'sounder.1', feedId: binding().feedId };
        expect(parseWakePiSensors(JSON.stringify(s), NOW).options[0].reading?.at).toBe(at);
    });
    it.each(['owner', 'feed', 'reference', 'clock', 'duplicate', 'overflow', 'truncated-reading'])(
        'rejects malformed %s evidence',
        (kind) => {
            const s = sensors();
            if (kind === 'owner') s.binding.ownerId = 'invalid';
            if (kind === 'feed') s.options[0].selection.feedId = 'foreign';
            if (kind === 'reference') s.options[0].selection.reference = 'waterline';
            if (kind === 'clock') s.options[0].reading.at--;
            if (kind === 'duplicate') s.options.push(s.options[0]);
            if (kind === 'overflow') s.options = Array.from({ length: 33 }, () => s.options[0]);
            if (kind === 'truncated-reading') s.options[0].reading.value = Infinity;
            expect(() => parseWakePiSensors(JSON.stringify(s), NOW)).toThrow();
        },
    );
    it('bounds text before parsing and refuses replayed envelopes/foreign keeper proof', () => {
        expect(() => parseWakePiSensors(' '.repeat(32769), NOW)).toThrow();
        expect(() => parseWakePiSensors(JSON.stringify(sensors()), NOW + 10001)).toThrow();
        const s = { ...status(), proof: { ownerId: 'foreign' } };
        expect(() => parseWakePiStatus(JSON.stringify(s), NOW)).toThrow();
    });
});
describe('enrolled foreground watch', () => {
    it('requires deliberate replacement of another phone’s revision and clears with this phone’s current enrollment', async () => {
        f.request.mockImplementation(async (o: { url: string }) =>
            response(
                o.url.endsWith('/status')
                    ? {
                          ...status(),
                          configured: true,
                          configuration: savedConfiguration(),
                      }
                    : sensors(),
            ),
        );
        await service.start();
        expect(await service.configurePi()).toBe(false);
        f.request.mockResolvedValueOnce(response({ schema: 1, cleared: true }));
        expect(await service.clearPi()).toBe(true);
        const sent = f.request.mock.calls.at(-1)![0];
        expect(sent.method).toBe('DELETE');
        expect(sent.data.binding.deviceId).toBe(DEVICE);
        expect(sent.data.expectedRevision).toBe(REV);
        expect(sent.data.rulesDigest).toBe(savedConfiguration().rulesDigest);
    });
    it('reads only fixed enrolled LAN endpoints and never arms the Pi on read or local Save', async () => {
        await service.start();
        saveWakeRulePreferences(selectedRules(), getAuthIdentityScope());
        await flush();
        expect(f.request.mock.calls.map(([o]) => o.url)).toEqual([
            'https://boat.local:8080/api/wake-rules/sensors?draftM=none',
            'https://boat.local:8080/api/wake-rules/status',
        ]);
        expect(f.request.mock.calls.every(([o]) => o.method === 'GET' && typeof o.isCurrent === 'function')).toBe(true);
        expect(getWakeRuleSources().options).toHaveLength(1);
        expect(service.getSnapshot().keeper).toBe('phone-only');
        expect(audio.acquire).toHaveBeenCalledWith('wake-depth');
    });
    it('unknown or repeated inputs never clear an active alarm; a fresh safe sample can clear it', async () => {
        saveWakeRulePreferences(selectedRules(), getAuthIdentityScope());
        await service.start();
        await flush();
        expect(service.getSnapshot().rules[0].state.active).toBe(true);
        depth = 5;
        await vi.advanceTimersByTimeAsync(3000);
        await flush();
        expect(service.getSnapshot().rules[0].state.active).toBe(true);
        f.request.mockRejectedValueOnce(Error());
        await vi.advanceTimersByTimeAsync(3000);
        await flush();
        expect(service.getSnapshot().rules[0].status).toBe('unknown');
        expect(service.getSnapshot().rules[0].state.active).toBe(true);
        at = Date.now();
        await vi.advanceTimersByTimeAsync(3000);
        await flush();
        expect(service.getSnapshot().rules[0].state.active).toBe(false);
        expect(audio.releaseEventually).toHaveBeenCalledWith('owned-wake-lease');
    });
    it.each(['account', 'pair', 'pin', 'LAN', 'vessel', 'background'])(
        'retires pending %s responses and its own audio only',
        async (kind) => {
            let resolve!: (v: ReturnType<typeof response>) => void;
            f.request.mockImplementationOnce(
                () =>
                    new Promise((r) => {
                        resolve = r;
                    }),
            );
            let context = true;
            const pending = service.start(null, () => context);
            await vi.waitFor(() => expect(typeof resolve).toBe('function'));
            if (kind === 'account') setAuthIdentityScope('66666666-6666-4666-8666-666666666666');
            if (kind === 'pair') f.paired = false;
            if (kind === 'pin') f.pairing.pairedAt = 'changed';
            if (kind === 'LAN') f.base = null;
            if (kind === 'vessel') context = false;
            if (kind === 'background') f.app?.({ isActive: false });
            resolve(response(sensors()));
            await pending;
            await flush();
            expect(getWakeRuleSources().options).toHaveLength(0);
            expect(audio.acquire).not.toHaveBeenCalled();
            expect(service.getSnapshot().keeper).toBe('phone-only');
            expect(f.request).toHaveBeenCalledTimes(1);
        },
    );
    it('native transport, enrollment and foreground are necessary before any sensor request', async () => {
        f.native = false;
        await service.start();
        expect(f.request).not.toHaveBeenCalled();
        f.native = true;
        f.chart.mockResolvedValue(null);
        await service.start();
        expect(service.getSnapshot().state).toBe('enrollment');
        f.chart.mockResolvedValue({ chartDeviceId: DEVICE });
        f.foreground = false;
        await service.start();
        expect(f.request).not.toHaveBeenCalled();
    });
    it('requires an explicit CAS request and exact readback; an acknowledgement is never running proof', async () => {
        saveWakeRulePreferences(selectedRules(), getAuthIdentityScope());
        await service.start();
        f.request.mockImplementationOnce(async (o: { data: Record<string, unknown> }) =>
            response({ schema: 1, configuration: { ...o.data, revision: REV, configuredAt: NOW } }),
        );
        expect(await service.configurePi()).toBe(true);
        const sent = f.request.mock.calls.at(-1)![0];
        expect(sent.method).toBe('POST');
        expect(sent.data.expectedRevision).toBeNull();
        expect(sent.data.binding).toEqual(binding());
        expect(sent.data.rulesDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(service.getSnapshot().keeper).toBe('phone-only');
    });
    it('CAS conflict is surfaced without retry or blind overwrite', async () => {
        await service.start();
        f.request.mockResolvedValueOnce(response({ code: 'wake-conflict' }, 409));
        expect(await service.configurePi()).toBe(false);
        expect(service.getSnapshot().state).toBe('conflict');
        expect(f.request.mock.calls.filter(([o]) => o.method === 'POST')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(3000);
        expect(f.request.mock.calls.filter(([o]) => o.method === 'POST')).toHaveLength(1);
    });
    it('concurrent configure clicks cannot issue two mutations during digest calculation', async () => {
        await service.start();
        f.request.mockImplementationOnce(async (o: { data: Record<string, unknown> }) =>
            response({ schema: 1, configuration: { ...o.data, revision: REV, configuredAt: NOW } }),
        );
        await Promise.all([service.configurePi(), service.configurePi()]);
        expect(f.request.mock.calls.filter(([o]) => o.method === 'POST')).toHaveLength(1);
    });
    it('validates canonical saved rules rather than trusting a matching claimed digest', async () => {
        await service.start();
        f.request.mockImplementationOnce(async (o: { data: Record<string, unknown> }) =>
            response({
                schema: 1,
                configuration: { ...o.data, rules: selectedRules(), revision: REV, configuredAt: NOW },
            }),
        );
        expect(await service.configurePi()).toBe(false);
        expect(service.getSnapshot().keeper).toBe('phone-only');
        expect(wakeRulesCanonical(defaultWakeRules(), null)).not.toBe(wakeRulesCanonical(selectedRules(), null));
    });
    it('expires Pi keeper status on the preset source clock before the generic thirty-second proof window', async () => {
        const rules = selectedRules();
        saveWakeRulePreferences(rules, getAuthIdentityScope());
        const rulesDigest = createHash('sha256').update(wakeRulesCanonical(rules, null)).digest('hex');
        f.request.mockImplementation(async (o: { url: string }) =>
            response(
                o.url.endsWith('/status')
                    ? {
                          ...status(),
                          configured: true,
                          running: true,
                          reason: 'watching',
                          configuration: {
                              schema: 1,
                              revision: REV,
                              binding: binding(),
                              draftM: null,
                              rulesDigest,
                              rules,
                              configuredAt: NOW,
                          },
                          proof: {
                              update: 7,
                              ownerId: OWNER,
                              feedId: binding().feedId,
                              rulesDigest,
                              running: true,
                              evaluatedAt: NOW,
                              binding: binding(),
                              revision: REV,
                              instance: INSTANCE,
                          },
                          rules: [
                              {
                                  preset: 'depth-below-keel',
                                  status: 'active',
                                  active: true,
                                  audible: true,
                                  quiet: false,
                                  lastAt: NOW,
                                  value: 2,
                              },
                          ],
                      }
                    : sensors(),
            ),
        );
        await service.start();
        expect(service.getSnapshot().keeper).toBe('pi');
        await vi.advanceTimersByTimeAsync(14_000);
        expect(service.getSnapshot().keeper).toBe('phone-only');
        expect(service.getSnapshot().rules[0].state.active).toBe(true);
    });
    it('a late audio acquisition after account retirement releases only the acquired wake lease', async () => {
        let resolve!: (lease: string) => void;
        audio.acquire.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        saveWakeRulePreferences(selectedRules(), getAuthIdentityScope());
        await service.start();
        await flush();
        expect(typeof resolve).toBe('function');
        setAuthIdentityScope(null);
        resolve('late-wake-lease');
        await flush();
        expect(audio.releaseEventually).toHaveBeenCalledWith('late-wake-lease');
        expect(service.getSnapshot().rules).toHaveLength(0);
    });
});
