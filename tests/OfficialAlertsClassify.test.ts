/**
 * What kind of official warning this is (129-06), read from each issuer's own
 * vocabulary: NWS VTEC and event codes (and its Spanish names from San Juan),
 * ECCC's CAP-CP event codes, CAP's Geo category for a tsunami anywhere,
 * MeteoAlarm's awareness types and JMA's warning names. It decides what may
 * push at the boat (marine and coastal only; land types stay in the app),
 * what goes at once (Severe, Extreme, a marine or coastal warning, a tsunami
 * always as Extreme) and what is an advisory that can wait out quiet hours.
 * An event nobody recognises is never pushed, and is still shown in the app.
 */
import { describe, expect, it } from 'vitest';
import {
    classifyOfficialEvent,
    officialPushClass,
    type ClassifiableInfo,
} from '../supabase/functions/_shared/official-alerts/classify';

const nwsCode = (code: string) => [
    { valueName: 'SAME', value: 'NWS' },
    { valueName: 'NationalWeatherService', value: code },
];
const vtec = (phen: string, sig: string) => [
    { valueName: 'VTEC', value: `/O.NEW.KZZZ.${phen}.${sig}.0042.261014T1105Z-261014T1245Z/` },
];
const cappCp = (value: string) => [{ valueName: 'profile:CAP-CP:Event:0.4', value }];

const push = (provider: string, info: ClassifiableInfo, severity: string, zones?: string[]) =>
    officialPushClass(classifyOfficialEvent(provider, info, zones), severity);

describe('NWS', () => {
    it('reads the NWS event code: a Small Craft Advisory is a marine advisory on wind and seas', () => {
        const c = classifyOfficialEvent('nws', { event: 'Small Craft Advisory', eventCodes: nwsCode('SCY') });
        expect(c).toMatchObject({ domain: 'marine', significance: 'Y', tsunami: false });
        expect(c.hazards).toEqual(
            expect.arrayContaining([
                ['wind', 1],
                ['sea', 1],
            ]),
        );
        expect(push('nws', { event: 'Small Craft Advisory', eventCodes: nwsCode('SCY') }, 'Minor')).toEqual({
            push: true,
            urgent: false,
            severity: 'Minor',
        });
    });

    it('a gale warning goes at once whatever severity the feed gave it', () => {
        const info = { event: 'Gale Warning', parameters: vtec('GL', 'W') };
        expect(classifyOfficialEvent('nws', info)).toMatchObject({ domain: 'marine', significance: 'W' });
        expect(push('nws', info, 'Moderate')).toEqual({ push: true, urgent: true, severity: 'Severe' });
        expect(push('nws', info, 'Extreme')).toEqual({ push: true, urgent: true, severity: 'Extreme' });
    });

    it('a Special Marine Warning (SMW) is a marine warning on thunderstorms and wind', () => {
        const info = { event: 'Special Marine Warning', eventCodes: [{ valueName: 'SAME', value: 'SMW' }] };
        const c = classifyOfficialEvent('nws', info);
        expect(c).toMatchObject({ domain: 'marine', significance: 'W' });
        expect(c.hazards).toEqual(expect.arrayContaining([['thunderstorm', 2]]));
        expect(push('nws', info, 'Moderate')).toMatchObject({ push: true, urgent: true });
    });

    it('falls back on the English name, keeping storm, tropical storm and winter storm apart', () => {
        expect(classifyOfficialEvent('nws', { event: 'Storm Warning' })).toMatchObject({
            domain: 'marine',
            significance: 'W',
            hazards: [['wind', 3]],
        });
        expect(classifyOfficialEvent('nws', { event: 'Hurricane Force Wind Warning' }).hazards).toEqual([['wind', 4]]);
        expect(classifyOfficialEvent('nws', { event: 'Tropical Storm Warning' })).toMatchObject({
            domain: 'coastal',
            significance: 'W',
        });
        expect(classifyOfficialEvent('nws', { event: 'Winter Storm Warning' }).domain).toBe('land');
        expect(classifyOfficialEvent('nws', { event: 'Heavy Freezing Spray Warning' })).toMatchObject({
            domain: 'marine',
            hazards: [['cold', 2]],
        });
        expect(classifyOfficialEvent('nws', { event: 'Gale Watch' }).significance).toBe('A');
    });

    it('reads NWS San Juan’s Spanish names', () => {
        expect(classifyOfficialEvent('nws', { event: 'Advertencia para Embarcaciones Pequeñas' })).toMatchObject({
            domain: 'marine',
            significance: 'Y',
        });
        expect(classifyOfficialEvent('nws', { event: 'Aviso de Huracán' })).toMatchObject({
            domain: 'coastal',
            significance: 'W',
        });
        expect(classifyOfficialEvent('nws', { event: 'Vigilancia de Tormenta Tropical' }).significance).toBe('A');
    });

    it('tells a marine Dense Fog Advisory from a land one by its code, else by its zones', () => {
        expect(classifyOfficialEvent('nws', { event: 'Dense Fog Advisory', eventCodes: nwsCode('MFY') }).domain).toBe(
            'marine',
        );
        expect(classifyOfficialEvent('nws', { event: 'Dense Fog Advisory', eventCodes: nwsCode('FGY') }).domain).toBe(
            'land',
        );
        expect(classifyOfficialEvent('nws', { event: 'Dense Fog Advisory' }, ['nws:forecast:ANZ531']).domain).toBe(
            'marine',
        );
        expect(classifyOfficialEvent('nws', { event: 'Dense Fog Advisory' }, ['nws:forecast:MDZ014']).domain).toBe(
            'land',
        );
    });

    it('dense smoke and ashfall on land stay in the app; at sea (MS, MH or a marine zone) they push', () => {
        // Land: by the VTEC phenomenon (SM, AF), by the NWS code (SMY, AFW), else by a land zone.
        const smokeLand = { event: 'Dense Smoke Advisory', parameters: vtec('SM', 'Y') };
        expect(classifyOfficialEvent('nws', smokeLand, ['nws:forecast:LAZ054'])).toMatchObject({ domain: 'land' });
        expect(push('nws', smokeLand, 'Minor', ['nws:forecast:LAZ054']).push).toBe(false);
        expect(push('nws', { event: 'Dense Smoke Advisory', eventCodes: nwsCode('SMY') }, 'Minor').push).toBe(false);
        expect(push('nws', { event: 'Dense Smoke Advisory' }, 'Minor', ['nws:forecast:LAZ054']).push).toBe(false);
        const ashLand = { event: 'Ashfall Warning', parameters: vtec('AF', 'W') };
        expect(classifyOfficialEvent('nws', ashLand, ['nws:forecast:AKZ101'])).toMatchObject({ domain: 'land' });
        expect(push('nws', ashLand, 'Severe', ['nws:forecast:AKZ101']).push).toBe(false);
        expect(push('nws', { event: 'Ashfall Warning' }, 'Severe', ['nws:forecast:AKZ101']).push).toBe(false);
        // At sea: Marine Dense Smoke (MS) and Marine Ashfall (MH), or the name over a marine zone.
        expect(push('nws', { event: 'Dense Smoke Advisory', parameters: vtec('MS', 'Y') }, 'Minor')).toEqual({
            push: true,
            urgent: false,
            severity: 'Minor',
        });
        expect(classifyOfficialEvent('nws', { event: 'Dense Smoke Advisory' }, ['nws:forecast:GMZ532']).domain).toBe(
            'marine',
        );
        expect(push('nws', { event: 'Ashfall Advisory' }, 'Moderate', ['nws:forecast:PKZ170'])).toMatchObject({
            push: true,
            urgent: false,
        });
    });

    it('a tsunami is always Extreme, even when the feed says Moderate', () => {
        const warning = { event: 'Tsunami Warning', category: ['Geo'], eventCodes: nwsCode('TSW') };
        expect(push('nws', warning, 'Moderate')).toEqual({ push: true, urgent: true, severity: 'Extreme' });
        expect(push('nws', { event: 'Tsunami Advisory' }, 'Minor')).toEqual({
            push: true,
            urgent: true,
            severity: 'Extreme',
        });
    });

    it('statements, land types and unknown events are never pushed', () => {
        expect(push('nws', { event: 'Marine Weather Statement', eventCodes: nwsCode('MWS') }, 'Moderate').push).toBe(
            false,
        );
        expect(push('nws', { event: 'Rip Current Statement' }, 'Moderate').push).toBe(false);
        expect(push('nws', { event: 'Tornado Warning', parameters: vtec('TO', 'W') }, 'Extreme').push).toBe(false);
        expect(classifyOfficialEvent('nws', { event: 'Zz Fictional Notice' }).domain).toBe('unknown');
        expect(push('nws', { event: 'Zz Fictional Notice' }, 'Extreme').push).toBe(false);
    });
});

describe('Environment and Climate Change Canada (CAP-CP)', () => {
    it('reads the CAP-CP event code, in either language block', () => {
        const fr = {
            event: 'coup de vent',
            headline: 'avertissement de coup de vent en vigueur',
            eventCodes: cappCp('gale'),
        };
        const en = { event: 'gale', headline: 'gale warning in effect', eventCodes: cappCp('gale') };
        for (const info of [fr, en]) {
            expect(classifyOfficialEvent('eccc', info)).toMatchObject({ domain: 'marine', significance: 'W' });
            expect(push('eccc', info, 'Moderate')).toEqual({ push: true, urgent: true, severity: 'Severe' });
        }
        expect(classifyOfficialEvent('eccc', { event: 'squall', eventCodes: cappCp('squall') }).domain).toBe('marine');
        expect(
            classifyOfficialEvent('eccc', { event: 'hurricane force wind', eventCodes: cappCp('hurricFrcWnd') })
                .hazards,
        ).toEqual([['wind', 4]]);
    });

    it('a land wind or fog warning stays in the app; a tsunami is Extreme; an unknown code is unknown', () => {
        expect(push('eccc', { event: 'wind', eventCodes: cappCp('wind') }, 'Severe').push).toBe(false);
        expect(push('eccc', { event: 'fog', eventCodes: cappCp('fog') }, 'Moderate').push).toBe(false);
        expect(push('eccc', { event: 'tsunami', eventCodes: cappCp('tsunami') }, 'Minor')).toEqual({
            push: true,
            urgent: true,
            severity: 'Extreme',
        });
        expect(classifyOfficialEvent('eccc', { event: 'zz', eventCodes: cappCp('zzUnknown') }).domain).toBe('unknown');
    });

    it('a watch or an advisory is not lifted to a warning', () => {
        const watch = { event: 'gale', headline: 'gale watch in effect', eventCodes: cappCp('gale') };
        expect(classifyOfficialEvent('eccc', watch).significance).toBe('A');
        expect(push('eccc', watch, 'Moderate')).toEqual({ push: true, urgent: false, severity: 'Moderate' });
    });
});

describe('any CAP issuer', () => {
    it('a CAP Geo tsunami is pushed as Extreme in any language', () => {
        for (const event of ['Tsunami Warning', 'تحذير من تسونامي', '津波警報', 'Προειδοποίηση για τσουνάμι']) {
            const c = classifyOfficialEvent('fictional-cap', { event, category: ['Geo'] });
            expect(c, event).toMatchObject({ domain: 'coastal', tsunami: true });
            expect(officialPushClass(c, 'Minor'), event).toEqual({ push: true, urgent: true, severity: 'Extreme' });
        }
    });

    it('an earthquake, or a Geo event it cannot name, is not pushed', () => {
        expect(push('fictional-cap', { event: 'Earthquake', category: ['Geo'] }, 'Severe').push).toBe(false);
        expect(push('fictional-cap', { event: 'Zz', category: ['Met'] }, 'Extreme').push).toBe(false);
    });

    it('MeteoAlarm: a coastal event is coastal, wind and fog are land', () => {
        const at = (value: string) => [{ valueName: 'awareness_type', value }];
        expect(
            classifyOfficialEvent('meteoalarm-gr', { event: 'Κίνδυνος στις ακτές', parameters: at('7; coastalevent') })
                .domain,
        ).toBe('coastal');
        expect(
            classifyOfficialEvent('meteoalarm-fr', { event: 'Vent violent', parameters: at('1; Wind') }).domain,
        ).toBe('land');
        expect(classifyOfficialEvent('meteoalarm-de', { event: 'NEBEL', parameters: at('4; fog') }).domain).toBe(
            'land',
        );
    });

    it('JMA: 海上 warnings are marine, 津波 is a tsunami, 大雨 stays on land (for when its flag is on)', () => {
        expect(classifyOfficialEvent('jma', { event: '海上強風警報' })).toMatchObject({
            domain: 'marine',
            significance: 'W',
            hazards: [['wind', 2]],
        });
        expect(classifyOfficialEvent('jma', { event: '海上濃霧警報' }).hazards).toEqual([['fog', 2]]);
        expect(classifyOfficialEvent('jma', { event: '津波警報' }).tsunami).toBe(true);
        expect(classifyOfficialEvent('jma', { event: '大雨警報' }).domain).toBe('land');
    });
});
