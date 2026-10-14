/**
 * Forecast alerts that look ahead (129-07): check-weather-alerts' decisions,
 * pure (supabase/functions/_shared/forecast-alerts/lookahead.ts).
 *
 * Shane, 13 Oct 2026: "go with your recommendations for all answers": look
 * 24 h ahead and push only when two of three models (ECMWF, ICON, UKMO)
 * agree inside the same 3 h. One model alone is "models disagree", nulls are
 * a model that did not answer, and one answering model is never enough.
 * UKMO (CC BY-SA) is named and counted, never quoted. Seas come from one
 * named wave model (ECMWF WAM, else MFWAM) and say "no wave model here"
 * where neither has water (or Open-Meteo reached far past dry cells for
 * one). An official warning this skipper was sent that already covers an
 * alert drops it; overnight on the boat's clock an alert waits unless it
 * starts within 3 h; every alert reads "Forecast:" and never looks official.
 * One push per strength per day of the event, the day turning at 07:00 on
 * the boat, so a worse forecast pushes again and a night-long blow does not
 * wake anyone at midnight. The current-hour checks read the hour under way
 * from hourly series per model (a two-model `current` block is the first
 * model's only). Copy is in the skipper's units and the boat's own time:
 * English Harbour, Antigua in mph and feet, Κέρκυρα (Corfu) in metres,
 * 那覇 (Naha) a day ahead of UTC.
 *
 * All data here is made up; the reply shapes follow Open-Meteo's, as probed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import tzLookup from 'tz-lookup';
import {
    type AheadAccount,
    type AheadInputs,
    agreeAhead,
    alertDay,
    batchPoints,
    callWeight,
    decideForAccount,
    deliveredOfficial,
    estimateCallVolume,
    goodWindowAhead,
    holdOvernight,
    type LatLon,
    overCapacityLine,
    parseReplies,
    placesThisRun,
    readHourly,
    readNow,
    requestParams,
    seaAhead,
    waveChain,
    kindModels,
    kindVariables,
    WIND_MODELS,
} from '../supabase/functions/_shared/forecast-alerts/lookahead';
import { forecastAlertCoveredByOfficial } from '../utils/officialWarningCover';
import { forecastAlertRule } from '../utils/forecastAlerts';

const H = 3_600_000;
/** Wednesday 14 October 2026, 00:00 UTC. */
const T0 = Date.UTC(2026, 9, 14, 0);
const HOURS = 72;
const NOON = T0 + 12 * H;

type F = (h: number) => number | null;
const col = (f: F) => Array.from({ length: HOURS }, (_, h) => f(h));
const from =
    (start: number, high: number, low: number): F =>
    (h) =>
        h >= start ? high : low;
const flat =
    (v: number | null): F =>
    () =>
        v;

/** An Open-Meteo forecast reply for one place, hourly from T0, unix seconds. */
function windReply(m: { ecmwf?: F; icon?: F; ukmo?: F }, gusts: { ecmwf?: F; icon?: F; ukmo?: F } = {}) {
    const hourly: Record<string, unknown> = { time: col((h) => (T0 + h * H) / 1000) };
    const ids = { ecmwf: 'ecmwf_ifs025', icon: 'icon_seamless', ukmo: 'ukmo_global_deterministic_10km' } as const;
    for (const k of ['ecmwf', 'icon', 'ukmo'] as const) {
        hourly[`wind_speed_10m_${ids[k]}`] = col(m[k] ?? flat(null));
        hourly[`wind_gusts_10m_${ids[k]}`] = col(gusts[k] ?? flat(null));
    }
    return { latitude: 0, longitude: 0, hourly };
}

function seaReply(m: { wam?: [F, F]; mfwam?: [F, F] }) {
    const hourly: Record<string, unknown> = { time: col((h) => (T0 + h * H) / 1000) };
    hourly.wave_height_ecmwf_wam025 = col(m.wam?.[0] ?? flat(null));
    hourly.wave_period_ecmwf_wam025 = col(m.wam?.[1] ?? flat(null));
    hourly.wave_height_meteofrance_wave = col(m.mfwam?.[0] ?? flat(null));
    hourly.wave_period_meteofrance_wave = col(m.mfwam?.[1] ?? flat(null));
    return { latitude: 0, longitude: 0, hourly };
}

type NowVar = 'weather_code' | 'temperature_2m' | 'visibility' | 'uv_index';
/**
 * A forecast reply for the current-hour checks, shaped as Open-Meteo answers
 * models=ecmwf_ifs025,gfs_seamless with hourly= (probed 2026-10-14): one
 * suffixed series per model, ECMWF's visibility and UV null throughout. Its
 * `current` block would carry one unsuffixed model only, so it is not asked.
 */
function nowReply(m: { ecmwf?: Partial<Record<NowVar, F>>; gfs?: Partial<Record<NowVar, F>> }) {
    const hourly: Record<string, unknown> = { time: col((h) => (T0 + h * H) / 1000) };
    const vars: NowVar[] = ['weather_code', 'temperature_2m', 'visibility', 'uv_index'];
    for (const v of vars) {
        hourly[`${v}_ecmwf_ifs025`] = col(m.ecmwf?.[v] ?? flat(null));
        hourly[`${v}_gfs_seamless`] = col(m.gfs?.[v] ?? flat(null));
    }
    return { latitude: 0, longitude: 0, hourly };
}

const ahead = (reply: ReturnType<typeof windReply>) => readHourly(reply, kindVariables('ahead'), kindModels('ahead'))!;
const sea = (reply: ReturnType<typeof seaReply>, nowMs = NOON, at?: LatLon) =>
    waveChain(readHourly(reply, kindVariables('sea'), kindModels('sea')), nowMs, 24, at);
const nowAt = (reply: ReturnType<typeof nowReply>, nowMs: number) =>
    readNow(reply, kindVariables('now'), kindModels('now'), nowMs);

const PLACES = {
    antigua: { place: 'English Harbour', lat: 17.0, lon: -61.76 },
    corfu: { place: 'Κέρκυρα', lat: 39.62, lon: 19.92 },
    naha: { place: '那覇', lat: 26.21, lon: 127.68 },
    // A fictional US harbour, for the NWS advisories.
    zzbaytown: { place: 'Zzbaytown', lat: 39.1, lon: -76.4 },
};

function account(
    where: keyof typeof PLACES,
    notifications: AheadAccount['notifications'],
    extra: Partial<AheadAccount> = {},
): AheadAccount {
    const p = PLACES[where];
    return {
        userId: 'fixture-user',
        place: p.place,
        zone: tzLookup(p.lat, p.lon),
        units: {},
        hours: 24,
        notifications,
        goodWindow: false,
        limits: { windKts: null, waveFt: null },
        ...extra,
    };
}

const inputs = (extra: Partial<AheadInputs>): AheadInputs => ({
    ahead: null,
    sea: null,
    seaAnswered: false,
    now: null,
    official: [],
    ...extra,
});

/** Every word the skipper or a log could see: titles, bodies, payloads and status lines. */
const everything = (d: ReturnType<typeof decideForAccount>) =>
    JSON.stringify([d.pushes.map((p) => [p.title, p.body, p.data]), d.lines]);

const nws = (event: string, code: string, id?: number) => ({
    ...(id === undefined ? {} : { id }),
    provider: 'nws',
    infos: [{ event, eventCodes: [{ valueName: 'NationalWeatherService', value: code }] }],
});

describe('agreement: two of three models inside the same 3 h', () => {
    it('two models crossing inside 3 h agree, from the first crossing hour', () => {
        const a = agreeAhead(
            ahead(windReply({ ecmwf: from(20, 28, 12), icon: from(21, 26, 12), ukmo: flat(15) })),
            'wind_speed_10m',
            25,
            NOON,
            24,
        );
        expect(a.state).toBe('agree');
        if (a.state !== 'agree') return;
        expect(a.startMs).toBe(T0 + 20 * H);
        expect(a.endMs).toBe(T0 + 23 * H);
        expect(a.agreeing.map((m) => m.name)).toEqual(['ECMWF', 'ICON']);
        expect(a.peaks.map((p) => [p.model.name, p.peak])).toEqual([
            ['ECMWF', 28],
            ['ICON', 26],
        ]);
        expect(a.agreedValue).toBe(26);
    });

    it('one model alone is "models disagree", with the numbers, and nothing is pushed', () => {
        const d = decideForAccount(
            account('corfu', { wind: { enabled: true, threshold: 25 } }),
            inputs({ ahead: ahead(windReply({ ecmwf: from(20, 28, 12), icon: flat(14), ukmo: flat(15) })) }),
            NOON,
        );
        expect(d.pushes).toEqual([]);
        expect(d.lines).toEqual(['Wind: models disagree: ECMWF 28 kt, ICON 14 kt, UKMO not shown (your limit 25 kt).']);
    });

    it('two crossings more than 3 h apart do not agree', () => {
        const single =
            (at: number): F =>
            (h) =>
                h === at ? 30 : 10;
        const h = ahead(windReply({ ecmwf: single(20), icon: single(23), ukmo: flat(10) }));
        expect(agreeAhead(h, 'wind_speed_10m', 25, NOON, 24).state).toBe('disagree');
        const near = ahead(windReply({ ecmwf: single(20), icon: single(22), ukmo: flat(10) }));
        const a = agreeAhead(near, 'wind_speed_10m', 25, NOON, 24);
        expect(a.state === 'agree' && [a.startMs, a.endMs]).toEqual([T0 + 20 * H, T0 + 23 * H]);
    });

    it('a model of nulls has not answered, and one answering model is never enough', () => {
        const d = decideForAccount(
            account('corfu', { wind: { enabled: true, threshold: 25 } }),
            inputs({ ahead: ahead(windReply({ ecmwf: from(13, 40, 30) })) }),
            NOON,
        );
        expect(d.pushes).toEqual([]);
        expect(d.lines).toEqual(['Wind: not enough models answered (ECMWF only).']);
        // Mostly null (3 of 24 hours) is not an answer either.
        const sparse: F = (h) => (h >= 13 && h < 16 ? 40 : null);
        const a = agreeAhead(ahead(windReply({ ecmwf: flat(40), icon: sparse })), 'wind_speed_10m', 25, NOON, 24);
        expect(a.state).toBe('not-enough');
        // Nothing at all answered.
        expect(
            decideForAccount(
                account('corfu', { wind: { enabled: true, threshold: 25 } }),
                inputs({ ahead: ahead(windReply({})) }),
                NOON,
            ).lines,
        ).toEqual(['Wind: not enough models answered (none).']);
    });

    it('with ICON missing, ECMWF and UKMO agreeing is 2 of 3, and only ECMWF is quoted', () => {
        const d = decideForAccount(
            account('corfu', { wind: { enabled: true, threshold: 25 } }),
            inputs({ ahead: ahead(windReply({ ecmwf: from(20, 28, 12), ukmo: from(20, 29, 12) })) }),
            NOON,
        );
        expect(d.pushes).toHaveLength(1);
        expect(d.pushes[0].body).toBe(
            '2 of 3 models agree (ECMWF, UKMO) at Κέρκυρα: ECMWF 28 kt, over your 25 kt. Not an official warning. Forecast data: ECMWF, UK Met Office.',
        );
        expect(d.pushes[0].data.models).toEqual(['ECMWF', 'UKMO']);
    });

    it('looks only as far ahead as the skipper chose: 24 h by default, 6 h if asked', () => {
        const late = ahead(windReply({ ecmwf: from(40, 30, 10), icon: from(40, 30, 10), ukmo: flat(10) }));
        expect(agreeAhead(late, 'wind_speed_10m', 25, NOON, 24).state).toBe('clear');
        const soon = ahead(windReply({ ecmwf: from(20, 30, 10), icon: from(20, 30, 10), ukmo: flat(10) }));
        expect(agreeAhead(soon, 'wind_speed_10m', 25, NOON, 24).state).toBe('agree');
        expect(agreeAhead(soon, 'wind_speed_10m', 25, NOON, 6).state).toBe('clear');
        const d = decideForAccount(
            account('corfu', { wind: { enabled: true, threshold: 25 } }, { hours: 6 }),
            inputs({ ahead: soon }),
            NOON,
        );
        expect(d.lines).toEqual(['Wind: below your 25 kt for the next 6 h: ECMWF 10 kt, ICON 10 kt, UKMO not shown.']);
    });

    it('gusts agree the same way, on their own threshold', () => {
        const h = ahead(
            windReply(
                { ecmwf: flat(15), icon: flat(15), ukmo: flat(15) },
                { ecmwf: from(18, 47, 20), icon: from(19, 46, 20), ukmo: flat(20) },
            ),
        );
        const d = decideForAccount(
            account('corfu', { gusts: { enabled: true, threshold: 40 } }),
            inputs({ ahead: h }),
            NOON,
        );
        expect(d.pushes.map((p) => p.title)).toEqual(['Forecast: gale-force gusts, Wed 21:00–00:00']);
    });
});

describe('batches and the call volume on the paid key', () => {
    it('splits the places into requests of 50, each listing every place of its batch', () => {
        const points = Array.from({ length: 120 }, (_, i) => ({ lat: -40 + i * 0.5, lon: 170 - i }));
        const batches = batchPoints(points);
        expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
        const q = requestParams('ahead', batches[2]);
        expect(q.latitude.split(',')).toHaveLength(20);
        expect(q.longitude.split(',')).toHaveLength(20);
        expect(q.latitude.split(',')[0]).toBe(String(points[100].lat));
    });

    it('pins &models= on every request, asks absolute times, and never carries the key', () => {
        const one = [{ lat: 17.0, lon: -61.76 }];
        expect(requestParams('ahead', one)).toEqual({
            latitude: '17',
            longitude: '-61.76',
            hourly: 'wind_speed_10m,wind_gusts_10m',
            models: 'ecmwf_ifs025,icon_seamless,ukmo_global_deterministic_10km',
            forecast_days: '3',
            timezone: 'GMT',
            timeformat: 'unixtime',
            wind_speed_unit: 'kn',
            cell_selection: 'sea',
        });
        expect(requestParams('sea', one).models).toBe('ecmwf_wam025,meteofrance_wave');
        expect(requestParams('sea', one).hourly).toBe('wave_height,wave_period');
        expect(requestParams('now', one).models).toBe('ecmwf_ifs025,gfs_seamless');
        expect(requestParams('now', one).hourly).toBe('weather_code,temperature_2m,visibility,uv_index');
        for (const kind of ['ahead', 'sea', 'now'] as const) {
            expect(Object.keys(requestParams(kind, one))).not.toContain('apikey');
        }
    });

    it('asks hourly whenever it pins two models or more: Open-Meteo’s `current` block answers only the first', () => {
        // Probed 2026-10-14 with models=ecmwf_ifs025,gfs_seamless: `current` came back as
        // { weather_code, temperature_2m, visibility: null, uv_index: null }, unsuffixed, ECMWF only.
        const one = [{ lat: 39.6, lon: 19.9 }];
        for (const kind of ['ahead', 'sea', 'now'] as const) {
            const q = requestParams(kind, one);
            expect(q.current, kind).toBeUndefined();
            expect(q.hourly, kind).toBe(kindVariables(kind).join(','));
            expect(q.models.split(',').length, kind).toBeGreaterThan(1);
        }
    });

    it('reads the hour under way per model from a real-shaped reply: ECMWF first, GFS where ECMWF has none', () => {
        const reply = nowReply({
            ecmwf: { weather_code: (h) => (h === 12 ? 61 : 3), temperature_2m: (h) => 20 + h / 10 },
            gfs: {
                weather_code: flat(2),
                temperature_2m: flat(15),
                visibility: (h) => (h === 12 ? 1500 : 24_000),
                uv_index: flat(4),
            },
        });
        // 12:30 UTC: the 12:00 hour is under way.
        const now = nowAt(reply, NOON + 30 * 60_000)!;
        expect(now.weather_code).toEqual({ value: 61, model: kindModels('now')[0] });
        expect(now.temperature_2m?.value).toBeCloseTo(21.2);
        expect(now.temperature_2m?.model.name).toBe('ECMWF');
        expect(now.visibility).toEqual({ value: 1500, model: kindModels('now')[1] });
        expect(now.uv_index?.model.name).toBe('GFS');
        // An hour on, the next hour is read.
        expect(nowAt(reply, NOON + 90 * 60_000)!.visibility?.value).toBe(24_000);
        // Nothing for the hour under way: no reading, not a stale one.
        expect(nowAt(reply, T0 + HOURS * H + 5 * H)).toBeNull();
        // The `current` block Open-Meteo sends for two models (unsuffixed, first only) is not read.
        expect(nowAt({ current: { weather_code: 95, temperature_2m: 30 } } as never, NOON)).toBeNull();
    });

    it('counts a call per place, each request under 10 variables and 14 days', () => {
        expect([callWeight('ahead'), callWeight('sea'), callWeight('now')]).toEqual([1, 1, 1]);
        // 100 skippers at 100 places, wind and seas armed: 4 requests a run, 200 calls.
        expect(estimateCallVolume({ ahead: 100, sea: 100 })).toEqual({
            requestsPerRun: 4,
            callsPerRun: 200,
            callsPerDay: 9_600,
            callsPer30Days: 288_000,
        });
        // 1,000 places with every kind armed: 60 requests and 3,000 calls a run, 4.32 M a month.
        expect(estimateCallVolume({ ahead: 1000, sea: 1000, now: 1000 })).toEqual({
            requestsPerRun: 60,
            callsPerRun: 3_000,
            callsPerDay: 144_000,
            callsPer30Days: 4_320_000,
        });
    });

    it('over the run’s ceiling the places rotate, so every one is read within a few runs, and is told so', () => {
        const keys = ['-27.5,153', '17,-61.8', '39.6,19.9', '26.2,127.7', '39.1,-76.4'];
        expect(placesThisRun(keys, 10, 7)).toEqual(new Set(keys));
        const runs = [0, 1, 2].map((r) => placesThisRun(keys, 2, r));
        for (const r of runs) expect(r.size).toBe(2);
        // Three runs of two read all five: nobody is left out run after run.
        expect(new Set(runs.flatMap((r) => [...r]))).toEqual(new Set(keys));
        // The order the accounts were read in does not choose who waits.
        expect(placesThisRun([...keys].reverse(), 2, 1)).toEqual(runs[1]);
        expect(overCapacityLine(5, 2)).toBe(
            'Not checked this run: more positions than one run can read. Yours is read at least every 1 h 30 min.',
        );
        expect(overCapacityLine(3_000, 2_000)).toBe(
            'Not checked this run: more positions than one run can read. Yours is read at least every 1 h.',
        );
    });

    it('reads a list reply in order, a single place as an object, and refuses a list of another length', () => {
        expect(parseReplies([{ a: 1 }, { a: 2 }], 2)).toEqual([{ a: 1 }, { a: 2 }]);
        expect(parseReplies({ a: 1 }, 1)).toEqual([{ a: 1 }]);
        expect(parseReplies([{ a: 1 }], 2)).toBeNull();
        expect(parseReplies('nope', 1)).toBeNull();
    });

    it('reads a model’s own suffixed field, or the bare one when it is the only model asked', () => {
        const h = readHourly(
            { hourly: { time: [T0 / 1000, T0 / 1000 + 3600], wind_speed_10m: [10, 11] } },
            ['wind_speed_10m'],
            [WIND_MODELS[0]],
        );
        expect(h?.series['wind_speed_10m|ecmwf_ifs025']).toEqual([10, 11]);
        expect(readHourly({ hourly: { time: ['2026-10-14T00:00'] } }, ['wind_speed_10m'], WIND_MODELS)).toBeNull();
    });
});

describe('copy in the skipper’s units, on the boat’s clock', () => {
    const twoAgree = () =>
        ahead(windReply({ ecmwf: from(20, 28, 12), icon: from(20, 26, 12), ukmo: from(20, 27, 12) }));

    it('English Harbour, Antigua, in mph and feet, on Atlantic time', () => {
        const d = decideForAccount(
            account(
                'antigua',
                { wind: { enabled: true, threshold: 25 }, waves: { enabled: true, threshold: 6 } },
                { units: { speed: 'mph', waveHeight: 'ft' } },
            ),
            inputs({
                ahead: twoAgree(),
                sea: sea(seaReply({ wam: [from(20, 2.6, 1), flat(9)] })),
                seaAnswered: true,
            }),
            NOON,
        );
        expect(d.pushes.map((p) => [p.title, p.body])).toEqual([
            [
                'Forecast: strong wind, Wed 16:00–19:00',
                '3 of 3 models agree (ECMWF, ICON, UKMO) at English Harbour: ECMWF 32 mph, ICON 30 mph, over your 29 mph. Not an official warning. Forecast data: ECMWF, DWD ICON, UK Met Office.',
            ],
            [
                'Forecast: rough seas, Wed 16:00–19:00',
                'ECMWF WAM at English Harbour: up to 8.5 ft, over your 6 ft. Not an official warning. Forecast data: ECMWF.',
            ],
        ]);
        expect(d.pushes.map((p) => p.alertKey)).toEqual([
            'wind-ahead-strong-2026-10-14',
            'waves-ahead-rough-2026-10-14',
        ]);
    });

    it('Κέρκυρα (Corfu) in metres and knots, on Greek summer time', () => {
        // 2 m typed in Settings is stored as 6.56 ft (AlertsTab), and read back as 2 m.
        const d = decideForAccount(
            account(
                'corfu',
                { waves: { enabled: true, threshold: 6.56 }, swellPeriod: { enabled: true, threshold: 12 } },
                { units: { waveHeight: 'm' } },
            ),
            inputs({ sea: sea(seaReply({ wam: [from(15, 2.6, 1), from(15, 14, 8)] })), seaAnswered: true }),
            NOON,
        );
        expect(d.pushes.map((p) => [p.title, p.body])).toEqual([
            [
                'Forecast: rough seas, Wed 18:00–21:00',
                'ECMWF WAM at Κέρκυρα: up to 2.6 m, over your 2 m. Not an official warning. Forecast data: ECMWF.',
            ],
            [
                'Forecast: long-period swell, Wed 18:00–21:00',
                'ECMWF WAM at Κέρκυρα: up to 14 s, over your 12 s. Not an official warning. Forecast data: ECMWF.',
            ],
        ]);
    });

    it('那覇 (Naha) is already Thursday: the window and the day of its key are the boat’s', () => {
        // 23:00 UTC Wednesday is 08:00 Thursday in Naha.
        const late = ahead(windReply({ ecmwf: from(23, 28, 12), icon: from(23, 26, 12), ukmo: from(23, 27, 12) }));
        const d = decideForAccount(
            account('naha', { wind: { enabled: true, threshold: 25 } }, { units: { speed: 'kmh' } }),
            inputs({ ahead: late }),
            NOON,
        );
        expect(d.pushes[0].title).toBe('Forecast: strong wind, Thu 08:00–11:00');
        expect(d.pushes[0].body).toContain('at 那覇: ECMWF 52 km/h, ICON 48 km/h, over your 46 km/h.');
        expect(d.pushes[0].alertKey).toBe('wind-ahead-strong-2026-10-15');
    });

    it('the current-hour checks read in the skipper’s units too, and name the model that answered', () => {
        const now = nowAt(
            nowReply({
                ecmwf: { temperature_2m: flat(36), weather_code: flat(61) },
                gfs: { temperature_2m: flat(35), visibility: flat(1500), weather_code: flat(3) },
            }),
            NOON,
        );
        const d = decideForAccount(
            account(
                'corfu',
                {
                    visibility: { enabled: true, threshold: 1 },
                    tempHigh: { enabled: true, threshold: 35 },
                    precipitation: { enabled: true },
                    uv: { enabled: true, threshold: 8 },
                },
                { units: { visibility: 'km', temp: 'F' } },
            ),
            inputs({ now }),
            NOON,
        );
        expect(d.pushes.map((p) => [p.title, p.body])).toEqual([
            [
                'Forecast: poor visibility now, 1.5 km',
                'GFS at Κέρκυρα: visibility 1.5 km, under your 1.9 km. Not an official warning. Forecast data: NOAA.',
            ],
            [
                'Forecast: heat, 97 °F now',
                'ECMWF at Κέρκυρα: air 97 °F, over your 95 °F. Not an official warning. Forecast data: ECMWF.',
            ],
            [
                'Forecast: rain now',
                'ECMWF at Κέρκυρα: rain in the forecast for this hour. Not an official warning. Forecast data: ECMWF.',
            ],
        ]);
        expect(d.pushes.map((p) => p.alertKey)).toEqual([
            'visibility-2026-10-14',
            'tempHigh-2026-10-14',
            'precipitation-wet-2026-10-14',
        ]);
        expect(d.lines).toEqual([]);
    });
});

describe('one push per strength per day of the event, and the day turns at 07:00 on the boat', () => {
    const corfuWind = () => account('corfu', { wind: { enabled: true, threshold: 25 } });
    const both = (start: number, kts: number) =>
        ahead(windReply({ ecmwf: from(start, kts, 10), icon: from(start, kts + 1, 10), ukmo: flat(10) }));

    it('a forecast that gets worse the same day pushes again; the same strength, or a weaker one, does not', () => {
        // 05:00 UTC (08:00 in Corfu): the models agree on 28 kt from 12:00 UTC.
        const strong = decideForAccount(corfuWind(), inputs({ ahead: both(12, 28) }), T0 + 5 * H).pushes[0];
        expect(strong.title).toBe('Forecast: strong wind, Wed 15:00–18:00');
        // 11:00 UTC: new runs agree on 55 kt from 13:00, inside 3 h: storm force, the critical type.
        const storm = decideForAccount(corfuWind(), inputs({ ahead: both(13, 55) }), T0 + 11 * H).pushes[0];
        expect(storm.title).toBe('Forecast: storm-force wind, Wed 16:00–19:00');
        expect(storm.type).toBe('severe_weather_alert');
        expect(storm.alertKey).not.toBe(strong.alertKey);
        // The same strength half an hour on is the same key: claimed once.
        const again = decideForAccount(corfuWind(), inputs({ ahead: both(13, 56) }), T0 + 11.5 * H).pushes[0];
        expect(again.alertKey).toBe(storm.alertKey);
        // Pushing storm force claims the weaker strengths of the day too, so easing to a gale stays quiet.
        const gale = decideForAccount(corfuWind(), inputs({ ahead: both(14, 38) }), T0 + 12 * H).pushes[0];
        expect(gale.title).toMatch(/^Forecast: gale-force wind/);
        expect(storm.alsoClaims).toContain(gale.alertKey);
        expect(storm.alsoClaims).toContain(strong.alertKey);
        expect(storm.alsoClaims).not.toContain(storm.alertKey);
        // And the strong-wind push claims nothing stronger.
        expect(strong.alsoClaims).not.toContain(gale.alertKey);
        expect(new Set([strong.alertKey, gale.alertKey, storm.alertKey]).size).toBe(3);
    });

    it('seas going from rough to dangerous push again', () => {
        const waves = account('corfu', { waves: { enabled: true, threshold: 6.56 } });
        const rough = decideForAccount(
            waves,
            inputs({ sea: sea(seaReply({ wam: [from(15, 2.6, 1), flat(9)] })), seaAnswered: true }),
            NOON,
        ).pushes[0];
        const dangerous = decideForAccount(
            waves,
            inputs({ sea: sea(seaReply({ wam: [from(15, 5, 1), flat(9)] })), seaAnswered: true }),
            NOON,
        ).pushes[0];
        expect([rough.title, dangerous.title]).toEqual([
            'Forecast: rough seas, Wed 18:00–21:00',
            'Forecast: dangerous seas, Wed 18:00–21:00',
        ]);
        expect(dangerous.alertKey).not.toBe(rough.alertKey);
        expect(dangerous.alsoClaims).toContain(rough.alertKey);
    });

    it('a gale that blows through the night pushes no new alert before 07:00 at the boat', () => {
        // 38 kt agreed from 15:00 UTC Wednesday (18:00 in Corfu) to 16:00 UTC Thursday.
        const night = ahead(
            windReply({
                ecmwf: (h) => (h >= 15 && h < 40 ? 38 : 10),
                icon: (h) => (h >= 15 && h < 40 ? 39 : 10),
                ukmo: flat(10),
            }),
        );
        const keyAt = (utcHour: number) => {
            const d = decideForAccount(corfuWind(), inputs({ ahead: night }), T0 + utcHour * H);
            expect(d.held, `${utcHour} UTC`).toEqual([]);
            return d.pushes[0].alertKey;
        };
        // 15:00, 23:30, 00:00, 03:00 and 06:00 in Corfu: one key, so one push.
        const keys = [12, 20.5, 21, 24, 27].map(keyAt);
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toBe('wind-ahead-gale-2026-10-14');
        // 07:00 in Corfu, the night over: still blowing, so the new day's one reminder.
        expect(keyAt(28)).toBe('wind-ahead-gale-2026-10-15');
    });

    it('a current-hour alert under way all night keeps its key past midnight', () => {
        const cold = account('corfu', { tempLow: { enabled: true, threshold: 10 } });
        const reply = nowReply({ ecmwf: { temperature_2m: flat(5) } });
        // 22:00, 00:30 and 06:30 in Corfu.
        const keys = [19, 21.5, 27.5].map(
            (h) => decideForAccount(cold, inputs({ now: nowAt(reply, T0 + h * H) }), T0 + h * H).pushes[0].alertKey,
        );
        expect(keys).toEqual(['tempLow-2026-10-14', 'tempLow-2026-10-14', 'tempLow-2026-10-14']);
    });

    it('the alert day is the boat’s: it turns at 07:00 in its own zone', () => {
        const athens = tzLookup(39.62, 19.92);
        expect(alertDay(T0 + 3 * H, athens)).toBe('2026-10-13'); // 06:00 Wednesday
        expect(alertDay(T0 + 4 * H, athens)).toBe('2026-10-14'); // 07:00 Wednesday
        expect(alertDay(T0 + 21 * H, athens)).toBe('2026-10-14'); // 00:00 Thursday
        // 1 March after a leap day, and a nautical zone with no IANA name.
        expect(alertDay(Date.UTC(2028, 2, 1, 2), 'UTC')).toBe('2028-02-29');
        expect(alertDay(Date.UTC(2026, 0, 1, 5), -150)).toBe('2025-12-31');
    });

    it('rain that turns to thunder pushes again; thunder easing to rain does not', () => {
        const wet = account('corfu', { precipitation: { enabled: true } });
        const at = (code: number) =>
            decideForAccount(wet, inputs({ now: nowAt(nowReply({ ecmwf: { weather_code: flat(code) } }), NOON) }), NOON)
                .pushes[0];
        const rain = at(61);
        const thunder = at(95);
        expect([rain.title, thunder.title]).toEqual(['Forecast: rain now', 'Forecast: thunderstorms now']);
        expect(thunder.alertKey).not.toBe(rain.alertKey);
        expect(thunder.alsoClaims).toContain(rain.alertKey);
    });
});

describe('seas: one named wave model, and honest where there is none', () => {
    it('ECMWF WAM first, Météo-France MFWAM where WAM has no water', () => {
        expect(sea(seaReply({ wam: [flat(1.2), flat(8)], mfwam: [flat(0.9), flat(7)] }))?.model.name).toBe('ECMWF WAM');
        const sheltered = sea(seaReply({ mfwam: [from(15, 2.6, 0.5), flat(6)] }));
        expect(sheltered?.model.name).toBe('Météo-France MFWAM');
        const d = decideForAccount(
            account('corfu', { waves: { enabled: true, threshold: 6.56 } }),
            inputs({ sea: sheltered, seaAnswered: true }),
            NOON,
        );
        expect(d.pushes[0].body).toBe(
            'Météo-France MFWAM at Κέρκυρα: up to 2.6 m, over your 2 m. Not an official warning. Forecast data: Météo-France.',
        );
    });

    it('a land-mask cell (0 m, no period) is no water, not a flat calm', () => {
        expect(sea(seaReply({ wam: [flat(0), flat(0)], mfwam: [flat(0.4), flat(5)] }))?.model.name).toBe(
            'Météo-France MFWAM',
        );
        expect(sea(seaReply({ wam: [flat(0), flat(0)] }))).toBeNull();
    });

    it('neither model has water here: "no wave model here", never calm, and nothing pushed', () => {
        const none = sea(seaReply({}));
        expect(none).toBeNull();
        const d = decideForAccount(
            account('corfu', {
                waves: { enabled: true, threshold: 6.56 },
                swellPeriod: { enabled: true, threshold: 12 },
            }),
            inputs({ sea: none, seaAnswered: true }),
            NOON,
        );
        expect(d.pushes).toEqual([]);
        expect(d.lines).toEqual(['Seas: no wave model here.', 'Swell period: no wave model here.']);
        expect(everything(d)).not.toMatch(/calm/i);
        // No marine reply at all is said as that, not as sheltered water.
        const silent = decideForAccount(
            account('corfu', { waves: { enabled: true, threshold: 6.56 } }),
            inputs({}),
            NOON,
        );
        expect(silent.lines).toEqual(['Seas: no wave forecast answered this run.']);
    });

    it('a wave cell Open-Meteo reached far from the point is not the sea here (the app’s snap rule)', () => {
        // A fictional river berth at -27.5, 153.0: the two-model reply echoes WAM's cell, which
        // Open-Meteo found 0.25° east (~25 km, out in the bay) past dry cells; MFWAM is dry there.
        const berth = { lat: -27.5, lon: 153.0 };
        const far = { ...seaReply({ wam: [flat(0.36), flat(4)] }), latitude: -27.5, longitude: 153.25 };
        expect(sea(far, NOON, berth)).toBeNull();
        const d = decideForAccount(
            account('corfu', { waves: { enabled: true, threshold: 1 } }),
            inputs({ sea: sea(far, NOON, berth), seaAnswered: true }),
            NOON,
        );
        expect(d.lines).toEqual(['Seas: no wave model here.']);
        expect(d.pushes).toEqual([]);
        // Where MFWAM has its own water, it is read instead.
        const mf = {
            ...seaReply({ wam: [flat(0.36), flat(4)], mfwam: [flat(0.3), flat(4)] }),
            latitude: -27.5,
            longitude: 153.25,
        };
        expect(sea(mf, NOON, berth)?.model.name).toBe('Météo-France MFWAM');
        // WAM's own cell (on the point, or half a cell off offshore) is its water.
        expect(sea({ ...far, latitude: -27.5, longitude: 153.0 }, NOON, berth)?.model.name).toBe('ECMWF WAM');
        expect(sea({ ...far, latitude: -27.5, longitude: 153.5 }, NOON, { lat: -27.4, lon: 153.4 })?.model.name).toBe(
            'ECMWF WAM',
        );
        // The Whitsunday Passage: WAM's cell is on the point but dry, and MFWAM answers.
        const passage = { ...seaReply({ mfwam: [flat(0.2), flat(3)] }), latitude: -20.25, longitude: 148.75 };
        expect(sea(passage, NOON, { lat: -20.25, lon: 148.75 })?.model.name).toBe('Météo-France MFWAM');
    });

    it('reads the first hour over the limit and the peak in the 3 h from it', () => {
        const w = sea(seaReply({ wam: [(h) => (h >= 15 ? 2 + (h - 15) * 0.2 : 1), flat(8)] }))!;
        expect(seaAhead(w, 'height', 2, NOON, 24)).toEqual({
            state: 'cross',
            startMs: T0 + 15 * H,
            endMs: T0 + 18 * H,
            peak: 2.4,
        });
        expect(seaAhead(w, 'height', 9, NOON, 24).state).toBe('clear');
    });
});

describe('licence: UKMO is named and counted, never quoted', () => {
    // UKMO alone reads gale force; ECMWF and ICON read strong wind.
    const h = () => ahead(windReply({ ecmwf: from(20, 30, 12), icon: from(20, 31, 12), ukmo: from(20, 41, 12) }));
    const ukmoInEveryUnit = [/\b41 kt/, /\b47 mph/, /\b76 km\/h/, /\b21\.1 m\/s/, /\b41\b/];

    for (const speed of ['kts', 'mph', 'kmh', 'mps']) {
        it(`no UKMO number in a push, its payload or the status, in ${speed}`, () => {
            const d = decideForAccount(
                account('antigua', { wind: { enabled: true, threshold: 25 } }, { units: { speed } }),
                inputs({ ahead: h() }),
                NOON,
            );
            expect(d.pushes).toHaveLength(1);
            for (const re of ukmoInEveryUnit) expect(everything(d)).not.toMatch(re);
            // Even the strength word is the quotable models' own: strong, not gale.
            expect(d.pushes[0].title.startsWith('Forecast: strong wind')).toBe(true);
            expect(d.pushes[0].body).toContain('UKMO');
        });
    }

    it('UKMO alone over the limit is "models disagree" with its value withheld', () => {
        const d = decideForAccount(
            account('antigua', { wind: { enabled: true, threshold: 35 } }),
            inputs({ ahead: h() }),
            NOON,
        );
        expect(d.pushes).toEqual([]);
        expect(d.lines).toEqual(['Wind: models disagree: ECMWF 30 kt, ICON 31 kt, UKMO not shown (your limit 35 kt).']);
        for (const re of ukmoInEveryUnit) expect(everything(d)).not.toMatch(re);
    });
});

describe('an official warning already in force covers the forecast alert', () => {
    const gale = () => ahead(windReply({ ecmwf: from(14, 38, 12), icon: from(14, 36, 12), ukmo: flat(12) }));
    const storm = () => ahead(windReply({ ecmwf: from(14, 52, 12), icon: from(14, 50, 12), ukmo: flat(12) }));
    const strong = () => ahead(windReply({ ecmwf: from(14, 28, 12), icon: from(14, 26, 12), ukmo: flat(12) }));
    const wind = { wind: { enabled: true, threshold: 25 } };

    it('a Gale Warning drops a gale-force forecast push, and says so; storm-force still goes', () => {
        const official = [nws('Gale Warning', 'GLW')];
        const d = decideForAccount(account('corfu', wind), inputs({ ahead: gale(), official }), NOON);
        expect(d.pushes).toEqual([]);
        expect(d.covered).toEqual(['wind']);
        expect(d.lines[0]).toMatch(/Covered by an official warning in force here\.$/);
        const s = decideForAccount(account('corfu', wind), inputs({ ahead: storm(), official }), NOON);
        expect(s.pushes.map((p) => p.title)).toEqual(['Forecast: storm-force wind, Wed 17:00–20:00']);
    });

    it('a Small Craft Advisory covers strong wind and rough seas, never gale-force', () => {
        const official = [nws('Small Craft Advisory', 'SCY')];
        expect(decideForAccount(account('corfu', wind), inputs({ ahead: strong(), official }), NOON).pushes).toEqual(
            [],
        );
        expect(decideForAccount(account('corfu', wind), inputs({ ahead: gale(), official }), NOON).pushes).toHaveLength(
            1,
        );
        const rough = sea(seaReply({ wam: [from(15, 2.6, 1), flat(9)] }));
        const d = decideForAccount(
            account('corfu', { waves: { enabled: true, threshold: 6.56 } }),
            inputs({ sea: rough, seaAnswered: true, official }),
            NOON,
        );
        expect(d.covered).toEqual(['waves']);
    });

    it('covers only with a warning this skipper was sent: a muted advisory, or one told elsewhere, covers nothing', () => {
        // Zzbaytown (fictional, US East Coast): wind limit 18 kt, the models agree on 21 kt,
        // and an NWS Small Craft Advisory is in force at the saved place.
        const scy = nws('Small Craft Advisory', 'SCY', 7);
        const atPlace = [scy];
        const wind18 = account('zzbaytown', { wind: { enabled: true, threshold: 18 } });
        const h = ahead(windReply({ ecmwf: from(14, 21, 8), icon: from(14, 22, 8), ukmo: flat(8) }));
        // Sent to this account (official-alerts-watch recorded the push): covered.
        expect(deliveredOfficial(atPlace, new Set([7]))).toEqual([scy]);
        const told = decideForAccount(
            wind18,
            inputs({ ahead: h, official: deliveredOfficial(atPlace, new Set([7])), officialAtPlace: atPlace }),
            NOON,
        );
        expect(told.covered).toEqual(['wind']);
        expect(told.pushes).toEqual([]);
        // Advisories muted, official warnings off, or the warning told at the boat's fix
        // elsewhere: no delivery row for it, so the skipper's own threshold still pushes.
        for (const delivered of [new Set<number>(), new Set([8]), undefined]) {
            const official = deliveredOfficial(atPlace, delivered);
            expect(official).toEqual([]);
            const d = decideForAccount(wind18, inputs({ ahead: h, official, officialAtPlace: atPlace }), NOON);
            expect(d.covered).toEqual([]);
            expect(d.pushes.map((p) => p.title)).toEqual(['Forecast: wind above your limit, Wed 10:00–13:00']);
        }
        // A warning with no id cannot be matched to a delivery: never covers.
        expect(deliveredOfficial([nws('Small Craft Advisory', 'SCY')], new Set([7]))).toEqual([]);
    });

    it('a good window waits for any official wind or sea warning at the place, sent to this skipper or not', () => {
        const easing = ahead(windReply({ ecmwf: from(18, 12, 30), icon: from(18, 11, 30), ukmo: flat(30) }));
        const calm = sea(seaReply({ wam: [flat(1), flat(7)] }));
        const d = decideForAccount(
            account('corfu', {}, { goodWindow: true, limits: { windKts: 25, waveFt: 6.56 } }),
            inputs({
                ahead: easing,
                sea: calm,
                seaAnswered: true,
                official: [],
                officialAtPlace: [nws('Small Craft Advisory', 'SCY', 7)],
            }),
            NOON,
        );
        expect(d.pushes).toEqual([]);
        expect(d.covered).toEqual(['goodWindow']);
    });

    it('decides exactly as the app’s 129-06 predicate reads the same "Forecast:" text', () => {
        const cases = [
            [gale(), [nws('Gale Warning', 'GLW')]],
            [storm(), [nws('Gale Warning', 'GLW')]],
            [strong(), [nws('Small Craft Advisory', 'SCY')]],
            [gale(), [nws('Small Craft Advisory', 'SCY')]],
            [storm(), [nws('Storm Warning', 'SRW')]],
            [strong(), [nws('Dense Fog Advisory', 'MFY')]],
        ] as const;
        for (const [h, official] of cases) {
            const title = decideForAccount(account('corfu', wind), inputs({ ahead: h }), NOON).pushes[0].title;
            expect(forecastAlertRule(title), title).toBeDefined();
            const covered =
                decideForAccount(account('corfu', wind), inputs({ ahead: h, official }), NOON).pushes.length === 0;
            expect(covered, `${title} under ${official[0].infos[0].event}`).toBe(
                forecastAlertCoveredByOfficial(title, official),
            );
        }
    });

    it('the current-hour checks too: thunder, heat, fog and cold are covered as the app reads their text', () => {
        const hot = nowAt(
            nowReply({
                ecmwf: { weather_code: flat(95), temperature_2m: flat(36) },
                gfs: { visibility: flat(900), uv_index: flat(11) },
            }),
            NOON,
        );
        const chill = nowAt(nowReply({ ecmwf: { weather_code: flat(3), temperature_2m: flat(2) } }), NOON);
        const skipper = account('corfu', {
            visibility: { enabled: true, threshold: 1 },
            uv: { enabled: true, threshold: 8 },
            tempHigh: { enabled: true, threshold: 35 },
            tempLow: { enabled: true, threshold: 5 },
            precipitation: { enabled: true },
        });
        const warnings = [
            [nws('Special Marine Warning', 'SMW')],
            [nws('Excessive Heat Warning', 'EHW')],
            [nws('Dense Fog Advisory', 'MFY')],
            [nws('Freeze Warning', 'FZW')],
        ];
        const seen = new Set<string>();
        for (const now of [hot, chill]) {
            const all = decideForAccount(skipper, inputs({ now }), NOON).pushes.map((p) => p.title);
            for (const official of warnings) {
                const left = decideForAccount(skipper, inputs({ now, official }), NOON).pushes.map((p) => p.title);
                for (const title of all) {
                    const covered = !left.includes(title);
                    if (covered) seen.add(title);
                    expect(covered, `${title} under ${official[0].infos[0].event}`).toBe(
                        forecastAlertCoveredByOfficial(title, official),
                    );
                }
            }
        }
        // The predicate does cover some of them: thunder under a Special Marine Warning, and heat.
        expect([...seen].sort()).toEqual([
            'Forecast: heat, 36 °C now',
            'Forecast: poor visibility now, 0.5 nm',
            'Forecast: thunderstorms now',
        ]);
    });
});

describe('quiet hours on the boat’s clock', () => {
    // 00:00 UTC is 03:00 in Corfu (EEST).
    const at = (start: number) =>
        ahead(windReply({ ecmwf: from(start, 30, 10), icon: from(start, 30, 10), ukmo: flat(10) }));
    const wind = { wind: { enabled: true, threshold: 25 } };

    it('holds a forecast alert between 22:00 and 07:00 unless its window starts within 3 h', () => {
        const held = decideForAccount(account('corfu', wind), inputs({ ahead: at(4) }), T0);
        expect(held.pushes).toEqual([]);
        expect(held.held).toEqual(['wind']);
        // Held, it goes at 07:00, or once its window is 3 h off if that is sooner: the line says both.
        expect(held.lines[0]).toMatch(/ Held overnight: sent at 07:00, or 3 h before it starts if sooner\.$/);
        const soon = decideForAccount(account('corfu', wind), inputs({ ahead: at(2) }), T0);
        expect(soon.pushes.map((p) => p.title)).toEqual(['Forecast: strong wind, Wed 05:00–08:00']);
        // The same alert at 15:00 in Corfu goes at once.
        expect(decideForAccount(account('corfu', wind), inputs({ ahead: at(20) }), NOON).pushes).toHaveLength(1);
    });

    it('is the boat’s own clock: 03:00 in Corfu is 20:00 the evening before in Antigua', () => {
        expect(holdOvernight(T0, tzLookup(39.62, 19.92), T0 + 4 * H)).toBe(true);
        expect(holdOvernight(T0, tzLookup(17.0, -61.76), T0 + 4 * H)).toBe(false);
        expect(holdOvernight(T0, tzLookup(39.62, 19.92), T0 + 3 * H)).toBe(false);
    });
});

describe('style: a forecast alert never looks like an official warning', () => {
    it('reads "Forecast:", says it is not official, and goes as the forecast toast’s type', () => {
        const h = ahead(
            windReply(
                { ecmwf: from(13, 55, 12), icon: from(13, 56, 12), ukmo: flat(12) },
                { ecmwf: from(13, 70, 20), icon: from(13, 68, 20), ukmo: flat(20) },
            ),
        );
        const d = decideForAccount(
            account('corfu', {
                wind: { enabled: true, threshold: 25 },
                gusts: { enabled: true, threshold: 40 },
                waves: { enabled: true, threshold: 6.56 },
            }),
            inputs({ ahead: h, sea: sea(seaReply({ wam: [from(13, 5, 1), flat(9)] })), seaAnswered: true }),
            NOON,
        );
        expect(d.pushes).toHaveLength(3);
        for (const p of d.pushes) {
            expect(p.title.startsWith('Forecast: '), p.title).toBe(true);
            expect(p.body).toContain('Not an official warning.');
            expect(p.body).toMatch(/Forecast data: /);
            expect(['weather_alert', 'severe_weather_alert']).toContain(p.type);
            expect(p.type).not.toBe('official_warning');
            expect(p.data.forecast).toBe(true);
            expect(JSON.stringify(p.data)).not.toMatch(/"(lat|lon|latitude|longitude)"/);
        }
        // Storm force agreed inside 3 h keeps today's severe type; further out it is a forecast.
        expect(d.pushes.map((p) => p.type)).toEqual(['severe_weather_alert', 'severe_weather_alert', 'weather_alert']);
        expect(d.pushes.map((p) => p.title)).toEqual([
            'Forecast: storm-force wind, Wed 16:00–19:00',
            'Forecast: storm-force gusts, Wed 16:00–19:00',
            'Forecast: dangerous seas, Wed 16:00–19:00',
        ]);
        // A picked place carries its position in its name: the push never does.
        const named = decideForAccount(
            account('corfu', { wind: { enabled: true, threshold: 25 } }, { place: 'Zzbaytown (39.1, -76.4)' }),
            inputs({ ahead: h }),
            NOON,
        );
        expect(named.pushes[0].body).toContain(' at Zzbaytown: ');
        expect(everything(named)).not.toMatch(/39\.1|-76\.4/);
        const later = ahead(windReply({ ecmwf: from(20, 55, 12), icon: from(20, 56, 12), ukmo: flat(12) }));
        expect(
            decideForAccount(
                account('corfu', { wind: { enabled: true, threshold: 25 } }),
                inputs({ ahead: later }),
                NOON,
            ).pushes[0].type,
        ).toBe('weather_alert');
    });
});

describe('good window opens', () => {
    const limits = { windKts: 25, waveFt: 6.56 };
    const easing = () => ahead(windReply({ ecmwf: from(18, 12, 30), icon: from(18, 11, 30), ukmo: flat(30) }));
    const calm = sea(seaReply({ wam: [flat(1), flat(7)] }));

    it('when two models rate a 6 h window Go after hours that are not, with the passage card’s scorer', () => {
        const g = goodWindowAhead(easing(), calm, { maxWindKts: 25, maxWaveM: 2 }, NOON, 24);
        expect(g.state === 'opens' && [g.startMs, g.endMs, g.agreeing.map((m) => m.name)]).toEqual([
            T0 + 18 * H,
            T0 + 24 * H,
            ['ECMWF', 'ICON'],
        ]);
        const d = decideForAccount(
            account('corfu', {}, { goodWindow: true, limits }),
            inputs({ ahead: easing(), sea: calm, seaAnswered: true }),
            NOON,
        );
        expect(d.pushes.map((p) => [p.title, p.body])).toEqual([
            [
                'Forecast: good window opens, Wed 21:00–03:00',
                '2 of 3 models agree (ECMWF, ICON) at Κέρκυρα: inside your 25 kt wind limit (ECMWF 12 kt, ICON 11 kt), seas from ECMWF WAM. Not an official warning. Forecast data: ECMWF, DWD ICON.',
            ],
        ]);
    });

    it('is not news when the hours now are already inside the limits, or with an official warning in force', () => {
        const now = ahead(windReply({ ecmwf: flat(12), icon: flat(11), ukmo: flat(30) }));
        expect(goodWindowAhead(now, calm, { maxWindKts: 25, maxWaveM: 2 }, NOON, 24).state).toBe('already');
        const d = decideForAccount(
            account('corfu', {}, { goodWindow: true, limits }),
            inputs({ ahead: easing(), sea: calm, seaAnswered: true, official: [nws('Small Craft Advisory', 'SCY')] }),
            NOON,
        );
        expect(d.pushes).toEqual([]);
        expect(d.lines).toEqual(['Good window: not sent while an official wind or sea warning is in force here.']);
    });

    it('is scored by the passage card’s own scorer, moved, not copied', () => {
        const service = readFileSync('services/WeatherWindowService.ts', 'utf8');
        expect(service).toContain("from '../supabase/functions/_shared/forecast-alerts/windowScore'");
        expect(service).toMatch(/scoreDepartureWindow\(/);
        expect(service).not.toMatch(/score -= 50/);
    });

    it('needs the skipper’s wind limit, and says where no wave model could be checked', () => {
        expect(
            decideForAccount(account('corfu', {}, { goodWindow: true }), inputs({ ahead: easing() }), NOON).lines,
        ).toEqual(['Good window: needs a high wind limit.']);
        const d = decideForAccount(
            account('corfu', {}, { goodWindow: true, limits }),
            inputs({ ahead: easing(), sea: null, seaAnswered: true }),
            NOON,
        );
        expect(d.pushes[0].body).toContain('no wave model here, so seas are not checked');
    });
});
