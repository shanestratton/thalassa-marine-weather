import { describe, it, expect } from 'vitest';
import { parseWakeRelayRequest, wakeRelayAlarmKey } from '../supabase/functions/pi-alarm-relay/wake-contract';
import { wakeCloudContext, wakeCloudEpisodeKey, WAKE_RELAY_KINDS } from '../pi-cache/src/wakeKeeper/relayProtocol';
import { defaultWakeRules, wakeRulesCanonical, WAKE_PRESETS } from '../utils/wakeRule';
import { WakeEpisodes } from '../pi-cache/src/wakeKeeper/episodes';
import { wakeHash, wakePairingId, type WakeConfiguration } from '../pi-cache/src/wakeKeeper/contract';
describe('Pi producer and actual Edge parser parity', () => {
    it('accepts all exact presets and identical episode hash bytes without raw sensor identity', async () => {
        const owner = '00000000-0000-4000-8000-000000000001',
            pi = '00000000-0000-4000-8000-000000000002',
            relay = 'fictional-relay-identity',
            at = Date.parse('2026-10-17T00:00:00Z'),
            feedId = `pi:${pi}:${'b'.repeat(24)}`;
        const rules = defaultWakeRules().map((r) => ({ ...r, enabled: false, selection: null }));
        const config: WakeConfiguration = {
            schema: 1,
            revision: '00000000-0000-4000-8000-000000000004',
            configuredAt: at - 1000,
            draftM: 2,
            binding: {
                ownerId: owner,
                piDeviceId: pi,
                pairingId: wakePairingId(owner, pi, relay),
                deviceId: '00000000-0000-4000-8000-000000000003',
                enrollmentRevision: 'a'.repeat(64),
                feedId,
            },
            rules,
            rulesDigest: wakeHash(wakeRulesCanonical(rules, 2)),
        };
        const context = wakeCloudContext(config, '00000000-0000-4000-8000-000000000005');
        expect(
            await parseWakeRelayRequest(
                { family: 'wake', action: 'bind', context, expectedContextRevision: null },
                { ownerId: owner, relayId: relay },
                at,
            ),
        ).not.toBeNull();
        for (const kind of Object.keys(WAKE_RELAY_KINDS) as (keyof typeof WAKE_RELAY_KINDS)[]) {
            expect(wakeCloudEpisodeKey(context, kind, 'd'.repeat(64), at)).toBe(
                await wakeRelayAlarmKey(context, kind, 'd'.repeat(64), at),
            );
        }
        const thresholds = [3, 25, 2, 3, 100, 100, 4000, 12],
            values = [1, 30, 1, 4, 110, 50, 5000, 10];
        config.rules = defaultWakeRules().map((r, i) => ({
            ...r,
            enabled: true,
            threshold: thresholds[i],
            selection: { feedId, sensorId: 'fictional.physical.sender', reference: WAKE_PRESETS[r.preset].reference },
        }));
        config.rulesDigest = wakeHash(wakeRulesCanonical(config.rules, 2));
        const pass = new WakeEpisodes().pass(
            config,
            context.instance,
            config.rules.map((r, i) => ({
                preset: r.preset,
                status: 'active',
                active: true,
                audible: true,
                quiet: false,
                lastAt: at,
                value: values[i],
                ...(i === 0 ? { depthBasis: 'below-keel' as const } : {}),
            })),
            at,
        );
        const parsed = await parseWakeRelayRequest(
            {
                family: 'wake',
                action: 'sync',
                context: pass.context,
                contextRevision: '00000000-0000-4000-8000-000000000006',
                evaluatedAt: at,
                higherPriority: 'none',
                states: pass.states,
            },
            { ownerId: owner, relayId: relay },
            at,
        );
        expect(parsed?.action).toBe('sync');
        if (parsed?.action === 'sync') expect(parsed.states).toEqual(pass.states);
        expect(JSON.stringify(pass)).not.toContain('fictional.physical.sender');
    });
});
