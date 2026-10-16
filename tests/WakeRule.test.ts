import { describe, expect, it } from 'vitest';
import {
    defaultWakeRules,
    evaluateWakeRule,
    initialWakeState,
    validWakeRule,
    WAKE_PRESETS,
    WAKE_ALARM_PRIORITY,
    wakeKeeper,
    wakePresetPriority,
    type WakePreset,
    type WakeReading,
    type WakeRule,
} from '../utils/wakeRule';

const start = Date.parse('2026-10-16T12:00:00Z');
export function enabled(preset: WakePreset = 'wind-above', overrides: Partial<WakeRule> = {}): WakeRule {
    const rule = defaultWakeRules().find((rule) => rule.preset === preset)!;
    return {
        ...rule,
        enabled: true,
        threshold: rule.threshold ?? (preset === 'battery-below' ? 12 : 100),
        selection: {
            feedId: 'paired-pi:fictional',
            sensorId: 'n2k.17',
            reference: WAKE_PRESETS[preset].reference,
            ...(preset.startsWith('engine-')
                ? { instance: 'main' }
                : preset === 'battery-below'
                  ? { instance: 'house' }
                  : {}),
        },
        ...overrides,
    };
}
const reading = (rule: WakeRule, value: number, at: number): WakeReading => ({
    preset: rule.preset,
    selection: rule.selection!,
    value,
    at,
});
function run(rule: WakeRule, values: [number, number][], previous = initialWakeState()) {
    let result = evaluateWakeRule(rule, previous, null, start);
    for (const [offset, value] of values)
        result = evaluateWakeRule(rule, result.state, reading(rule, value, start + offset), start + offset);
    return result;
}

describe('fixed wake presets', () => {
    it('starts every preset off with no selected physical sensor and no invented engine/bank redline', () => {
        const rules = defaultWakeRules();
        expect(rules).toHaveLength(8);
        expect(rules.every((rule) => !rule.enabled && !rule.selection)).toBe(true);
        expect(
            rules
                .filter((rule) => rule.preset.startsWith('engine-') || rule.preset === 'battery-below')
                .every((rule) => rule.threshold === null),
        ).toBe(true);
        rules[0].enabled = true;
        expect(defaultWakeRules()[0].enabled).toBe(false);
        expect(Object.isFrozen(WAKE_PRESETS['wind-above'])).toBe(true);
    });
    it('requires an explicit supported reference/instance and bounded configuration', () => {
        expect(validWakeRule(enabled())).toBe(true);
        expect(
            validWakeRule(enabled('wind-above', { selection: { feedId: 'p', sensorId: 's', reference: 'apparent' } })),
        ).toBe(false);
        expect(
            validWakeRule(enabled('engine-rpm-above', { selection: { feedId: 'p', sensorId: 's', reference: 'rpm' } })),
        ).toBe(false);
        for (const overrides of [
            { threshold: NaN },
            { threshold: 300 },
            { minimumDurationMs: -1 },
            { clearDurationMs: 3_600_001 },
            { hysteresis: -1 },
            { quietHours: { startMinute: 0, endMinute: 0, utcOffsetMinutes: 0 } },
        ])
            expect(validWakeRule(enabled('wind-above', overrides))).toBe(false);
        expect(validWakeRule({ ...enabled(), preset: 'navigation.someCommand' } as unknown as WakeRule)).toBe(false);
    });
    it('keeps existing lease ordering without acquiring or releasing another owner', () => {
        expect(WAKE_ALARM_PRIORITY.anchor).toBeLessThan(WAKE_ALARM_PRIORITY.collision);
        expect(WAKE_ALARM_PRIORITY.distress).toBeLessThan(wakePresetPriority('depth-below-keel'));
        expect(wakePresetPriority('depth-below-keel')).toBeLessThan(wakePresetPriority('wind-above'));
    });
});

describe('measurement-clock state machine', () => {
    it.each([
        ['depth-below-keel', 3, 2, 3.5],
        ['wind-above', 25, 26, 23],
        ['speed-below', 2, 1, 2.5],
        ['pressure-fall', 3, 4, 2.5],
        ['engine-coolant-above', 100, 110, 95],
        ['engine-oil-below', 100, 90, 110],
        ['engine-rpm-above', 100, 101, 0],
        ['battery-below', 12, 11, 12.5],
    ] as const)('uses the fixed comparison/hysteresis for %s', (preset, threshold, breach, clear) => {
        const rule = enabled(preset, { threshold, minimumDurationMs: 0, clearDurationMs: 0 });
        expect(run(rule, [[0, threshold]]).state.active).toBe(false);
        const fired = run(rule, [[0, breach]]);
        expect(fired.transition).toBe('fire');
        const cleared = evaluateWakeRule(rule, fired.state, reading(rule, clear, start + 1), start + 1);
        expect(cleared.transition).toBe('clear');
    });
    it('requires consecutive fresh leaves for the minimum duration and fires once', () => {
        const rule = enabled('wind-above', { minimumDurationMs: 20_000 });
        const result = run(rule, [
            [0, 26],
            [10_000, 26],
            [20_000, 26],
        ]);
        expect(result.transition).toBe('fire');
        expect(result.audible).toBe(true);
        expect(evaluateWakeRule(rule, result.state, reading(rule, 27, start + 25_000), start + 25_000).transition).toBe(
            'none',
        );
    });
    it('does not count repeated polling of the same leaf as confirmation or clearing', () => {
        const rule = enabled('wind-above', { minimumDurationMs: 10_000, clearDurationMs: 10_000 });
        const pending = run(rule, [[0, 30]]);
        expect(evaluateWakeRule(rule, pending.state, reading(rule, 30, start), start + 11_000).state.active).toBe(
            false,
        );
        const active = run(rule, [
            [0, 30],
            [10_000, 30],
        ]);
        const clearing = evaluateWakeRule(rule, active.state, reading(rule, 20, start + 11_000), start + 11_000);
        expect(
            evaluateWakeRule(rule, clearing.state, reading(rule, 20, start + 11_000), start + 23_000).state.active,
        ).toBe(true);
    });
    it('stale, missing, nonfinite, future, wrong-source and out-of-order observations neither fire nor clear', () => {
        const rule = enabled('wind-above', { minimumDurationMs: 0, clearDurationMs: 0 });
        const active = run(rule, [[0, 30]]);
        const wrong = {
            ...reading(rule, 0, start + 1000),
            selection: { ...rule.selection!, sensorId: 'another-sender' },
        };
        const cases: [WakeReading | null, number][] = [
            [null, start + 1000],
            [reading(rule, 0, start), start + 14_000],
            [reading(rule, NaN, start + 1000), start + 1000],
            [reading(rule, 0, start + 2001), start + 1000],
            [wrong, start + 1000],
            [reading(rule, 0, start - 1), start + 1000],
        ];
        for (const [sample, now] of cases) {
            const result = evaluateWakeRule(rule, active.state, sample, now);
            expect(result.status).toBe('unknown');
            expect(result.transition).toBe('none');
            expect(result.state.active).toBe(true);
            expect(result.audible).toBe(true);
            expect(
                evaluateWakeRule({ ...rule, minimumDurationMs: 10_000 }, initialWakeState(), sample, now).state.active,
            ).toBe(false);
        }
    });
    it('breaks a pending interval on an explicit unknown or long sample gap', () => {
        const rule = enabled('wind-above', { minimumDurationMs: 20_000 });
        let state = run(rule, [
            [0, 30],
            [10_000, 30],
        ]).state;
        state = evaluateWakeRule(rule, state, null, start + 11_000).state;
        expect(evaluateWakeRule(rule, state, reading(rule, 30, start + 20_000), start + 20_000).state.since).toBe(
            start + 20_000,
        );
        expect(
            run(rule, [
                [0, 30],
                [20_000, 30],
            ]).state.active,
        ).toBe(false);
    });
    it('clears only beyond hysteresis for a fresh sustained clear interval', () => {
        const rule = enabled('wind-above', { minimumDurationMs: 0, clearDurationMs: 20_000 });
        const active = run(rule, [[0, 30]]);
        const borderline = run(
            rule,
            [
                [1000, 24],
                [11_000, 24],
                [21_000, 24],
            ],
            active.state,
        );
        expect(borderline.state.active).toBe(true);
        const cleared = run(
            rule,
            [
                [22_000, 23],
                [32_000, 22],
                [42_000, 23],
            ],
            borderline.state,
        );
        expect(cleared.transition).toBe('clear');
        expect(cleared.state.active).toBe(false);
    });
    it('holds rather than clears on backwards wall clock; the next interval must start afresh', () => {
        const rule = enabled('wind-above', { minimumDurationMs: 0, clearDurationMs: 0 });
        const active = run(rule, [
            [0, 30],
            [1000, 30],
        ]);
        const result = evaluateWakeRule(rule, active.state, reading(rule, 0, start), start);
        expect(result.status).toBe('unknown');
        expect(result.state.active).toBe(true);
    });
    it('treats user disable/reconfiguration separately from a sensor all-clear', () => {
        const rule = enabled('wind-above', { minimumDurationMs: 0 });
        const active = run(rule, [[0, 30]]);
        expect(evaluateWakeRule({ ...rule, enabled: false }, active.state, null, start).transition).toBe('disabled');
        const next = { ...rule, selection: { ...rule.selection!, feedId: 'new-pairing' } };
        const result = evaluateWakeRule(next, active.state, reading(rule, 0, start + 1000), start + 1000);
        expect(result.transition).toBe('reconfigured');
        expect(result.status).toBe('unknown');
        expect(result.state.active).toBe(false);
        expect(evaluateWakeRule({ ...rule, threshold: NaN }, active.state, null, start).state.active).toBe(true);
    });
    it('quiet hours cross midnight in the explicit offset, retaining active state and ending suppression', () => {
        const rule = enabled('wind-above', {
            minimumDurationMs: 0,
            quietHours: { startMinute: 22 * 60, endMinute: 6 * 60, utcOffsetMinutes: 600 },
        });
        // 12 UTC is 22:00 at the explicitly selected UTC+10 offset.
        const active = run(rule, [[0, 30]]);
        expect(active.quiet).toBe(true);
        expect(active.state.active).toBe(true);
        expect(active.audible).toBe(false);
        const morning = evaluateWakeRule(rule, active.state, null, Date.parse('2026-10-16T20:00:00Z'));
        expect(morning.quiet).toBe(false);
        expect(morning.audible).toBe(true);
        expect(morning.transition).toBe('none');
    });
});

describe('Pi keeper honesty', () => {
    const expected = { ownerId: 'this-account', feedId: 'paired-pi', rulesDigest: 'a'.repeat(64) };
    const proof = { update: 7, ...expected, running: true, evaluatedAt: start };
    it('requires a fresh running update 7 report for this owner and exact rule set', () => {
        expect(wakeKeeper(proof, expected, start + 1000)).toBe('pi');
        for (const candidate of [
            null,
            { ...proof, update: 6 },
            { ...proof, ownerId: 'other-account' },
            { ...proof, feedId: 'another-pi' },
            { ...proof, rulesDigest: 'b'.repeat(64) },
            { ...proof, running: false },
            { ...proof, evaluatedAt: start - 30_001 },
            { ...proof, evaluatedAt: start + 1 },
        ])
            expect(wakeKeeper(candidate, expected, start)).toBe('phone-only');
    });
});
