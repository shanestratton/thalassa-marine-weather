import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';

import { __testing, shareFloatPlanPdf } from '../services/floatPlanPdf';
import {
    createFloatPlanSharePayload,
    FLOAT_PLAN_GUIDE_HEADING,
    prepareFloatPlan,
    type FloatPlanInput,
} from '../services/floatPlan';
import { bidiCanvasText, PdfTextWriter, splitTextRuns } from '../services/pdf/pdfText';
import { GLOBAL_PLACES, GLOBAL_TEXT, globalFloatPlan, longFloatPlan, standardFloatPlan } from './helpers/pdfFixtures';
import { installFakeCanvas, pageLines, readPages, textRight, type CanvasDraw } from './helpers/jspdfPages';

/**
 * The float plan PDF, drawn with jsPDF primitives since 129-10 (it was an
 * HTML page through doc.html(), html2canvas and DOMPurify). These read the
 * document back page by page: what prints, on which page, and that nothing
 * the skipper typed is lost, whatever the script.
 */

const { buildFloatPlanPdf } = __testing;

/**
 * The paper, not the layout code's own constants: A4 is 210 x 297 mm, nothing
 * prints within 10 mm of the top or bottom edge (later pages) and no text runs
 * past the old 800 px page's right content edge, 201.6 mm from the left.
 */
const PAPER_BOTTOM_LIMIT = 297 - 10;
const PAPER_TOP_LIMIT = 10;
const RIGHT_EDGE = 201.7;

let canvas: ReturnType<typeof installFakeCanvas>;
beforeEach(() => {
    canvas = installFakeCanvas();
});
afterEach(() => {
    canvas.restore();
    vi.restoreAllMocks();
});

function plan(overrides: Partial<FloatPlanInput> = {}): FloatPlanInput {
    return { ...standardFloatPlan(), ...overrides };
}

function build(input: FloatPlanInput) {
    const draw = vi.spyOn(PdfTextWriter.prototype, 'draw');
    const { doc, filename } = buildFloatPlanPdf(input, jsPDF);
    // Every line as laid out, pictures included (the PDF's own text holds only
    // the runs Helvetica can encode).
    const drawn = draw.mock.calls.map((call) => call[0] as string);
    draw.mockRestore();
    const pages = readPages(doc);
    const lines = pages.map(pageLines);
    return { doc, filename, pages, lines, drawn, text: lines.flat().join('\n') };
}

/** Each drawn line's runs reached the page: text as PDF text, the rest as canvas pictures. */
function expectEveryRunPrinted(drawn: string[], pages: ReturnType<typeof readPages>, draws: CanvasDraw[]): void {
    const texts = new Set(pages.flatMap((page) => page.texts.map((item) => item.text)));
    const pictures = new Set(draws.map((item) => item.text));
    for (const line of drawn) {
        for (const run of splitTextRuns(line)) {
            if (run.encodable) expect(texts.has(run.text), `text run missing: ${run.text}`).toBe(true);
            else expect(pictures.has(bidiCanvasText(run.text)), `picture missing: ${run.text}`).toBe(true);
        }
    }
    // Every picture is a left-to-right paragraph, as the brief is: the bidi
    // algorithm orders any right-to-left text inside it.
    expect(draws.filter((item) => item.direction !== 'ltr')).toEqual([]);
    // Nothing written as two-byte codes (mojibake), nothing replaced.
    expect(pages.flatMap((page) => page.texts).filter((item) => item.garbled)).toEqual([]);
    expect([...texts].join('')).not.toMatch(/\uFFFD/);
}

/** Every text run and picture inside the paper's limits. */
function expectOnPaper(doc: jsPDF, pages: ReturnType<typeof readPages>): void {
    pages.forEach((page, index) => {
        for (const item of page.texts) {
            const where = `page ${index + 1}: ${item.text}`;
            expect(item.y, where).toBeLessThanOrEqual(PAPER_BOTTOM_LIMIT);
            expect(item.y, where).toBeGreaterThan(index === 0 ? 5 : PAPER_TOP_LIMIT);
            expect(item.x, where).toBeGreaterThanOrEqual(7);
            expect(textRight(doc, item), where).toBeLessThanOrEqual(RIGHT_EDGE);
        }
        for (const image of page.images) {
            // A picture's box runs a pad past its glyphs: allow that, no more.
            expect(image.top + image.height, `page ${index + 1} picture`).toBeLessThanOrEqual(PAPER_BOTTOM_LIMIT + 2);
            expect(image.x + image.width, `page ${index + 1} picture`).toBeLessThanOrEqual(RIGHT_EDGE + 1);
        }
    });
}

/** Whitespace collapsed, so a line the PDF wrapped still matches the brief. */
const flat = (value: string) => value.replace(/\s+/g, ' ').trim();

/** The page (1-based) whose lines contain `needle`. */
function pageOf(lines: string[][], needle: string): number {
    return lines.findIndex((page) => page.some((line) => line.includes(needle))) + 1;
}

describe('float plan PDF content', () => {
    it('prints litre-entered fuel and water with their correct litre values', () => {
        const { text } = build(
            plan({
                vessel: { name: 'Serene Example', fuelCapacity: 1000 / 3.78541, waterCapacity: 600 / 3.78541 },
            }),
        );
        expect(text).toContain('Fuel 1000 L');
        expect(text).toContain('water 600 L');
        expect(text).not.toContain('Fuel 264 L');
    });

    it('lists the people aboard in rank order, as the email brief does (Shane 2026-10-07)', () => {
        const { text } = build(
            plan({
                personsOnBoard: 3,
                personsRoster: [
                    { name: 'Pat Example', role: 'Guest' },
                    { name: 'Priya Example', role: 'First mate' },
                    { name: 'Ana Example', role: 'Skipper' },
                ],
            }),
        );
        expect(text).toContain('1. Ana Example — Skipper');
        expect(text).toContain('2. Priya Example — First mate');
        expect(text).toContain('3. Pat Example — Guest');
    });

    it('carries the overdue time and the number to ring, large, on page 1', () => {
        // These two are the entire reason a float plan exists. Everything else is
        // reference; without either of them the document is decoration.
        const input = plan();
        const { lines } = build(input);
        const page1 = lines[0];
        expect(page1).toContain('IF THERE IS NO CONTACT BY');
        expect(page1).toContain(prepareFloatPlan(input).overdue);
        expect(page1).toContain('Call: VMR Example Bay — 07 5000 0000');
    });

    it('carries the overdue guide, not just the data', () => {
        // A plan that ships the facts and drops the guide is prettier and worse:
        // it leaves the holder informed and with no idea what to do at 2am.
        const { text } = build(plan());
        expect(text).toContain(FLOAT_PLAN_GUIDE_HEADING);
        expect(text).toMatch(/Try us first/i);
        expect(text).toMatch(/say you do not know/i);
    });

    it('says not to file the plan with a rescue authority', () => {
        // Genuinely counter-intuitive, and the paper form is emphatic about it:
        // the plan goes to a person, not an agency.
        const { text } = build(plan());
        expect(flat(text)).toMatch(/Do not file this plan with a rescue authority/i);
    });

    it('prints a vessel name with angle brackets as typed, not as markup', () => {
        // It used to be escaped into HTML; now nothing parses it at all.
        const { text } = build(plan({ vessel: { name: 'Sea <b>Dog</b> & "Co"', type: 'sail' } }));
        expect(text).toContain('Sea <b>Dog</b> & "Co"');
    });

    it('produces a filesystem-safe filename, and never an empty one', () => {
        const { filename } = buildFloatPlanPdf(
            plan({ vessel: { name: 'Sea/Dog: "Winner" *2*', type: 'sail' } }),
            jsPDF,
        );
        expect(filename).not.toMatch(/[/:*"<>|]/);
        expect(filename.length).toBeGreaterThan(0);

        const fallback = buildFloatPlanPdf(plan({ vessel: { name: '///', type: 'sail' } }), jsPDF);
        expect(fallback.filename.length).toBeGreaterThan(0);
    });

    it.each([
        ['standard', standardFloatPlan],
        ['global', globalFloatPlan],
        ['long', longFloatPlan],
    ])('prints every line of the email brief, in order (%s)', (_name, fixture) => {
        const input = fixture();
        const brief = createFloatPlanSharePayload(input, 'email').text;
        const { drawn, pages } = build(input);
        expectEveryRunPrinted(drawn, pages, canvas.draws);
        const printed = flat(drawn.join(' '));
        let from = 0;
        for (const line of brief.split('\n').map(flat)) {
            if (line.length === 0 || /^─+$/.test(line)) continue;
            const at = printed.indexOf(line, from);
            expect(at, `missing or out of order: ${line}`).toBeGreaterThanOrEqual(0);
            from = at + line.length;
        }
    });
});

describe('float plan PDF pages', () => {
    it('standard plan: the header, alarm and data on page 1, the whole overdue guide on page 2', () => {
        const { lines } = build(standardFloatPlan());
        expect(lines).toHaveLength(2);
        for (const heading of [
            'FLOAT PLAN',
            'RAISE THE ALARM',
            'PASSAGE',
            'VESSEL',
            'SAFETY & SURVIVAL',
            'PERSONS ONBOARD',
        ]) {
            expect(pageOf(lines, heading), heading).toBe(1);
        }
        for (const step of [
            FLOAT_PLAN_GUIDE_HEADING,
            '1. Try us first.',
            '2. Ring the people ashore who might have heard from us.',
            '3. Still worried? Make the call.',
            '4. Tell them only what is written here.',
            '5. Stay reachable.',
            'who knows most about where we are.',
            'Please reply RECEIVED so we know you have this plan.',
        ]) {
            expect(pageOf(lines, step), step).toBe(2);
        }
        expect(pageOf(lines, 'Do not file this plan with a rescue authority')).toBe(2);
    });

    it.each([
        ['standard', standardFloatPlan],
        ['global', globalFloatPlan],
        ['long', longFloatPlan],
    ])('keeps the overdue guide on one page (%s)', (_name, fixture) => {
        const { lines } = build(fixture());
        const page = pageOf(lines, FLOAT_PLAN_GUIDE_HEADING);
        expect(page).toBeGreaterThan(0);
        for (const step of [
            '1. Try us first.',
            '3. Still worried? Make the call.',
            '5. Stay reachable.',
            'who knows most about where we are.',
        ]) {
            expect(pageOf(lines, step), step).toBe(page);
        }
    });

    it('moves the whole overdue guide to a fresh page rather than split it, at every crew size from 0 to 60', () => {
        // The guide is what the holder reads at 2am. Somewhere in this sweep it
        // starts too near a page bottom to fit, and must move whole.
        let movedWithRoomLeft = 0;
        for (let count = 0; count <= 60; count++) {
            const personsRoster = Array.from({ length: count }, (_, index) => ({
                name: `Crew ${index + 1} Example`,
                role: index === 0 ? 'Skipper' : 'Deckhand',
                age: 20 + (index % 40),
            }));
            const { pages, lines } = build(plan({ personsOnBoard: count, personsRoster }));
            const printed = lines.flatMap((page, index) => page.map((line) => ({ line, page: index + 1 })));
            const start = printed.findIndex((entry) => entry.line.includes(FLOAT_PLAN_GUIDE_HEADING));
            const end = printed.findIndex(
                (entry, index) => index > start && entry.line.includes('who knows most about where we are.'),
            );
            expect(start, `${count} aboard`).toBeGreaterThan(0);
            expect(end, `${count} aboard`).toBeGreaterThan(start);
            const guidePages = new Set(printed.slice(start, end + 1).map((entry) => entry.page));
            expect([...guidePages], `${count} aboard: the guide split across pages`).toHaveLength(1);
            const guidePage = printed[start].page;
            if (printed[start - 1].page !== guidePage) {
                // Moved: the heading starts its page.
                expect(lines[guidePage - 1][0], `${count} aboard`).toContain(FLOAT_PLAN_GUIDE_HEADING);
                const lastBefore = Math.max(...pages[guidePage - 2].texts.map((item) => item.y));
                if (PAPER_BOTTOM_LIMIT - lastBefore > 15) movedWithRoomLeft++;
            }
        }
        // At least one size moved it while its old page still had lines of room:
        // the case the keep-on-one-page rule exists for.
        expect(movedWithRoomLeft).toBeGreaterThan(0);
    }, 30000);

    it.each([
        ['standard', standardFloatPlan],
        ['global', globalFloatPlan],
        ['long', longFloatPlan],
    ])('keeps every line on the paper (%s)', (_name, fixture) => {
        const { doc, pages } = build(fixture());
        expectOnPaper(doc, pages);
    });

    it('breaks a long plan between whole lines, with nothing off the paper', () => {
        const input = longFloatPlan();
        const { doc, pages, lines } = build(input);
        expect(pages.length).toBeGreaterThanOrEqual(3);
        expectOnPaper(doc, pages);
        // A crew line that wrapped stays on one page: no page starts with the
        // tail of a sentence from the page before.
        for (const page of lines.slice(1)) {
            expect(page[0]).toMatch(/^(\d+\.|[A-Z]|Do not file)/);
        }
        // All twelve aboard print, each once.
        for (const person of input.personsRoster ?? []) {
            expect(lines.flat().filter((line) => line.includes(`${person.name} —`))).toHaveLength(1);
        }
    });

    it('a single line longer than a page still prints all of itself', () => {
        const note = Array.from({ length: 900 }, (_, index) => `word${index}`).join(' ');
        const { doc, pages, lines } = build(plan({ vessel: { ...standardFloatPlan().vessel, safetyNotes: note } }));
        const printed = flat(lines.flat().join(' '));
        expect(printed).toContain(note);
        expectOnPaper(doc, pages);
    });
});

describe('float plan PDF, every script (129-10 decision B)', () => {
    it('prints the vessel name, a crew name, the places, a note and a contact in every script', () => {
        const drawn = flat(build(globalFloatPlan()).drawn.join(' '));
        expect(drawn).toContain(`Étoile ${GLOBAL_TEXT}`);
        expect(drawn).toContain(`1. ${GLOBAL_TEXT} — Skipper, 47, Note: ${GLOBAL_TEXT}`);
        expect(drawn).toContain(`From: ${GLOBAL_TEXT}`);
        expect(drawn).toContain(`To: ${GLOBAL_PLACES.cyrillic} (${GLOBAL_PLACES.japanese})`);
        expect(drawn).toContain(`Note: ${GLOBAL_TEXT}`);
        expect(drawn).toContain(`${GLOBAL_PLACES.hebrew} — \u200e+972 0 000 0000\u200e`);
        expect(drawn).toContain('3. דוד כהן — Navigator, 33, אלרגיה לפניצילין');
        expect(drawn).toContain('4. ليلى حداد — Cook, 29, mobile \u200e+20 0 000 0001\u200e');
    });

    it('draws each run as selectable text or as a picture, and loses none of it', () => {
        const { drawn, pages } = build(globalFloatPlan());
        expectEveryRunPrinted(drawn, pages, canvas.draws);
        // Every script reached a picture.
        const pictured = canvas.draws.map((draw) => draw.text).join(' ');
        for (const place of [GLOBAL_PLACES.greek, GLOBAL_PLACES.cyrillic, GLOBAL_PLACES.japanese, GLOBAL_PLACES.thai]) {
            expect(pictured).toContain(place);
        }
        // Accented Latin stays real text.
        expect(pages.flatMap((page) => page.texts.map((item) => item.text)).join(' ')).toContain('Nouméa Ålesund');
    });

    it('draws every line with Hebrew or Arabic whole, as one left-to-right paragraph', () => {
        const { drawn } = build(globalFloatPlan());
        const pictured = canvas.draws.map((draw) => draw.text);
        const bidiLines = drawn.filter((line) => /[\u0590-\u06ff]/.test(line));
        expect(bidiLines.length).toBeGreaterThanOrEqual(6);
        for (const line of bidiLines) expect(pictured, line).toContain(bidiCanvasText(line.normalize('NFC')));
        expect(pictured).toContain('3. דוד כהן — Navigator, 33, אלרגיה לפניצילין');
        expect(pictured).toContain('4. ليلى حداد — Cook, 29, mobile \u200e+20 0 000 0001\u200e');
        // The overdue guide's shore contact, indent and all.
        expect(pictured).toContain(`   ${GLOBAL_PLACES.hebrew} — \u200e+972 0 000 0000\u200e`);
        expect(canvas.draws.filter((draw) => draw.direction !== 'ltr')).toEqual([]);
    });

    it('keeps the label, the crew number and the indent on the left of a line with brackets, "%" or bidi marks', () => {
        // 129-10 review: cut into islands, "(חובש)" printed round the wrong
        // word, "80%" lost its "%", and a line carrying a pasted RLM or a
        // phone number's embedding marks flipped right-to-left whole.
        const input = plan({
            vessel: {
                ...standardFloatPlan().vessel,
                safetyNotes: 'Fuel: מלא 80% aboard',
                shoreContact1: 'מרים לוי — \u202a+972 50 000 0000\u202c',
            },
            personsOnBoard: 2,
            personsRoster: [
                { name: 'דוד כהן (חובש)', role: 'Skipper', age: 47 },
                { name: '\u2067דוד כהן\u2069', role: 'Navigator', age: 33 },
            ],
            contactAboard: 'Iridium +881 600 000 000 · מרים\u200f',
        });
        const { drawn } = build(input);
        const pictures = canvas.draws.map((draw) => `${draw.direction}|${draw.text}`);
        for (const line of [
            '1. דוד כהן (חובש) — Skipper, 47',
            '2. \u2067דוד כהן\u2069 — Navigator, 33',
            // A number on a right-to-left line carries LRMs either side (holdNumbersLeftToRight).
            'Contact aboard: Iridium \u200e+881 600 000 000\u200e · מרים\u200f',
            // The overdue guide: "1. Try us first." and "2. Ring the people ashore".
            '   Iridium \u200e+881 600 000 000\u200e · מרים\u200f',
            '   מרים לוי — \u202a\u200e+972 50 000 0000\u200e\u202c',
        ]) {
            expect(drawn, line).toContain(line);
            expect(splitTextRuns(line), line).toHaveLength(1);
            expect(pictures, line).toContain(`ltr|${bidiCanvasText(line)}`);
        }
        // The medic label's brackets carry their N0 marks.
        expect(pictures).toContain('ltr|1. דוד כהן (חובש\u200f)\u200f — Skipper, 47');
        expect(drawn.some((line) => line.includes('Fuel: מלא 80% aboard'))).toBe(true);
        expect(pictures.some((entry) => entry.startsWith('ltr|') && entry.includes('Fuel: מלא 80% aboard'))).toBe(true);
        expect(canvas.draws.filter((draw) => draw.direction !== 'ltr')).toEqual([]);
    });

    it('prints the arrow as a picture between the two places, and the rules as lines', () => {
        const { pages, lines } = build(standardFloatPlan());
        expect(canvas.draws.map((draw) => draw.text)).toContain('→');
        // The two places are text either side of the arrow's picture.
        expect(lines[0]).toContain('Scarborough Marina  Mooloolaba');
        const from = pages[0].texts.find((item) => item.text === 'Scarborough Marina ');
        const to = pages[0].texts.find((item) => item.text === ' Mooloolaba');
        const arrow = pages[0].images.find((image) => from && to && image.x > from.x && image.x < to.x);
        expect(arrow).toBeDefined();
        // The "────" separators are drawn rules, never text.
        expect(lines.flat().join('')).not.toMatch(/─/);
    });
});

describe('float plan PDF share', () => {
    it('hands the share sheet a real PDF, and never uses doc.html()', async () => {
        // jsPDF copies its API methods onto each document it creates, so this sees doc.html().
        const html = vi.spyOn(jsPDF.API as unknown as { html: () => void }, 'html');
        let shared: File | undefined;
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
        Object.defineProperty(navigator, 'share', {
            configurable: true,
            value: vi.fn(async (data: { files: File[] }) => {
                shared = data.files[0];
            }),
        });
        await shareFloatPlanPdf(globalFloatPlan());
        expect(shared?.type).toBe('application/pdf');
        expect(shared?.name).toMatch(/^Float plan - .*\.pdf$/);
        const head = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).slice(0, 5));
            reader.readAsBinaryString(shared as File);
        });
        expect(head).toBe('%PDF-');
        expect(html).not.toHaveBeenCalled();
    }, 10000);
});
