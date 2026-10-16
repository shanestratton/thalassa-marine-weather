import { describe, expect, it } from 'vitest';
import { CONVECTIVE_MODELS, convectiveConsensus, convectiveContext, type ConvectiveMember } from '../utils/convective';
import {
    defaultWeatherWatch,
    parseWeatherWatchPreferences,
    rainArrival,
    weatherWatchLocalSlot,
    weatherWatchReady,
} from '../utils/weatherWatch';
import { composeBriefing } from '../services/briefing/composeBriefing';
const H = 3_600_000;
const now = Date.parse('2026-10-17T00:00:00Z');
const members = (): ConvectiveMember[] =>
    CONVECTIVE_MODELS.map((model) => ({
        model,
        runAt: now - 6 * H,
        hours: Array.from({ length: 25 }, (_, i) => ({
            at: now + i * H,
            code: 95,
            cape: 3000,
            liftedIndex: null,
            inhibition: null,
            gustKts: 30,
        })),
    }));
describe('cached convective consensus', () => {
    it('requires two distinct pinned models in one three-hour window', () => {
        const m = members();
        m[1].hours = m[1].hours.map((h) => ({ ...h, code: h.at >= now + 3 * H ? 95 : 0 }));
        m[2].hours = [];
        expect(convectiveConsensus(m, now, null).find((e) => e.kind === 'storm')?.from).toBe(now + 3 * H);
        expect(convectiveConsensus([m[0], m[0]], now, 25)).toEqual([]);
    });
    it('rejects stale/future original runs and does not count null weather codes', () => {
        const m = members();
        m[1].runAt = now + 1;
        m[2].runAt = now - 25 * H;
        expect(convectiveConsensus(m, now, 25)).toEqual([]);
        m[1].runAt = now - H;
        m[1].hours = m[1].hours.map((h) => ({ ...h, code: null, gustKts: null }));
        expect(convectiveConsensus(m, now, 25)).toEqual([]);
    });
    it('never turns CAPE alone or missing LI/CIN into a thunder prediction', () => {
        const m = members().map((m) => ({ ...m, hours: m.hours.map((h) => ({ ...h, code: 0, cape: 9000 })) }));
        expect(convectiveConsensus(m, now, null)).toEqual([]);
        expect(convectiveContext(m, now, 0, now).text).toMatch(
            /thunder in 0 of 3 models.*LI unavailable; cap strength unknown/,
        );
        expect(convectiveContext(m, now, 0, now).text).not.toMatch(/no storms|severe storm/i);
    });
    it('uses conservative tropical display bands, never UKMO numeric derivatives', () => {
        const m = members();
        m[2].hours = m[2].hours.map((h) => ({ ...h, cape: 50_000, gustKts: 300 }));
        expect(convectiveContext(m, now, 0, now).text).toMatch(/elevated/);
        expect(convectiveContext(m, now, 50, now).text).toMatch(/Strong energy/);
        expect(convectiveContext(m, now, 0, now).gustRangeKts).toEqual([30, 30]);
        expect(convectiveContext([m[2]], now, 0, now).cape).toBeNull();
        expect(convectiveContext([], now, 0, now).text).toContain('thunder agreement unknown');
    });
    it('preserves missing/physical bounds and UTC hour ordering', () => {
        const m = members();
        m[1].hours = [{ ...m[1].hours[0], gustKts: -1 }];
        m[2].hours = [{ ...m[2].hours[0], at: now + 1 }];
        expect(convectiveConsensus(m, now, 25)).toEqual([]);
    });
});
describe('weather watch readiness and explicit registration', () => {
    const cap = {
        functionVersion: 1,
        deliveryVersion: 1,
        scheduled: true,
        entitlementUntil: now + H,
        succeededAt: now,
    };
    it('defaults every feature off and requires every deployed/scheduled/entitlement half', () => {
        expect(defaultWeatherWatch()).toMatchObject({ morning: false, rain: false, storm: false, gust: false });
        expect(weatherWatchReady('rain', cap, now)).toBe(true);
        expect(weatherWatchReady('rain', { ...cap, succeededAt: now + 500 }, now)).toBe(true);
        for (const broken of [
            { deliveryVersion: 0 },
            { scheduled: false },
            { functionVersion: 0 },
            { entitlementUntil: null },
            { succeededAt: null },
            { succeededAt: now + 1001 },
        ])
            expect(weatherWatchReady('rain', { ...cap, ...broken }, now)).toBe(false);
        expect(weatherWatchReady('rain', { ...cap, succeededAt: now - 16 * 60_000 }, now)).toBe(false);
    });
    it('rejects unknown fields, duplicate samples, invalid zone and invented zero thresholds', () => {
        const p = {
            ...defaultWeatherWatch(),
            samples: [
                { key: 'spot:a', kind: 'spot', label: 'Sample', lat: 0, lon: 0, sourceAt: now, expiresAt: now + H },
            ],
        };
        expect(parseWeatherWatchPreferences(p, now)).toEqual(p);
        expect(parseWeatherWatchPreferences({ ...p, chartDepth: 4 }, now)).toBeNull();
        expect(parseWeatherWatchPreferences({ ...p, samples: [...p.samples, ...p.samples] }, now)).toBeNull();
        expect(parseWeatherWatchPreferences({ ...p, zone: 'Boat/Guess' }, now)).toBeNull();
        expect(parseWeatherWatchPreferences({ ...p, gust: true, gustKts: 0 }, now)).toBeNull();
        expect(
            parseWeatherWatchPreferences(
                { ...p, samples: [{ ...p.samples[0], kind: 'boat', expiresAt: now + H }] },
                now,
            ),
        ).toBeNull();
    });
    it('cuts chosen boat hour at the boat zone, including fractional offsets and DST repeated hour', () => {
        expect(weatherWatchLocalSlot(now, 'Asia/Kathmandu')).toEqual({ day: '2026-10-17', hour: 5, minute: 45 });
        expect(weatherWatchLocalSlot(Date.parse('2026-11-01T05:30:00Z'), 'America/New_York')).toEqual(
            weatherWatchLocalSlot(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York'),
        );
    });
});
describe('rain arriving is a fresh dry-to-wet transition', () => {
    const payload = (rates: unknown[]) => ({
        forecast: rates.map((precipRate, i) => ({
            precipRate,
            precipType: 'rain',
            timestampBegin: now / 1000 + i * 300,
            timestampEnd: now / 1000 + (i + 1) * 300,
        })),
    });
    it('requires two consecutive wet intervals; retains provider interval timestamps', () => {
        expect(rainArrival(payload([0, 0.4, 0.5]), now, now)).toEqual({
            from: now + 300_000,
            sourceAt: now,
            expiresAt: now + 900_000,
        });
        expect(rainArrival(payload([0.4, 0.5]), now, now)).toBeNull();
        expect(rainArrival(payload([0, 0.4, 0, 0.4]), now, now)).toBeNull();
    });
    it('refuses null, blank, stale, discontinuous and already-past arrival evidence', () => {
        for (const rates of [
            [0, null, 0.5],
            [0, '', 0.5],
            [0, -1, 0.5],
        ])
            expect(rainArrival(payload(rates), now, now)).toBeNull();
        expect(rainArrival(payload([0, 0.4, 0.5]), now - 11 * 60_000, now)).toBeNull();
        const gap = payload([0, 0.4, 0.5]);
        gap.forecast[1].timestampBegin += 1;
        expect(rainArrival(gap, now, now)).toBeNull();
    });
});
describe('one deterministic briefing object', () => {
    const input = {
        place: 'Example',
        zone: 'Pacific/Auckland',
        now,
        forecastAt: now - H,
        official: { state: 'unavailable' as const },
        models: ['ECMWF'],
    };
    it('puts a live official warning first and reuses exact Plan Your Day words', () => {
        const b = composeBriefing({
            ...input,
            official: { state: 'live', headline: 'Gale warning', expiresAt: now + H },
            dayPlan: { date: '2026-10-17', headline: { text: 'Morning gets near your limits.' } },
        });
        expect(b.lines).toEqual(['Official warning: Gale warning', 'Morning gets near your limits.']);
        expect(b.detail.join(' ')).toMatch(/Tide unknown; no clearance judgement/);
    });
    it('refuses stale verdicts and an expired warning; names unknown datum/informational tides', () => {
        const b = composeBriefing({
            ...input,
            forecastAt: now - 25 * H,
            official: { state: 'live', headline: 'Old warning', expiresAt: now - 1 },
            dayPlan: { date: '2026-10-17', headline: { text: 'Inside your limits.' } },
            tide: { text: 'Saved table', source: 'NOAA', datum: null, navigationUse: false },
        });
        expect(b.lines.join(' ')).toMatch(/not checked.*unknown/);
        expect(b.lines.join(' ')).not.toContain('Inside');
        expect(b.detail[0]).toContain('datum unknown · informational only');
    });
});
