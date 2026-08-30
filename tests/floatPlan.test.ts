import { describe, expect, it } from 'vitest';
import {
    composeArrivalMessage,
    composeFloatPlan,
    createFloatPlanSharePayload,
    createFloatPlanShareUrl,
    floatPlanCoord,
    validateFloatPlan,
} from '../services/floatPlan';
import type { VesselProfile } from '../types/vessel';

const VESSEL: Partial<VesselProfile> = {
    name: 'Serene Summer',
    type: 'sail',
    model: 'Tayana 55',
    hullType: 'monohull',
    length: 55,
    hullColor: 'white',
    registration: 'MQ258Q',
    mmsi: '501240101',
    callSign: 'VK4AFY',
    epirbHexId: '1D0E7A2B3C4D5E6',
    liferaftCapacity: 6,
    liferaftServiceDate: '2026-03-14',
    flaresExpiry: '2027-06-30',
};

const DEPART = new Date('2026-07-31T22:00:00Z').getTime();
const ETA = DEPART + 30 * 3_600_000;
const OVERDUE = ETA + 4 * 3_600_000;

const base = {
    vessel: VESSEL,
    route: {
        from: 'Newport',
        to: 'Lady Musgrave',
        distanceNM: 178.4,
        waypoints: [
            { lat: -27.14, lon: 153.09 },
            { lat: -23.9, lon: 152.4 },
        ],
    },
    departureMs: DEPART,
    etaMs: ETA,
    overdueMs: OVERDUE,
    personsOnBoard: 3,
    whoToCall: 'Marine Rescue Bundaberg — 07 4159 4600',
    timeZone: 'Australia/Brisbane',
};

describe('composeFloatPlan', () => {
    it('leads with the vessel and carries its identifying marks', () => {
        const plan = composeFloatPlan(base);
        expect(plan.startsWith('FLOAT PLAN — Serene Summer')).toBe(true);
        expect(plan).toContain('Tayana 55');
        expect(plan).toContain('Rego MQ258Q');
        expect(plan).toContain('MMSI 501240101');
        expect(plan).toContain('Call sign VK4AFY');
        expect(plan).toContain('white hull');
    });

    it('always carries the overdue block — that is the point of the document', () => {
        const plan = composeFloatPlan(base);
        expect(plan).toContain('IF YOU HAVE NOT HEARD FROM US');
        expect(plan).toContain('Marine Rescue Bundaberg');
    });

    it('marks the rescue instruction as incomplete when no number is given', () => {
        const plan = composeFloatPlan({ ...base, whoToCall: undefined });
        expect(plan).toContain('IF YOU HAVE NOT HEARD FROM US');
        expect(plan).toContain('NOT SET — add a jurisdiction-specific rescue phone number before sharing');
        expect(plan).not.toContain('your local marine rescue or water police');
    });

    it('carries the SAR gear a coordinator actually asks for', () => {
        const plan = composeFloatPlan(base);
        expect(plan).toContain('EPIRB hex 1D0E7A2B3C4D5E6');
        expect(plan).toContain('Liferaft 6 person, serviced 2026-03-14');
        expect(plan).toContain('Flares expire 2027-06-30');
        expect(plan).toContain('3 on board');
    });

    it('omits whole sections rather than printing empty headings', () => {
        // A half-filled profile must not produce a document littered with
        // blank SAFETY/PEOPLE headings — it reads as though data was lost.
        const plan = composeFloatPlan({
            vessel: { name: 'Tinny', type: 'power' },
            route: {},
            departureMs: DEPART,
            overdueMs: OVERDUE,
        });
        expect(plan).not.toContain('SAFETY');
        expect(plan).not.toContain('PEOPLE');
        expect(plan).not.toContain('INTENDED TRACK');
        // But the alarm block survives a bare profile.
        expect(plan).toContain('IF YOU HAVE NOT HEARD FROM US');
    });

    it('lists the intended track in degrees + decimal minutes with end tags', () => {
        const plan = composeFloatPlan(base);
        expect(plan).toContain('INTENDED TRACK');
        // 27.14° = 27°08.4'; marine radio speaks deg + decimal minutes.
        expect(plan).toContain("1. 27°08.4'S 153°05.4'E (depart)");
        expect(plan).toContain("2. 23°54.0'S 152°24.0'E (destination)");
    });

    it('puts the overdue block first — before vessel paint colour', () => {
        const plan = composeFloatPlan(base);
        expect(plan.indexOf('IF YOU HAVE NOT HEARD FROM US')).toBeLessThan(plan.indexOf('VESSEL'));
    });

    it('thins a dense track to departure, major turns, and destination', () => {
        // A 20-point rhumb line with ONE real 90° dogleg: the wall of
        // coordinates collapses to the three positions that matter.
        const leg1 = Array.from({ length: 10 }, (_, i) => ({ lat: -27 - i * 0.05, lon: 153 }));
        const leg2 = Array.from({ length: 10 }, (_, i) => ({ lat: -27.45, lon: 153.05 + i * 0.05 }));
        const plan = composeFloatPlan({ ...base, route: { ...base.route, waypoints: [...leg1, ...leg2] } });
        const trackLines = plan.split('\n').filter((l) => /^\s+\d+\./.test(l));
        expect(trackLines.length).toBeLessThanOrEqual(12);
        expect(plan).toContain('(depart)');
        expect(plan).toContain('(destination)');
        expect(plan).toContain('full route is aboard');
        // The dogleg corner survives thinning.
        expect(plan).toContain("27°27.0'S 153°00.0'E");
    });

    it('computes passage distance from the waypoints when not supplied', () => {
        const plan = composeFloatPlan({
            ...base,
            route: { ...base.route, distanceNM: undefined },
        });
        // 27.14S,153.09E → 23.90S,152.40E ≈ 197 NM great-circle.
        expect(plan).toMatch(/Distance: 19[0-9] NM/);
    });

    it('an explicitly supplied distance wins over the computed one', () => {
        const plan = composeFloatPlan(base);
        expect(plan).toContain('Distance: 178 NM');
    });

    it('carries free-text safety notes into the SAFETY section', () => {
        const plan = composeFloatPlan({
            ...base,
            vessel: { ...base.vessel, safetyNotes: 'PLB ×2, drogue, grab bag' },
        });
        expect(plan).toContain('PLB ×2, drogue, grab bag');
    });

    it('never leaves a dangling separator when identity fields are missing', () => {
        const plan = composeFloatPlan({
            ...base,
            vessel: { name: 'Serene Summer', type: 'sail', mmsi: '501240101' },
        });
        expect(plan).toContain('MMSI 501240101');
        expect(plan).not.toMatch(/·\s*·/);
        expect(plan).not.toMatch(/·\s*$/m);
    });

    it('handles an unnamed vessel without printing "undefined"', () => {
        const plan = composeFloatPlan({ ...base, vessel: null });
        expect(plan).toContain('FLOAT PLAN — Unnamed vessel');
        expect(plan).not.toContain('undefined');
    });

    it('says "not set" rather than printing an invalid date', () => {
        const plan = composeFloatPlan({ ...base, departureMs: Number.NaN, overdueMs: Number.NaN });
        expect(plan).toContain('Depart: not set');
        expect(plan).not.toContain('Invalid Date');
    });
});

describe('channel-specific float plans', () => {
    it('keeps the safety-critical facts in every format', () => {
        const payloads = (['sms', 'whatsapp', 'email', 'generic'] as const).map((channel) =>
            createFloatPlanSharePayload(base, channel),
        );

        for (const payload of payloads) {
            expect(payload.text).toContain('Serene Summer');
            expect(payload.text).toContain('Newport');
            expect(payload.text).toContain('Lady Musgrave');
            expect(payload.text).toContain('Marine Rescue Bundaberg');
            expect(payload.text).toContain('501240101');
            expect(payload.text).toContain('1D0E7A2B3C4D5E6');
            expect(payload.text).toMatch(/3|POB/);
            expect(payload.text).toContain('RECEIVED');
            expect(
                payload.text.indexOf('OVERDUE') >= 0 ||
                    payload.text.indexOf('RAISE THE ALARM') >= 0 ||
                    payload.text.indexOf('IF YOU HAVE NOT HEARD') >= 0,
            ).toBe(true);
        }
    });

    it('uses audience-neutral privacy wording for the generic share payload', () => {
        const generic = createFloatPlanSharePayload(base, 'generic');
        expect(generic.text).toContain('Thalassa does not upload this plan');
        expect(generic.text).toContain('Verify the recipients and audience in the destination app');
        expect(generic.text).not.toContain('Sent privately');
        expect(generic.text).not.toContain('Nothing is posted publicly');
    });

    it('makes SMS compact, ASCII-safe and reports multipart length', () => {
        const sms = createFloatPlanSharePayload(base, 'sms');
        expect([...sms.text].every((character) => (character.codePointAt(0) ?? 0x80) <= 0x7f)).toBe(true);
        expect(sms.text).toContain('OVERDUE:');
        expect(sms.text).toContain('27 08.4S 153 05.4E');
        expect(sms.text).not.toContain('🛟');
        expect(sms.smsSegments).toBeGreaterThan(1);
    });

    it('uses WhatsApp emphasis without letting user text create markup', () => {
        const whatsapp = createFloatPlanSharePayload(
            {
                ...base,
                vessel: { ...VESSEL, name: 'Sea*Star_\\One\nTwo' },
                route: { ...base.route, from: '~Home~', to: '`Harbour`' },
            },
            'whatsapp',
        );
        expect(whatsapp.text).toContain('🚨 *RAISE THE ALARM*');
        expect(whatsapp.text).toContain('Sea\\*Star\\_\\\\One Two');
        expect(whatsapp.text).toContain('\\~Home\\~');
        expect(whatsapp.text).toContain('\\`Harbour\\`');
    });

    it('creates a useful email subject and explicit timezone', () => {
        const email = createFloatPlanSharePayload(base, 'email');
        expect(email.subject).toBe('Float plan | Serene Summer | Newport to Lady Musgrave');
        expect(email.text).toContain('AEST (UTC+10)');
        expect(email.text).toContain('PERSONS ONBOARD');
        expect(email.text).toContain('INTENDED TRACK');
    });

    it('builds channel launch URLs with the right encoded payload', () => {
        const email = createFloatPlanSharePayload(base, 'email');
        const sms = createFloatPlanSharePayload(base, 'sms');
        const whatsapp = createFloatPlanSharePayload(base, 'whatsapp');
        expect(createFloatPlanShareUrl(email)).toContain('mailto:?subject=Float%20plan');
        expect(createFloatPlanShareUrl(sms, 'ios')).toContain('sms:&body=');
        expect(createFloatPlanShareUrl(sms, 'android')).toContain('sms:?body=');
        expect(createFloatPlanShareUrl(whatsapp)).toContain('https://wa.me/?text=');
    });

    it('blocks invalid safety handoffs before sharing', () => {
        expect(validateFloatPlan(base, DEPART - 3_600_000).errors).toEqual([]);
        const invalid = validateFloatPlan(
            {
                ...base,
                route: { ...base.route, to: '' },
                overdueMs: ETA,
                personsOnBoard: 0,
            },
            DEPART,
        );
        expect(invalid.errors).toContain('Add a destination.');
        expect(invalid.errors).toContain('The overdue time must be after the ETA.');
        expect(invalid.errors).toContain('Set the number of people aboard.');

        const unnamed = validateFloatPlan({ ...base, vessel: { ...base.vessel!, name: '  ' } }, DEPART);
        expect(unnamed.errors).toContain('Add the vessel name before sharing.');
    });

    it('requires an actionable jurisdiction-specific rescue number', () => {
        const missing = validateFloatPlan({ ...base, whoToCall: undefined }, DEPART);
        const placeOnly = validateFloatPlan({ ...base, whoToCall: 'local marine rescue or water police' }, DEPART);
        const emergencyNumber = validateFloatPlan({ ...base, whoToCall: 'Call 000 and ask for Water Police' }, DEPART);

        for (const result of [missing, placeOnly]) {
            expect(result.errors).toContain(
                'Add the jurisdiction-specific rescue contact and phone number your shore contact must call if you are overdue.',
            );
        }
        expect(emergencyNumber.errors).not.toContain(
            'Add the jurisdiction-specific rescue contact and phone number your shore contact must call if you are overdue.',
        );
    });
});

describe('floatPlanCoord', () => {
    it('uses degrees + decimal minutes with hemispheres, not signed decimals', () => {
        expect(floatPlanCoord({ lat: -27.142, lon: 153.093 })).toBe("27°08.5'S 153°05.6'E");
        expect(floatPlanCoord({ lat: 41.5, lon: -71.31 })).toBe("41°30.0'N 71°18.6'W");
    });
});

describe('composeArrivalMessage', () => {
    it('stands the shore contact down explicitly', () => {
        // "We're in" is ambiguous at 0200. "Stand down" is not.
        const msg = composeArrivalMessage({
            vesselName: 'Serene Summer',
            destination: 'Lady Musgrave',
            arrivedMs: ETA,
        });
        expect(msg).toContain('Serene Summer arrived safely at Lady Musgrave');
        expect(msg).toContain('Stand down');
    });

    it('still reads correctly with no destination or name', () => {
        const msg = composeArrivalMessage({ arrivedMs: ETA });
        expect(msg).toContain('We arrived safely');
        expect(msg).not.toContain('undefined');
        expect(msg).not.toContain(' at ,');
    });
});

describe('USCG-style restructure (2026-08-26)', () => {
    const SAR_VESSEL = {
        ...VESSEL,
        hailingPort: 'Newport, QLD',
        hullMaterial: 'fibreglass',
        trimColor: 'blue',
        prominentFeatures: 'hard dodger, wind generator, tan sail covers',
        radiosMonitored: 'VHF 16 + 67; HF 8291',
        satPhone: '+870 7731 12345',
        tenderDescription: 'grey 2.6 m RIB, 5 hp outboard',
        draft: 6.2,
        fuelCapacity: 200,
        waterCapacity: 400,
        cruisingSpeed: 6,
    };
    const roster = [
        { name: 'Shane Stratton', note: 'skipper' },
        { name: 'K. Stratton', note: 'crew' },
        { name: '   ', note: 'ignored — blank name' },
    ];
    const sarInput = { ...base, vessel: SAR_VESSEL, personsOnBoard: 2, personsRoster: roster, provisionsDays: 12 };

    it('carries the USCG identification set a search aircraft uses', () => {
        const plan = composeFloatPlan(sarInput);
        expect(plan).toContain('Hailing port Newport, QLD');
        expect(plan).toContain('fibreglass');
        expect(plan).toContain('6.2 ft draft');
        expect(plan).toContain('blue trim');
        expect(plan).toContain('Look for: hard dodger, wind generator, tan sail covers');
        expect(plan).toContain('Radios: VHF 16 + 67; HF 8291');
        expect(plan).toContain('Sat phone +870 7731 12345');
        expect(plan).toContain('Fuel 200 L · water 400 L · cruise 6 kn');
    });

    it('SAFETY & SURVIVAL carries tender and provisions endurance', () => {
        const plan = composeFloatPlan(sarInput);
        expect(plan).toContain('SAFETY & SURVIVAL');
        expect(plan).toContain('Tender: grey 2.6 m RIB, 5 hp outboard');
        expect(plan).toContain('Provisions ~12 days');
    });

    it('PERSONS ONBOARD lists the roster with blank names dropped, in every rich format', () => {
        for (const channel of ['generic', 'email', 'whatsapp'] as const) {
            const text = createFloatPlanSharePayload(sarInput, channel).text;
            expect(text).toContain('1. Shane Stratton — skipper');
            expect(text).toContain('2. K. Stratton — crew');
            expect(text).not.toContain('ignored');
        }
    });

    it('SMS stays compact — the roster and SAR detail never inflate the segment count', () => {
        const withRoster = createFloatPlanSharePayload(sarInput, 'sms');
        expect(withRoster.text).not.toContain('Shane Stratton');
        expect(withRoster.text).not.toContain('Look for');
        expect(withRoster.text).not.toContain('Provisions');
    });

    it('a roster that disagrees with the persons count warns before sharing', () => {
        const validation = validateFloatPlan({ ...sarInput, personsOnBoard: 3 });
        expect(validation.warnings.some((w) => w.includes('roster lists 2 names but persons on board is 3'))).toBe(
            true,
        );
        expect(validateFloatPlan(sarInput).warnings.some((w) => w.includes('roster'))).toBe(false);
    });

    it('vessels without the SAR fields render exactly as before — no empty labels', () => {
        const plan = composeFloatPlan(base);
        expect(plan).not.toContain('Hailing port');
        expect(plan).not.toContain('Look for:');
        expect(plan).not.toContain('Radios:');
        expect(plan).not.toContain('Tender:');
        expect(plan).not.toContain('undefined');
    });
});

describe('advanced boat details stay optional (source tripwires)', () => {
    it('the SAR fields live in a COLLAPSED details group — punters are never confronted with them', () => {
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        const { resolve } = require('node:path') as typeof import('node:path');
        const tab = readFileSync(resolve(process.cwd(), 'components/settings/VesselTab.tsx'), 'utf8');
        const detailsAt = tab.indexOf('Advanced Boat Details');
        expect(detailsAt).toBeGreaterThan(-1);
        // Inside a <details> WITHOUT an `open` attribute, and labelled optional.
        const block = tab.slice(tab.lastIndexOf('<details', detailsAt), detailsAt);
        expect(block).toContain('<details');
        expect(block).not.toContain('open');
        expect(tab).toContain('Optional · prefills your float plan');
        // Every SAR field sits inside the collapsed group.
        for (const field of ['hailingPort', 'hullMaterial', 'trimColor', 'prominentFeatures', 'radiosMonitored']) {
            expect(tab.indexOf(field)).toBeGreaterThan(detailsAt);
        }
    });
});

describe('persons onboard roster', () => {
    const base = {
        vessel: { name: 'Serene Summer', type: 'sail' },
        route: { from: 'Newport, QLD', to: 'Mooloolaba', waypoints: [] },
        departureMs: 1788000000000,
        overdueMs: 1788000000000 + 12 * 3600e3,
        whoToCall: 'Marine Rescue Redcliffe — 07 3203 5522',
        timeZone: 'Australia/Brisbane',
    };

    const brief = (roster: unknown) =>
        createFloatPlanSharePayload({ ...base, personsRoster: roster } as never, 'email').text;

    it('composes role, age and medical into one readable line', () => {
        // A coordinator deciding what to send reads "Skipper, 62, on warfarin"
        // very differently from a bare name.
        const text = brief([{ name: 'Shane Stratton', role: 'Skipper', age: 62, medical: 'on warfarin' }]);
        expect(text).toContain('1. Shane Stratton — Skipper, 62, on warfarin');
    });

    it('omits the parts that were left blank', () => {
        const text = brief([{ name: 'Jane Stratton', role: 'First mate' }]);
        expect(text).toContain('1. Jane Stratton — First mate');
        expect(text).not.toMatch(/Jane Stratton — First mate,\s*,/);
    });

    it('still renders plans saved before role and age were separate fields', () => {
        // Old plans carry one free-text note. They must not silently lose it.
        const text = brief([{ name: 'Old Entry', note: 'Deckhand · 24 · asthma' }]);
        expect(text).toContain('1. Old Entry — Deckhand · 24 · asthma');
    });

    it('drops an age of zero rather than printing it', () => {
        // An untouched number input reads as 0, and "Cook, 0" is worse than "Cook".
        const text = brief([{ name: 'No Age', role: 'Cook', age: 0 }]);
        expect(text).toContain('1. No Age — Cook');
        expect(text).not.toContain('Cook, 0');
    });

    it('ignores rows with no name at all', () => {
        const text = brief([{ name: '   ', role: 'Crew', age: 30 }, { name: 'Real Person' }]);
        expect(text).toContain('1. Real Person');
        expect(text).not.toContain('Crew, 30');
    });
});
