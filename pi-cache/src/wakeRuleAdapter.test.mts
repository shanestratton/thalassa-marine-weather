import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePiWakeRule } from './wakeRuleAdapter.js';
import { defaultWakeRules, initialWakeState, wakeKeeper } from './wakeRule/wakeRule.js';

test('Pi adapter uses the mirrored pure model and original clocks, without any runner/relay claim', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const rule = {
        ...defaultWakeRules().find((rule) => rule.preset === 'wind-above')!,
        enabled: true,
        minimumDurationMs: 20_000,
        selection: { feedId: 'paired-fictional', sensorId: 'can.17', reference: 'true-water' },
    };
    let state = initialWakeState();
    for (const offset of [0, 10_000, 20_000]) {
        const result = evaluatePiWakeRule(rule, state, {
            feedId: 'paired-fictional',
            localBoatSource: true,
            now: now + offset,
            draftM: null,
            selfDocument: {
                environment: {
                    wind: {
                        speedTrue: {
                            value: 20,
                            $source: 'can.17',
                            timestamp: new Date(now + offset).toISOString(),
                            meta: { units: 'm/s' },
                        },
                    },
                },
            },
        });
        assert.equal(result.transition, offset === 20_000 ? 'fire' : 'none');
        state = result.state;
    }
    const unknown = evaluatePiWakeRule(rule, state, {
        feedId: 'paired-fictional',
        localBoatSource: true,
        now: now + 30_000,
        draftM: null,
        selfDocument: {},
    });
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.state.active, true);
    assert.equal(unknown.transition, 'none');
    assert.equal(
        wakeKeeper(null, { ownerId: 'account', feedId: 'paired-fictional', rulesDigest: 'a'.repeat(64) }, now),
        'phone-only',
    );
});
