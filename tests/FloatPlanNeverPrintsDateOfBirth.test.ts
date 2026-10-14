/**
 * Every channel the float plan goes out on prints the AGE and never the date
 * of birth (129-14): the text, SMS, WhatsApp, email and the PDF made from the
 * email brief. The vessel profile handed to the plan carries the dates of
 * birth (crewRoster), so this proves nothing reads them out of it either.
 *
 * Built the way the sheet builds it: the profile's people and the crew list's
 * seeds merged, each aged on the departure day. Fictional people only; one
 * name in Greek and one in Japanese, as skippers type them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import { composeFloatPlan, createFloatPlanSharePayload, type FloatPlanInput } from '../services/floatPlan';
import { __testing } from '../services/floatPlanPdf';
import {
    mergeProfileWithCrew,
    rosterSeedsFromVesselProfile,
    type FloatPlanRosterSeed,
} from '../services/floatPlanCrew';
import { PdfTextWriter } from '../services/pdf/pdfText';
import { installFakeCanvas, pageLines, readPages } from './helpers/jspdfPages';
import { standardFloatPlan } from './helpers/pdfFixtures';

const DEPARTURE_DAY = '2026-10-15';
const BIRTH_DATES = ['1979-10-15', '1985-10-17', '1992-02-29'];

const vessel = {
    ...standardFloatPlan().vessel,
    crewCount: 3,
    crewRoster: [
        { name: 'Ingrid Solberg', rank: 'Skipper', dateOfBirth: '1979-10-15' },
        { name: 'Ελένη Παππά', rank: 'First mate', age: 52 },
        { name: '渡辺 健二', rank: 'Crew', dateOfBirth: '1985-10-17' },
    ],
};
const crewList: FloatPlanRosterSeed[] = [
    { name: 'Ingrid Solberg', role: 'Skipper', source: 'skipper', crewUserId: 'owner-1' },
    {
        name: 'Thomas Okafor',
        role: 'Deckhand',
        source: 'crew',
        crewUserId: 'u-tom',
        // The loader's work: the date of birth 1992-02-29, aged on 15 October 2026.
        shared: { name: 'Thomas Okafor', phone: '0400 000 002', age: 34, appName: 'Tom' },
    },
];

function plan(): FloatPlanInput {
    const people = mergeProfileWithCrew(rosterSeedsFromVesselProfile(vessel, DEPARTURE_DAY), crewList);
    return {
        ...standardFloatPlan(),
        vessel,
        personsOnBoard: people.length,
        personsRoster: people.map((person) => ({
            name: person.name,
            role: person.role,
            age: person.age ?? undefined,
            phone: person.phone ?? undefined,
        })),
    };
}

/** Any way a date of birth could be written: ISO, day first, month first, in words, the year alone. */
function expectNoBirthDate(text: string) {
    for (const iso of BIRTH_DATES) {
        const [year, month, day] = iso.split('-');
        for (const form of [
            iso,
            `${day}/${month}/${year}`,
            `${month}/${day}/${year}`,
            `${day}.${month}.${year}`,
            year,
        ]) {
            expect(text, form).not.toContain(form);
        }
    }
    expect(text).not.toMatch(/\b(?:born|date of birth|DOB)\b/i);
}

let canvas: ReturnType<typeof installFakeCanvas>;
beforeEach(() => {
    canvas = installFakeCanvas();
});
afterEach(() => {
    canvas.restore();
    vi.restoreAllMocks();
});

describe('the float plan prints age, never a date of birth', () => {
    it('ages everyone on the departure day', () => {
        expect(plan().personsRoster!.map((person) => [person.name, person.age])).toEqual([
            ['Ingrid Solberg', 47],
            ['Ελένη Παππά', 52],
            ['Thomas Okafor', 34],
            ['渡辺 健二', 40],
        ]);
    });

    for (const channel of ['whatsapp', 'email', 'generic'] as const) {
        it(`${channel}: the ages, and no date of birth`, () => {
            const text = createFloatPlanSharePayload(plan(), channel).text;
            for (const line of ['Ingrid Solberg — Skipper, 47', 'Ελένη Παππά — First mate, 52', '渡辺 健二 — Crew, 40'])
                expect(text).toContain(line);
            expect(text).toContain('Thomas Okafor — Deckhand, 34');
            expectNoBirthDate(text);
        });
    }

    it('sms: the count aboard (an SMS carries no roster), and no date of birth', () => {
        const text = createFloatPlanSharePayload(plan(), 'sms').text;
        expect(text).toContain('POB: 4');
        expectNoBirthDate(text);
    });

    it('the plain text brief: the ages, and no date of birth', () => {
        const text = composeFloatPlan(plan());
        expect(text).toContain('Ingrid Solberg — Skipper, 47');
        expect(text).toContain('渡辺 健二 — Crew, 40');
        expectNoBirthDate(text);
    });

    it('the PDF: every page it prints, and every line it lays out', () => {
        const draw = vi.spyOn(PdfTextWriter.prototype, 'draw');
        const { doc } = __testing.buildFloatPlanPdf(plan(), jsPDF);
        const drawn = draw.mock.calls.map((call) => call[0] as string).join('\n');
        const printed = readPages(doc).map(pageLines).flat().join('\n');
        expect(drawn).toContain('Ingrid Solberg — Skipper, 47');
        expect(printed).toContain('Ingrid Solberg — Skipper, 47');
        expectNoBirthDate(drawn);
        expectNoBirthDate(printed);
    });
});
