import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsPDF } from 'jspdf';

import { bidiCanvasText, graphemes, isWinAnsiText, PdfTextWriter, splitTextRuns } from '../services/pdf/pdfText';
import { GLOBAL_PLACES, GLOBAL_TEXT } from './helpers/pdfFixtures';
import { installFakeCanvas, pageLines, readPages } from './helpers/jspdfPages';

/**
 * services/pdf/pdfText.ts splits a line into what jsPDF's Helvetica can encode
 * (real text) and what it cannot (a canvas picture). The rule from 129-10:
 * no character may be dropped, replaced by "?" or turned into mojibake, and
 * right-to-left text must read in the right order.
 */

const joined = (line: string) =>
    splitTextRuns(line)
        .map((run) => run.text)
        .join('');

/** Every script but the right-to-left ones: these split into text and pictures. */
const LTR_SCRIPTS = [
    GLOBAL_PLACES.latin,
    GLOBAL_PLACES.greek,
    GLOBAL_PLACES.cyrillic,
    GLOBAL_PLACES.japanese,
    GLOBAL_PLACES.thai,
].join(' ');

/**
 * Lines the 129-10 review printed out of order when right-to-left text was cut
 * into islands: a bracket or a "%" / "°" after a final digit landed outside
 * the island, and explicit bidi controls made the whole line right-to-left.
 * Drawn whole as one left-to-right paragraph (with bidiCanvasText's bracket
 * marks), each prints as WebKit's own layout of the same line: 44 lines
 * compared pixel for pixel in Playwright WebKit, 2026-10-13.
 */
const BIDI_LINES = [
    'דוד כהן (חובש) — Watch leader, 47',
    'Marina: מרינה הרצליה (צפון)',
    'Port: الإسكندرية (المرسى الشرقي) then Haifa',
    'Fuel: מלא 80% aboard',
    'Sea temp: חם 24° at noon',
    'Check דוד כהן (חובש) lifejacket',
    '2. \u2067דוד כהן\u2069 — Navigator, 33',
    'Contact aboard: Iridium +881 600 000 000 · מרים\u200f',
    '   מרים לוי — \u202a+972 50 000 0000\u202c',
    'Call \u202a+61 7 0000 0000\u202c now',
];

describe('isWinAnsiText', () => {
    it('accepts Latin-1 and the WinAnsi typographic marks jsPDF maps itself', () => {
        expect(isWinAnsiText('Nouméa Ålesund Ødegård São Tomé Reykjavík Ærøskøbing')).toBe(true);
        expect(isWinAnsiText('— – “quotes” ‘single’ … • € ™ Œ ž')).toBe(true);
    });

    it('rejects everything else', () => {
        for (const text of ['→', '─', 'Łódź', ...Object.values(GLOBAL_PLACES).slice(1), '⚓', '🛟']) {
            expect(isWinAnsiText(text), text).toBe(false);
        }
    });
});

describe('splitTextRuns', () => {
    it('loses nothing and keeps the order, whatever the script', () => {
        const lines = [
            GLOBAL_TEXT,
            `1. ${GLOBAL_TEXT} — Skipper, 47`,
            'From: Gdańsk → Kraków (Łódź)',
            'Hailing port 長崎 · Rego QX000Z',
            'Call: חיפה — +972 0 000 0000, then Haifa port control',
            'ภูเก็ต อ่าวฉลอง',
            '🛟 grab bag ⚓',
        ];
        for (const line of lines) expect(joined(line)).toBe(line.normalize('NFC'));
    });

    it('keeps Latin-1 as one text run', () => {
        expect(splitTextRuns('Nouméa — Ålesund')).toEqual([{ text: 'Nouméa — Ålesund', encodable: true }]);
    });

    it('draws a line with Hebrew or Arabic whole, so brackets, "%" and "°" stay where the bidi algorithm puts them', () => {
        for (const line of [
            ...BIDI_LINES.slice(0, 6),
            '3. דוד כהן — Navigator, 33',
            'רחוב 5, Haifa',
            'الإسكندرية — +20 0 000 0000',
            'Haifa, then الإسكندرية؟',
            `Étoile ${GLOBAL_TEXT}`,
        ]) {
            expect(splitTextRuns(line), line).toEqual([{ text: line, encodable: false }]);
        }
    });

    it('draws a line with an explicit bidi control whole too, right-to-left letters or not', () => {
        for (const line of BIDI_LINES.slice(6)) {
            expect(splitTextRuns(line), line).toEqual([{ text: line, encodable: false }]);
        }
    });

    it('joins pictures separated only by spaces into one', () => {
        expect(splitTextRuns(`${GLOBAL_PLACES.greek} ${GLOBAL_PLACES.cyrillic} ${GLOBAL_PLACES.japanese}`)).toEqual([
            { text: `${GLOBAL_PLACES.greek} ${GLOBAL_PLACES.cyrillic} ${GLOBAL_PLACES.japanese}`, encodable: false },
        ]);
        expect(splitTextRuns(`Kyiv Київ · ${GLOBAL_PLACES.japanese} ${GLOBAL_PLACES.thai} 2`)).toEqual([
            { text: 'Kyiv ', encodable: true },
            { text: 'Київ', encodable: false },
            { text: ' · ', encodable: true },
            { text: `${GLOBAL_PLACES.japanese} ${GLOBAL_PLACES.thai}`, encodable: false },
            { text: ' 2', encodable: true },
        ]);
    });

    it('never splits a letter from its combining mark', () => {
        // x + combining acute has no precomposed form, so it stays two code points.
        const runs = splitTextRuns('Bay x́ cove');
        expect(runs.map((run) => run.text)).toEqual(['Bay ', 'x́', ' cove']);
        // ภู เ ก็ ต: the vowel and tone marks ride on their consonants.
        expect(graphemes('ภูเก็ต')).toEqual(['ภู', 'เ', 'ก็', 'ต']);
    });

    it('composes a decomposed accent so it stays real text', () => {
        expect(splitTextRuns('Nouméa')).toEqual([{ text: 'Nouméa', encodable: true }]);
    });
});

describe("bidiCanvasText (rule N0, which WebKit's canvas lacks)", () => {
    const LRM = '\u200e';
    const RLM = '\u200f';
    const ALM = '\u061c';

    it('pins a closing bracket of a right-to-left pair, so the brackets stay round the medic label', () => {
        expect(bidiCanvasText('דוד כהן (חובש) — Watch leader, 47')).toBe(
            `דוד כהן (חובש${RLM})${RLM} — Watch leader, 47`,
        );
        expect(bidiCanvasText('Marina: מרינה הרצליה (צפון)')).toBe(`Marina: מרינה הרצליה (צפון${RLM})${RLM}`);
        expect(bidiCanvasText('דוד [חובש] {כהן}')).toBe(`דוד [חובש] {כהן${RLM}}${RLM}`);
        expect(bidiCanvasText('שער (80) Gate')).toBe(`שער (80${RLM})${RLM} Gate`);
    });

    it('uses ALM after Arabic, so a number after the bracket stays an Arabic number', () => {
        expect(bidiCanvasText('Port: الإسكندرية (المرسى الشرقي) then Haifa')).toBe(
            `Port: الإسكندرية (المرسى الشرقي${ALM})${ALM} then Haifa`,
        );
    });

    it('pins a pair left to right when Latin text holds it, and keeps a number after it right to left', () => {
        // N0: Latin before the pair, only Hebrew inside: the pair is L.
        expect(bidiCanvasText('Skipper (חובש) דוד כהן')).toBe(`Skipper (חובש${LRM})${LRM} דוד כהן`);
        // The LRM would turn the 5 left-to-right (W7): an RLM before it keeps it.
        expect(bidiCanvasText('Skipper (חובש) 5 דוד')).toBe(`Skipper (חובש${LRM})${LRM} ${RLM}5 דוד`);
        // Latin inside a pair after Hebrew: L. The canvas already puts the "("
        // left to right; only the ")" between two Hebrew words needs the pin.
        expect(bidiCanvasText('דוד (Skipper חובש) כהן')).toBe(`דוד (Skipper חובש${LRM})${LRM} כהן`);
    });

    it('leaves alone every line the canvas already gets right', () => {
        for (const line of [
            'Haifa (חיפה) port',
            '(חיפה) Haifa',
            'דוד (חובש — Medic',
            'מרים לוי (אחות) — 0400 000 001',
            'Fuel: (80%) מלא',
            'Navigator (Θεσσαλονίκη) 長崎',
            'Plain (Latin) line',
            'Fuel: מלא 80% aboard',
            // Isolates and embeddings scope brackets apart: left to the canvas.
            '2. \u2067דוד (כהן)\u2069 — Navigator',
        ]) {
            expect(bidiCanvasText(line), line).toBe(line);
        }
    });

    it('only ever adds zero-width marks', () => {
        for (const line of [
            ...BIDI_LINES,
            'דוד (חובש (ראשי)) — Medic, 47',
            'Crew: דוד כהן (חובש), מרים לוי (נווטת) and Ana',
        ]) {
            if (/[\u200e\u200f\u061c]/.test(line)) continue;
            expect(bidiCanvasText(line).replace(/[\u200e\u200f\u061c]/g, ''), line).toBe(line);
        }
    });
});

describe('PdfTextWriter', () => {
    let canvas: ReturnType<typeof installFakeCanvas>;
    beforeEach(() => {
        canvas = installFakeCanvas();
    });
    afterEach(() => canvas.restore());

    it('wraps as pre-wrap does: indents kept, breaks eat their spaces, nothing lost', () => {
        const writer = new PdfTextWriter(new jsPDF({ unit: 'mm', format: 'a4' }));
        const style = { size: 9 };
        const text = `   Keep your phone free. They will ring back for more, and ${GLOBAL_TEXT} ${'長崎'.repeat(40)}`;
        const lines = writer.wrap(text, style, 60);
        expect(lines.length).toBeGreaterThan(3);
        expect(lines[0].startsWith('   Keep')).toBe(true);
        for (const line of lines.slice(1)) expect(line.startsWith(' ')).toBe(false);
        for (const line of lines) expect(writer.measure(line, style)).toBeLessThanOrEqual(60 + 1e-6);
        expect(lines.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
    });

    it('reads a typed CR LF as one line break and a tab as a space', () => {
        const writer = new PdfTextWriter(new jsPDF({ unit: 'mm', format: 'a4' }));
        expect(writer.wrap('Oil changed\r\nFilter\tdone', { size: 9 }, 150)).toEqual(['Oil changed', 'Filter done']);
    });

    it('draws Latin-1 as text and the rest as pictures, never as two-byte mojibake', () => {
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        const writer = new PdfTextWriter(doc);
        writer.draw(`From: ${LTR_SCRIPTS}`, 10, 20, { size: 9 });
        const [page] = readPages(doc);
        expect(page.texts.some((item) => item.garbled)).toBe(false);
        expect(pageLines(page)[0]).toBe('From: Nouméa Ålesund ');
        expect(page.images).toHaveLength(1);
        expect(canvas.draws.map((draw) => [draw.text, draw.direction])).toEqual([
            [`${GLOBAL_PLACES.greek} ${GLOBAL_PLACES.cyrillic} ${GLOBAL_PLACES.japanese} ${GLOBAL_PLACES.thai}`, 'ltr'],
        ]);
    });

    it('draws a right-to-left line as one left-to-right paragraph: label first, indent kept, nothing split off', () => {
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        const writer = new PdfTextWriter(doc);
        BIDI_LINES.forEach((line, index) => writer.draw(line, 10, 20 + index * 8, { size: 9 }));
        // One picture per line, the whole line in it, never a right-to-left
        // paragraph (that would move the label, the list number and the indent
        // to the right-hand end).
        expect(canvas.draws.map((draw) => [draw.text, draw.direction])).toEqual(
            BIDI_LINES.map((line) => [bidiCanvasText(line), 'ltr']),
        );
        // The bracket lines carry their N0 marks to the canvas.
        expect(canvas.draws[0].text).toBe('דוד כהן (חובש\u200f)\u200f — Watch leader, 47');
        const [page] = readPages(doc);
        expect(page.texts).toEqual([]);
        expect(page.images).toHaveLength(BIDI_LINES.length);
        // Each picture starts at the line's left edge (less its small pad), so
        // "Contact aboard:" and the three-space indent stay on the left.
        for (const image of page.images) {
            expect(image.x).toBeLessThan(10);
            expect(image.x).toBeGreaterThan(9.4);
        }
    });

    it('fails the export loudly when there is no canvas to draw a non-Latin run', () => {
        canvas.restore();
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = (() => null) as typeof original;
        try {
            const writer = new PdfTextWriter(new jsPDF({ unit: 'mm', format: 'a4' }));
            expect(() => writer.draw('Plain Latin is fine', 10, 10, { size: 9 })).not.toThrow();
            expect(() => writer.draw(GLOBAL_PLACES.japanese, 10, 20, { size: 9 })).toThrow(/canvas/);
        } finally {
            HTMLCanvasElement.prototype.getContext = original;
            canvas = installFakeCanvas();
        }
    });
});
