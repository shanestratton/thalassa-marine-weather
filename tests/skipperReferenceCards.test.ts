/**
 * Skipper's Reference content integrity — the cards are static authored data folded in from the
 * Passage Weather Pack. This guards against a typo dropping a field or a card, pins the four
 * expected card ids so a rename is a conscious change, and pins the rules a skipper reads to decide
 * whether to go, in both hemispheres (132-B23).
 */
import { describe, it, expect } from 'vitest';
import {
    SKIPPER_REFERENCE_CARDS,
    skipperReferenceCards,
    type Hemisphere,
    type ReferenceCard,
} from '../services/reference/skipperReferenceCards';

const HEMISPHERES: Hemisphere[] = ['south', 'north'];
const IDS = ['grib-60s', 'synoptic', 'forecast-decoder', 'squall-cyclone'];

const card = (hemisphere: Hemisphere, id: string): ReferenceCard => {
    const found = skipperReferenceCards(hemisphere).find((c) => c.id === id);
    if (!found) throw new Error(`${id} is missing in the ${hemisphere}`);
    return found;
};

/** A step's words without the markup, from the worldwide steps or the regional block. */
const step = (hemisphere: Hemisphere, cardId: string, num: string) => {
    const c = card(hemisphere, cardId);
    const found = [...c.steps, ...(c.region?.steps ?? [])].find((s) => s.num === num);
    if (!found) throw new Error(`${cardId} step ${num} is missing in the ${hemisphere}`);
    return found.bodyHtml.replace(/<[^>]+>/g, '');
};

const allWords = (c: ReferenceCard) =>
    [
        c.title,
        c.subtitle,
        ...c.steps.flatMap((s) => [s.heading, s.bodyHtml]),
        ...(c.region?.steps ?? []).flatMap((s) => [s.heading, s.bodyHtml]),
        c.callout.label,
        ...c.callout.items,
        c.pullquote,
        c.sources,
    ].join(' ');

describe('SKIPPER_REFERENCE_CARDS', () => {
    it('carries exactly the four reference cards in both hemispheres', () => {
        for (const hemisphere of HEMISPHERES) {
            expect(skipperReferenceCards(hemisphere).map((c) => c.id)).toEqual(IDS);
        }
        // The plain export is the Southern Hemisphere set the cards always were.
        expect(SKIPPER_REFERENCE_CARDS).toEqual(skipperReferenceCards('south'));
    });

    it('every card has the fields the UI renders, all non-empty', () => {
        for (const hemisphere of HEMISPHERES) {
            for (const c of skipperReferenceCards(hemisphere)) {
                const id = `${hemisphere} ${c.id}`;
                expect(c.emoji, id).toBeTruthy();
                expect(c.title, id).toBeTruthy();
                expect(c.subtitle, id).toBeTruthy();
                expect(c.pullquote, id).toBeTruthy();
                expect(c.sources, id).toBeTruthy();
                expect(c.steps.length, `${id} steps`).toBeGreaterThanOrEqual(6);
                for (const s of [...c.steps, ...(c.region?.steps ?? [])]) {
                    expect(s.num, id).toBeTruthy();
                    expect(s.heading, id).toBeTruthy();
                    expect(s.bodyHtml, id).toBeTruthy();
                }
                expect(c.callout.label, `${id} callout`).toBeTruthy();
                expect(c.callout.items.length, `${id} callout items`).toBeGreaterThanOrEqual(3);
                if (c.region) {
                    expect(c.region.label, `${id} region`).toBeTruthy();
                    expect(c.region.note, `${id} region`).toBeTruthy();
                    expect(c.region.steps.length, `${id} region steps`).toBeGreaterThan(0);
                }
            }
        }
    });

    it('card ids are unique, and so are the step numbers on each card', () => {
        for (const hemisphere of HEMISPHERES) {
            const cards = skipperReferenceCards(hemisphere);
            expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
            for (const c of cards) {
                const nums = [...c.steps, ...(c.region?.steps ?? [])].map((s) => s.num);
                expect(new Set(nums).size, `${hemisphere} ${c.id}`).toBe(nums.length);
            }
        }
    });
});

/**
 * The wording of four rules, pinned (binder audit 2026-10-09, SR-1 and SR-2).
 * Each was wrong in a card that claimed a fact-check, and a skipper reads them
 * to decide whether to go. They must hold in both hemispheres.
 */
describe('the rules the cards teach', () => {
    it('the same isobar spacing blows harder toward the equator, where Coriolis is weaker', () => {
        // Geostrophic wind is the gradient over (density x f), f = 2 Omega sin(latitude):
        // 4 hPa over 300 km is about 9.5 m/s at 50 degrees and 21 m/s at 20 degrees.
        // 126-B1 fixed this rule; neither hemisphere's card may bring the old one back.
        for (const hemisphere of HEMISPHERES) {
            const body = step(hemisphere, 'synoptic', '1');
            expect(body).toContain('harder toward the equator');
            expect(body).not.toContain('nearer the pole');
            expect(body).toMatch(/wide tropical isobars can still mean a fresh trade/);
            // f is zero at the equator: there the isobars stop working.
            expect(body).toMatch(/equator isobars stop working/);
        }
    });

    it('a southern-hemisphere cold front backs the wind; a northern one veers it', () => {
        // NW -> W -> SW -> S is 315 -> 180 degrees: anticlockwise, which the Met
        // Office marine glossary calls backing.
        const south = step('south', 'synoptic', '5');
        expect(south).toMatch(/backs.*\(turns anticlockwise\)/);
        expect(south).not.toContain('clockwise in the SH');
        expect(south).not.toContain('opposite-handed');
        expect(south).toMatch(/NH cold fronts mirror this.*veers \(turns clockwise\)/);
        // Met Office fact sheet 10: the wind veers sharply as a cold front passes.
        const north = step('north', 'synoptic', '5');
        expect(north).toMatch(/Northern Hemisphere it veers \(turns clockwise\)/);
        expect(north).toMatch(/south-west round to the west or north-west/);
        expect(north).toMatch(/SH cold fronts mirror this.*backs \(turns anticlockwise\)/);
    });

    it("'tending' is a change of direction, not a build", () => {
        const body = step('south', 'forecast-decoder', '4');
        expect(body).not.toMatch(/Tending\s*\/\s*freshening/);
        expect(body).toMatch(/Freshening = building/);
        expect(body).toMatch(/tending.*direction/i);
    });

    it("a barb's shaft points to where the wind is coming from", () => {
        const body = step('south', 'grib-60s', '3');
        expect(body).toContain('coming from');
        expect(body).not.toContain('going from');
    });
});

describe('the synoptic and cyclone cards follow the hemisphere (132-B23)', () => {
    it('only the synoptic and cyclone cards change; the other two are the same card in both', () => {
        for (const id of ['grib-60s', 'forecast-decoder']) {
            expect(card('north', id)).toBe(card('south', id));
            expect(card('south', id).hemisphere).toBeUndefined();
        }
        for (const hemisphere of HEMISPHERES) {
            expect(card(hemisphere, 'synoptic').hemisphere).toBe(hemisphere);
            expect(card(hemisphere, 'squall-cyclone').hemisphere).toBe(hemisphere);
        }
        expect(card('south', 'synoptic').subtitle).toMatch(/Southern Hemisphere$/);
        expect(card('north', 'synoptic').subtitle).toMatch(/Northern Hemisphere$/);
    });

    it('turns each way round a low: clockwise in the south, anticlockwise in the north', () => {
        expect(step('south', 'synoptic', '2')).toMatch(/CLOCKWISE around a LOW.*ANTICLOCKWISE around a HIGH/);
        // Met Office, "Wind flow": anticlockwise round a low in the northern hemisphere.
        expect(step('north', 'synoptic', '2')).toMatch(/ANTICLOCKWISE around a LOW.*CLOCKWISE around a HIGH/);
        expect(card('south', 'synoptic').callout.items).toContain(
            'Apply SH spin to get direction (clockwise=low, anticlockwise=high)',
        );
        expect(card('north', 'synoptic').callout.items).toContain(
            'Apply NH spin to get direction (anticlockwise=low, clockwise=high)',
        );
    });

    it('Buys Ballot: back to the wind, the low is on the right in the south and the left in the north', () => {
        expect(step('south', 'synoptic', '3')).toMatch(/SH and the low is on your RIGHT hand/);
        expect(step('north', 'synoptic', '3')).toMatch(/NH and the low is on your LEFT hand/);
    });

    it('friction turns the wind toward the low, with no unsourced angle', () => {
        for (const hemisphere of HEMISPHERES) {
            const body = step(hemisphere, 'synoptic', '2');
            expect(body).toMatch(/inward across the isobars toward the low, less over open water than over land/);
            // The pack's "only a few degrees over open water": 10-25 degrees is nearer the mark.
            expect(body).not.toMatch(/few degrees/);
        }
    });

    it('gives the northern seasons basin by basin, as NOAA states them', () => {
        const body = step('north', 'squall-cyclone', '5');
        expect(body).toMatch(/North Atlantic, Caribbean and Gulf of Mexico: officially 1 June to 30 November/);
        expect(body).toMatch(/Eastern North Pacific: officially 15 May to 30 November/);
        expect(body).toMatch(/North-west Pacific: typhoons in any month, most from July to November/);
        expect(body).toMatch(/North Indian Ocean: two peaks, around May and around November/);
        expect(body).toMatch(/hurricane.*typhoon.*cyclone/);
        expect(step('south', 'squall-cyclone', '5')).toMatch(/South of the equator.*warm half of the year/);
        expect(card('north', 'squall-cyclone').steps.find((s) => s.num === '6')?.heading).toBe(
            'WHAT A HURRICANE HOLE NEEDS',
        );
    });

    it('lists warning centres and chart issuers worldwide, in both hemispheres', () => {
        for (const hemisphere of HEMISPHERES) {
            const cyclone = card(hemisphere, 'squall-cyclone').sources;
            for (const centre of [
                'National Hurricane Center',
                'Central Pacific Hurricane Center',
                'Japan Meteorological Agency',
                'India Meteorological Department',
                'Météo-France La Réunion',
                'BOM',
                'RSMC Nadi',
                'JTWC',
            ]) {
                expect(cyclone, `${hemisphere}: ${centre}`).toContain(centre);
            }
            const synoptic = card(hemisphere, 'synoptic').sources;
            for (const issuer of ['Ocean Prediction Center', 'UK Met Office', 'BOM', 'MetService NZ']) {
                expect(synoptic, `${hemisphere}: ${issuer}`).toContain(issuer);
            }
        }
    });
});

describe('the Australia and New Zealand detail is a labelled regional block (132-B23)', () => {
    const LOCAL = /Australia|Tasman|Coral|southerly|East Coast Low|\bNZ\b|New Zealand|Nadi/;

    it('the southern cards carry it under its label; the worldwide steps name no local water', () => {
        for (const id of ['synoptic', 'squall-cyclone']) {
            const south = card('south', id);
            expect(south.region?.label, id).toBe('Australia & New Zealand');
            for (const s of south.steps) expect(`${s.heading} ${s.bodyHtml}`, `${id} ${s.num}`).not.toMatch(LOCAL);
        }
    });

    it('keeps the southerly change, the squash zone, the East Coast Low and going south', () => {
        const synoptic = card('south', 'synoptic').region!.steps.map((s) => s.heading);
        expect(synoptic).toEqual([
            'FRONTS & THE SOUTHERLY CHANGE',
            'THE SQUASH ZONE',
            'THE EAST COAST LOW — TRUST IT EARLY',
        ]);
        // The southerly change still backs.
        expect(step('south', 'synoptic', '7')).toMatch(
            /NW round through the SW to the S — it backs \(turns anticlockwise\)/,
        );
        expect(step('south', 'synoptic', '8')).toMatch(/Coral and Tasman Seas/);
        expect(step('south', 'squall-cyclone', '8')).toMatch(/south, toward NZ and higher latitudes/);
    });

    it('the northern cards carry none of it', () => {
        for (const id of ['synoptic', 'squall-cyclone']) {
            const north = card('north', id);
            expect(north.region, id).toBeUndefined();
            const words = allWords({ ...north, sources: '' });
            expect(words, id).not.toMatch(LOCAL);
        }
    });
});

describe('the squall card points at the Departure Window (132-B23)', () => {
    it('ties the cyclone veto to the Departure Window, never the removed Go/No-Go card', () => {
        for (const hemisphere of HEMISPHERES) {
            const c = card(hemisphere, 'squall-cyclone');
            const tie = c.steps.find((s) => s.num === '7')!;
            expect(tie.heading).toBe('TIE IT TO THE DEPARTURE WINDOW');
            const body = step(hemisphere, 'squall-cyclone', '7');
            expect(body).toMatch(/Departure Window on the Plan tab/);
            // The page cannot know about a storm: the official warning overrules it.
            expect(body).toMatch(/warning from the official centre for your waters overrules any time it picks/);
            for (const other of skipperReferenceCards(hemisphere)) {
                expect(allWords(other), other.id).not.toMatch(/Go\s*\/\s*No-Go/i);
            }
        }
    });
});
