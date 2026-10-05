/**
 * "Keep your distance": numbers only inside Queensland / the Marine Park,
 * read from the official pages (checked 2026-10-05); elsewhere a generic card
 * with the national guidelines link and no number.
 */
import { describe, expect, it } from 'vitest';
import {
    APPROACH_SOURCES,
    QLD_GBR_BOX,
    WHITSUNDAYS_BOX,
    distanceCardFor,
    inBox,
} from '../../services/sightings/approachRules';

// Fictional sighting spots: off Magnetic Island, in Whitsunday Passage,
// off Moreton Bay, and off Sydney.
const MAGNETIC = { lat: -19.13, lon: 146.88 };
const WHITSUNDAY_PASSAGE = { lat: -20.22, lon: 148.93 };
const MORETON = { lat: -27.2, lon: 153.4 };
const SYDNEY = { lat: -33.85, lon: 151.35 };

describe('distance cards', () => {
    it('gives whales the Queensland and Marine Park numbers inside the box', () => {
        const card = distanceCardFor('whale', MAGNETIC.lat, MAGNETIC.lon);
        expect(card?.kind).toBe('rules');
        if (card?.kind !== 'rules') return;
        const rows = card.rows.map((r) => `${r.value} ${r.text}`);
        expect(rows[0]).toBe('100 m Your boat from any whale, and 300 m ahead of it or astern');
        expect(rows).toContain('300 m From a whale calf (Marine Park and Commonwealth waters)');
        expect(rows).toContain('6 kn Top speed within 300 m. Three boats already there: wait outside');
        expect(rows).toContain('100 m No one in or entering the water');
        expect(rows).toContain('500 m From a white humpback such as Migaloo');
        expect(card.rows.find((r) => r.calf)?.value).toBe('300 m');
        expect(card.sources.map((s) => s.url)).toEqual([APPROACH_SOURCES.qld.url, APPROACH_SOURCES.gbrmpa.url]);
        expect(card.footer).toContain('checked 5 Oct 2026');
    });

    it('puts the Whale Protection Area 300 m line first in the Whitsundays, worded conditionally', () => {
        const card = distanceCardFor('whale', WHITSUNDAY_PASSAGE.lat, WHITSUNDAY_PASSAGE.lon);
        expect(card?.kind).toBe('rules');
        if (card?.kind !== 'rules') return;
        expect(card.rows[0]).toEqual({
            value: '300 m',
            text: "From any whale if you're in the Whitsundays Whale Protection Area",
        });
        // Elsewhere in Queensland it is still there, just not first.
        const moreton = distanceCardFor('whale', MORETON.lat, MORETON.lon);
        if (moreton?.kind !== 'rules') throw new Error('expected rules');
        expect(moreton.rows[0].value).toBe('100 m');
        expect(moreton.rows.some((r) => r.text.includes('Whale Protection Area'))).toBe(true);
    });

    it('gives dolphins their own numbers, including bow-riding', () => {
        const card = distanceCardFor('dolphin', MAGNETIC.lat, MAGNETIC.lon);
        if (card?.kind !== 'rules') throw new Error('expected rules');
        expect(card.rows.map((r) => r.value)).toEqual(['50 m', '150 m', '6 kn', '50 m', 'Bow-riding']);
        expect(card.rows[0].text).toBe('Your boat from any dolphin, and 150 m ahead of it or astern');
        expect(card.rows[1].calf).toBe(true);
    });

    it('shows no number outside Queensland, or with no position: check the local rules', () => {
        for (const [lat, lon] of [
            [SYDNEY.lat, SYDNEY.lon],
            [null, null],
        ] as const) {
            const card = distanceCardFor('whale', lat, lon);
            expect(card?.kind).toBe('generic');
            if (card?.kind !== 'generic') continue;
            expect(card.text).not.toMatch(/\d+\s*m\b|\d+\s*kn/);
            expect(card.text).toMatch(/check the local rules/i);
            expect(card.sources[0].url).toBe(APPROACH_SOURCES.national.url);
        }
    });

    it('has no card for dugongs, turtles, birds, sharks, fish or other', () => {
        for (const group of ['dugong', 'turtle', 'seabird', 'shark_ray', 'fish', 'other'] as const) {
            expect(distanceCardFor(group, MAGNETIC.lat, MAGNETIC.lon), group).toBeNull();
        }
    });

    it('cites the official pages, over https, on government domains', () => {
        expect(APPROACH_SOURCES.qld.url).toMatch(/^https:\/\/www\.qld\.gov\.au\//);
        expect(APPROACH_SOURCES.gbrmpa.url).toMatch(/^https:\/\/www\.gbrmpa\.gov\.au\//);
        expect(APPROACH_SOURCES.national.url).toMatch(/^https:\/\/www\.dcceew\.gov\.au\//);
        expect(APPROACH_SOURCES.qld.pageUpdated).toBe('2026-03-05');
        expect(APPROACH_SOURCES.gbrmpa.pageUpdated).toBe('2025-07-31');
    });

    it('keeps the Whitsundays box inside the Queensland box', () => {
        expect(inBox(QLD_GBR_BOX, WHITSUNDAYS_BOX.south, WHITSUNDAYS_BOX.west)).toBe(true);
        expect(inBox(QLD_GBR_BOX, WHITSUNDAYS_BOX.north, WHITSUNDAYS_BOX.east)).toBe(true);
        expect(inBox(QLD_GBR_BOX, Number.NaN, 150)).toBe(false);
    });
});
