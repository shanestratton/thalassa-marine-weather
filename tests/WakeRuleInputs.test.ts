import { describe, expect, it } from 'vitest';
import { defaultWakeRules, initialWakeState, WAKE_PRESETS, type WakePreset, type WakeRule } from '../utils/wakeRule';
import { evaluateWakeFromSignalK, wakeReadingFromSignalK, type WakeInputContext } from '../utils/wakeRuleInputs';
import { evaluatePhoneWakeRule } from '../services/alarms/phoneWakeRule';
import { evaluatePiWakeRule } from '../pi-cache/src/wakeRuleAdapter';
import { underKeelM } from '../services/underway/underwayRule';

const now = Date.parse('2026-10-16T12:00:00Z');
function rule(preset: WakePreset, threshold = 3): WakeRule {
    return {
        ...defaultWakeRules().find((item) => item.preset === preset)!,
        enabled: true,
        threshold,
        minimumDurationMs: 0,
        selection: {
            feedId: 'pi-fictional',
            sensorId: 'n2k.17',
            reference: WAKE_PRESETS[preset].reference,
            ...(preset.startsWith('engine-')
                ? { instance: 'main' }
                : preset === 'battery-below'
                  ? { instance: 'house' }
                  : {}),
        },
    };
}
const leaf = (value: number, at = now, units?: string, source = 'n2k.17') => ({
    value,
    timestamp: new Date(at).toISOString(),
    $source: source,
    ...(units ? { meta: { units } } : {}),
});
const context = (selfDocument: unknown): WakeInputContext => ({
    feedId: 'pi-fictional',
    localBoatSource: true,
    selfDocument,
    now,
    draftM: 2,
});

describe('preset source qualification', () => {
    const selected = rule('wind-above', 25);
    const document = { environment: { wind: { speedTrue: leaf(15, now, 'm/s') } } };
    it('uses real SI conversion and preserves the original leaf clock', () => {
        const sample = wakeReadingFromSignalK(selected, context(document));
        expect(sample?.value).toBeCloseTo((15 * 3600) / 1852);
        expect(sample?.at).toBe(now);
        expect(evaluateWakeFromSignalK(selected, initialWakeState(), context(document)).transition).toBe('fire');
    });
    it('never qualifies cloud reports, a changed pairing, another source or parent timestamps', () => {
        expect(wakeReadingFromSignalK(selected, { ...context(document), localBoatSource: false })).toBeNull();
        expect(wakeReadingFromSignalK(selected, { ...context(document), feedId: 'another-pi' })).toBeNull();
        for (const invalid of [
            { value: 20 },
            { value: 20, timestamp: new Date(now).toISOString() },
            leaf(20, now - 13_001),
            leaf(20, now + 1001),
            leaf(20, now, 'kn'),
            leaf(20, now, 'm/s', 'another-sensor'),
            leaf(2000, now, 'm/s'),
            { ...leaf(20), timestamp: '2026' },
        ])
            expect(
                wakeReadingFromSignalK(
                    selected,
                    context({
                        timestamp: new Date(now).toISOString(),
                        environment: { wind: { timestamp: new Date(now).toISOString(), speedTrue: invalid } },
                    }),
                ),
            ).toBeNull();
    });
    it('does not substitute apparent wind, ground wind, STW or a configured arbitrary path', () => {
        expect(
            wakeReadingFromSignalK(
                selected,
                context({ environment: { wind: { speedApparent: leaf(30), speedOverGround: leaf(30) } } }),
            ),
        ).toBeNull();
        expect(
            wakeReadingFromSignalK(rule('speed-below', 2), context({ navigation: { speedThroughWater: leaf(0) } })),
        ).toBeNull();
        const sample = wakeReadingFromSignalK(
            rule('speed-below', 2),
            context({ navigation: { speedOverGround: leaf(0.5, now - 1000, 'm/s') } }),
        );
        expect(sample?.value).toBeCloseTo(0.971922);
        expect(sample?.at).toBe(now - 1000);
    });
    it('does not inherit dangerous prototype paths or silently change selected references', () => {
        const inherited = Object.create({ environment: document.environment });
        expect(wakeReadingFromSignalK(selected, context(inherited))).toBeNull();
        expect(wakeReadingFromSignalK(selected, context(Object.create({ value: document })))).toBeNull();
        expect(
            wakeReadingFromSignalK(
                selected,
                context({ environment: { wind: { speedTrue: Object.create(leaf(30)) } } }),
            ),
        ).toBeNull();
        expect(
            wakeReadingFromSignalK(
                { ...selected, selection: { ...selected.selection!, reference: 'apparent' } },
                context(document),
            ),
        ).toBeNull();
    });
});

describe('the existing conservative depth policy', () => {
    const selected = rule('depth-below-keel', 3);
    it('uses below-keel as-is, including a negative reading, with no second draft subtraction', () => {
        const sample = wakeReadingFromSignalK(
            selected,
            context({ environment: { depth: { belowKeel: leaf(-0.2, now, 'm') } } }),
        );
        expect(sample?.value).toBe(underKeelM(-0.2, 'below-keel', 2));
        expect(sample?.depthBasis).toBe('below-keel');
        expect(
            evaluateWakeFromSignalK(
                selected,
                initialWakeState(),
                context({ environment: { depth: { belowKeel: leaf(-0.2) } } }),
            ).transition,
        ).toBe('fire');
    });
    it('folds a current same-source offset or subtracts the full draft when unknown', () => {
        const known = { environment: { depth: { belowTransducer: leaf(4), transducerToKeel: leaf(1.5) } } };
        expect(wakeReadingFromSignalK(selected, context(known))?.value).toBe(2.5);
        expect(wakeReadingFromSignalK(selected, context(known))?.depthBasis).toBe('transducer-offset');
        const unknown = {
            environment: { depth: { belowTransducer: leaf(4), transducerToKeel: leaf(1.5, now - 20_000) } },
        };
        expect(wakeReadingFromSignalK(selected, context(unknown))?.value).toBe(underKeelM(4, 'below-transducer', 2));
        expect(wakeReadingFromSignalK(selected, { ...context(unknown), draftM: null })).toBeNull();
        expect(wakeReadingFromSignalK(selected, context(unknown))?.depthBasis).toBe('conservative-full-draft');
        expect(wakeReadingFromSignalK(selected, { ...context(unknown), draftM: NaN })).toBeNull();
    });
    it('rejects stale keel carried with newer DBT and does not treat keel-configured DBS as waterline', () => {
        const document = { environment: { depth: { belowKeel: leaf(4, now - 11_000), belowTransducer: leaf(4) } } };
        expect(wakeReadingFromSignalK(selected, context(document))?.value).toBe(2);
        expect(
            wakeReadingFromSignalK(
                selected,
                context({ environment: { depth: { belowKeel: leaf(4, now - 30_000), belowSurface: leaf(5) } } }),
            ),
        ).toBeNull();
        expect(
            wakeReadingFromSignalK(selected, context({ environment: { depth: { belowSurface: leaf(5) } } }))?.value,
        ).toBe(underKeelM(5, 'below-waterline', 2));
    });
    it('dates an offset-derived reading by its oldest measured dependency', () => {
        for (const [rawAt, offsetAt] of [
            [now, now - 5000],
            [now - 5000, now],
        ]) {
            const document = {
                environment: {
                    depth: { belowTransducer: leaf(4, rawAt, 'm'), transducerToKeel: leaf(1.5, offsetAt, 'm') },
                },
            };
            expect(wakeReadingFromSignalK(selected, context(document))?.at).toBe(now - 5000);
        }
    });
});

describe('measured station-pressure history', () => {
    const selected = rule('pressure-fall', 3);
    const history = Array.from({ length: 19 }, (_, index) => ({
        t: now - (18 - index) * 600_000,
        hpa: 1015 - index * 0.25,
        feedId: 'pi-fictional',
        sensorId: 'n2k.17',
    }));
    const doc = { environment: { outside: { pressure: leaf(101050, now, 'Pa') } } };
    const input = {
        ...context(doc),
        pressureHistory: { feedId: 'pi-fictional', sensorId: 'n2k.17', samples: history },
    };
    it('reuses the observed 3-hour tendency with real hPa/Pa conversion', () => {
        const sample = wakeReadingFromSignalK(selected, input);
        expect(sample?.value).toBeCloseTo(4.5);
        expect(sample?.at).toBe(now);
        expect(evaluateWakeFromSignalK(selected, initialWakeState(), input).transition).toBe('fire');
    });
    it('rejects missing/short/gapped/mixed-source histories, old pressure and forecast-only data', () => {
        for (const pressureHistory of [
            undefined,
            { ...input.pressureHistory, sensorId: 'other' },
            { ...input.pressureHistory, samples: history.slice(-5) },
            { ...input.pressureHistory, samples: history.filter((_, index) => index < 5 || index > 12) },
            { ...input.pressureHistory, samples: history.slice(0, -1) },
            {
                ...input.pressureHistory,
                samples: history.map((sample, index) =>
                    index === 5 ? { ...sample, sensorId: 'other-source' } : sample,
                ),
            },
            { ...input.pressureHistory, samples: [...history].reverse() },
            { ...input.pressureHistory, samples: [history[0], ...history] },
            { ...input.pressureHistory, samples: Array.from({ length: 2049 }, () => history[0]) },
        ])
            expect(wakeReadingFromSignalK(selected, { ...input, pressureHistory })).toBeNull();
        expect(wakeReadingFromSignalK(selected, { ...input, now: now + 120_001 })).toBeNull();
        expect(
            wakeReadingFromSignalK(selected, {
                ...input,
                pressureHistory: {
                    ...input.pressureHistory,
                    samples: null,
                } as unknown as WakeInputContext['pressureHistory'],
            }),
        ).toBeNull();
        expect(
            wakeReadingFromSignalK(selected, { ...input, selfDocument: { forecast: { pressure: leaf(101050) } } }),
        ).toBeNull();
    });
});

describe('explicit engine and bank selection', () => {
    it('requires exactly one selected engine, converts Hz/K/Pa and carries each original clock', () => {
        const document = {
            propulsion: {
                main: {
                    revolutions: leaf(20, now - 1000, 'Hz'),
                    coolantTemperature: leaf(373.15, now - 2000, 'K'),
                    oilPressure: leaf(120000, now - 3000, 'Pa'),
                },
            },
        };
        expect(wakeReadingFromSignalK(rule('engine-rpm-above', 1500), context(document))?.value).toBe(1200);
        expect(wakeReadingFromSignalK(rule('engine-coolant-above', 90), context(document))).toMatchObject({
            value: 100,
            at: now - 2000,
        });
        expect(wakeReadingFromSignalK(rule('engine-oil-below', 150), context(document))).toMatchObject({
            value: 120,
            at: now - 3000,
        });
        expect(
            wakeReadingFromSignalK(
                rule('engine-coolant-above', 90),
                context({ propulsion: { ...document.propulsion, other: {} } }),
            ),
        ).toBeNull();
        expect(
            wakeReadingFromSignalK(
                rule('engine-coolant-above', 90),
                context({ propulsion: { other: document.propulsion.main } }),
            ),
        ).toBeNull();
    });
    it('does not declare low oil with a stopped, silent or temporally incoherent RPM sender', () => {
        for (const revolutions of [
            undefined,
            leaf(0, now, 'Hz'),
            leaf(20, now - 13_001, 'Hz'),
            leaf(20, now - 7000, 'Hz'),
            leaf(20, now, 'Hz', 'another-rpm-sender'),
        ])
            expect(
                wakeReadingFromSignalK(
                    rule('engine-oil-below', 150),
                    context({ propulsion: { main: { revolutions, oilPressure: leaf(0, now, 'Pa') } } }),
                ),
            ).toBeNull();
    });
    it('selects the named battery bank and source without guessing nominal voltage', () => {
        const document = {
            electrical: {
                batteries: {
                    house: { voltage: leaf(11.8, now - 1000, 'V') },
                    starter: { voltage: leaf(10, now, 'V') },
                },
            },
        };
        expect(wakeReadingFromSignalK(rule('battery-below', 12), context(document))).toMatchObject({
            value: 11.8,
            at: now - 1000,
        });
        expect(wakeReadingFromSignalK({ ...rule('battery-below', 12), threshold: null }, context(document))).toBeNull();
        expect(
            wakeReadingFromSignalK(
                rule('battery-below', 12),
                context({ electrical: { batteries: { starter: document.electrical.batteries.starter } } }),
            ),
        ).toBeNull();
    });
});

describe('actual phone/Pi adapter parity', () => {
    it('keeps the same sustained trigger, unknown hold, hysteresis and clear transitions', () => {
        const selected = { ...rule('wind-above', 25), minimumDurationMs: 20_000, clearDurationMs: 10_000 };
        let phone = initialWakeState(),
            pi = initialWakeState();
        const transitions: string[] = [];
        for (const [offset, speed] of [
            [0, 30],
            [10_000, 30],
            [20_000, 30],
            [25_000, null],
            [30_000, 20],
            [40_000, 20],
        ] as const) {
            const input = {
                ...context({
                    environment: {
                        wind: { speedTrue: speed === null ? null : leaf((speed * 1852) / 3600, now + offset, 'm/s') },
                    },
                }),
                now: now + offset,
            };
            const phoneResult = evaluatePhoneWakeRule(selected, phone, input),
                piResult = evaluatePiWakeRule(selected, pi, input);
            expect(piResult).toEqual(phoneResult);
            phone = phoneResult.state;
            pi = piResult.state;
            transitions.push(phoneResult.transition);
        }
        expect(transitions).toEqual(['none', 'none', 'fire', 'none', 'none', 'clear']);
    });
});
