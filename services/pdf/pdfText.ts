/**
 * pdfText — jsPDF text that never drops a character the skipper typed.
 *
 * jsPDF's built-in Helvetica encodes WinAnsi (Latin-1 plus a few typographic
 * marks) and nothing else. Given one character outside it, jsPDF writes the
 * WHOLE string as two-byte codes the font cannot decode, so "Nouméa → 長崎"
 * prints as mojibake, every Latin letter included. The old PDFs (jsPDF's html(),
 * which needed html2canvas and DOMPurify, about 230 KB) went through the same
 * fonts and printed exactly that: measured 2026-10-13, Greek, Cyrillic,
 * Japanese, Hebrew, Arabic, Thai, "→" and the "─" rules all came out as
 * garbage.
 *
 * So every line is split into runs:
 *   - text Helvetica can encode is drawn as real, selectable PDF text;
 *   - anything else is drawn with the device's own fonts onto a plain canvas
 *     (fillText) and placed as an image at the same position and size. Only
 *     that run (for right-to-left text, that line) stops being selectable.
 *     No font file, no dependency.
 *
 * A line with any right-to-left text (Hebrew, Arabic, ...) or any explicit
 * bidi control is drawn whole, as ONE picture of a left-to-right paragraph:
 * the paragraph direction of the email brief and of the old <pre>. The canvas
 * runs the Unicode bidi algorithm over it, so "80%" and "24°" stay with their
 * number and marks round a pasted phone number are honoured. Cutting such a
 * line into islands could not match that (129-10 review). The cost is that the
 * line is not selectable.
 *
 * One rule is missing from WebKit's canvas (measured 2026-10-13, WebKit 26):
 * N0, which pairs brackets. Its DOM layout has it, so "דוד כהן (חובש)" reads
 * right on screen and in the email, but the canvas puts the brackets round the
 * name. bidiCanvasText() applies N0 itself and pins each bracket it would get
 * wrong between two zero-width marks of the right direction, which also reads
 * right on an engine that does have N0.
 */
import type { jsPDF } from 'jspdf';

/** 1 pt in mm. */
export const PT_MM = 25.4 / 72;

export interface PdfTextStyle {
    /** Font size in points. */
    size: number;
    bold?: boolean;
    /** '#rrggbb'. */
    color?: string;
    /** Letter spacing in mm (CSS letter-spacing). */
    charSpace?: number;
}

export interface PdfTextRun {
    text: string;
    /** false: drawn on a canvas and placed as an image. */
    encodable: boolean;
}

/** WinAnsi's 0x80-0x9F block; jsPDF maps these code points to their bytes itself. */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

function encodableCodePoint(code: number, char: string): boolean {
    return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(char);
}

/** True when jsPDF's Helvetica can print every code point of `text`. */
export function isWinAnsiText(text: string): boolean {
    for (const char of text) {
        if (!encodableCodePoint(char.codePointAt(0) ?? 0, char)) return false;
    }
    return true;
}

// The right-to-left scripts (Script_Extensions, so the Arabic comma and
// question mark count), and the explicit bidi controls: LRM, RLM, ALM, the
// embeddings, overrides and isolates. A line with any of them is one picture.
const RTL_SCRIPT =
    /[\p{Script_Extensions=Hebrew}\p{Script_Extensions=Arabic}\p{Script_Extensions=Syriac}\p{Script_Extensions=Thaana}\p{Script_Extensions=Nko}\p{Script_Extensions=Samaritan}\p{Script_Extensions=Mandaic}\p{Script_Extensions=Adlam}\p{Script_Extensions=Hanifi_Rohingya}]/u;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MARK = /^\p{M}/u;

// ── Rule N0 for the canvas (UAX #9 BD16 and N0, paragraph direction L) ──────
const LRM = '\u200e';
const RLM = '\u200f';
const ALM = '\u061c';
/** The Bidi_Paired_Bracket pairs a typed line plausibly carries. */
const BRACKETS: Readonly<Record<string, string>> = {
    '(': ')',
    '[': ']',
    '{': '}',
    '（': '）',
    '［': '］',
    '｛': '｝',
    '〈': '〉',
    '《': '》',
    '「': '」',
    '『': '』',
    '【': '】',
    '〔': '〕',
    '⟨': '⟩',
};
const CLOSERS = new Set(Object.values(BRACKETS));
const LETTER = /\p{L}/u;
/** Bidi class AL rather than R: these scripts turn a following "12" into an Arabic number (W2). */
const AL_SCRIPT =
    /[\p{Script_Extensions=Arabic}\p{Script_Extensions=Syriac}\p{Script_Extensions=Thaana}\p{Script_Extensions=Hanifi_Rohingya}]/u;
const EUROPEAN_DIGIT = /[0-9\u00b2\u00b3\u00b9\u06f0-\u06f9\uff10-\uff19]/u;
const ARABIC_DIGIT = /[\u0660-\u0669\u066b\u066c]/u;
const DIGIT = /\p{Nd}/u;
// Embeddings, overrides and isolates split a line into separate bracket
// scopes; a line with one is left to the canvas as it is.
const EXPLICIT_LEVELS = /[\u202a-\u202e\u2066-\u2069]/u;

type StrongClass = 'L' | 'R' | 'AL';
type Direction = 'L' | 'R';

function strongClass(char: string): StrongClass | null {
    if (char === LRM) return 'L';
    if (char === RLM) return 'R';
    if (char === ALM) return 'AL';
    if (!LETTER.test(char)) return null;
    if (!RTL_SCRIPT.test(char)) return 'L';
    return AL_SCRIPT.test(char) ? 'AL' : 'R';
}

/**
 * The line as the canvas should be given it: unchanged, except that a bracket
 * rule N0 resolves differently from the canvas's own result sits between two
 * zero-width marks of its direction (LRM, or RLM / ALM after Arabic letters, so
 * a number after it keeps its kind). Marks change nothing else: the neutrals
 * beside the bracket see the mark where they would have seen the bracket.
 */
export function bidiCanvasText(line: string): string {
    const chars = Array.from(line);
    if (EXPLICIT_LEVELS.test(line) || !chars.some((char) => char in BRACKETS)) return line;

    // Each character's direction as rules W1-W7 leave it: letters by script,
    // European digits L after left-to-right text (W7) and R-like after
    // right-to-left text, Arabic digits R-like; null for neutrals.
    const types: (Direction | null)[] = [];
    let lastStrong: StrongClass = 'L';
    for (const char of chars) {
        const strong = strongClass(char);
        if (strong) {
            types.push(strong === 'L' ? 'L' : 'R');
            lastStrong = strong;
        } else if (EUROPEAN_DIGIT.test(char)) types.push(lastStrong === 'L' ? 'L' : 'R');
        else if (ARABIC_DIGIT.test(char)) types.push('R');
        else types.push(DIGIT.test(char) ? 'L' : null);
    }

    // BD16: the bracket pairs, by opening position.
    const pairs: [number, number][] = [];
    const stack: { closer: string; at: number }[] = [];
    for (let index = 0; index < chars.length; index++) {
        const closer = BRACKETS[chars[index]];
        if (closer) {
            if (stack.length === 63) break;
            stack.push({ closer, at: index });
        } else if (CLOSERS.has(chars[index])) {
            for (let depth = stack.length - 1; depth >= 0; depth--) {
                if (stack[depth].closer !== chars[index]) continue;
                pairs.push([stack[depth].at, index]);
                stack.length = depth;
                break;
            }
        }
    }
    if (pairs.length === 0) return line;
    pairs.sort((a, b) => a[0] - b[0]);

    const before = (view: (Direction | null)[], index: number): Direction => {
        for (let at = index - 1; at >= 0; at--) if (view[at]) return view[at] as Direction;
        return 'L';
    };
    const after = (view: (Direction | null)[], index: number): Direction => {
        for (let at = index + 1; at < view.length; at++) if (view[at]) return view[at] as Direction;
        return 'L';
    };

    // N0: a pair with left-to-right text inside is L; with only right-to-left
    // text inside, it takes the direction before it. A resolved pair counts
    // as strong for the pairs after it.
    const resolved = [...types];
    const brackets: [number, Direction][] = [];
    for (const [open, close] of pairs) {
        let hasL = false;
        let hasR = false;
        for (let at = open + 1; at < close; at++) {
            if (resolved[at] === 'L') hasL = true;
            else if (resolved[at] === 'R') hasR = true;
        }
        const direction: Direction | null = hasL ? 'L' : hasR ? before(resolved, open) : null;
        if (!direction) continue;
        resolved[open] = direction;
        resolved[close] = direction;
        brackets.push([open, direction], [close, direction]);
    }

    // Without N0 the canvas resolves a bracket like any neutral (N1, N2). Pin
    // the ones that would differ, until none does (a pin is strong for the rest).
    const canvas = [...types];
    const pinned = new Map<number, Direction>();
    for (let changed = true; changed; ) {
        changed = false;
        for (const [at, direction] of brackets) {
            if (pinned.has(at)) continue;
            const left = before(canvas, at);
            if ((left === after(canvas, at) ? left : 'L') === direction) continue;
            pinned.set(at, direction);
            canvas[at] = direction;
            changed = true;
        }
    }
    if (pinned.size === 0) return line;

    // The strong letter before a position, as rules W2 and W7 look for it.
    const strongBefore = (index: number): StrongClass => {
        for (let at = index - 1; at >= 0; at--) {
            const strong = strongClass(chars[at]);
            if (strong) return strong;
        }
        return 'L';
    };
    const restoreMark = (strong: StrongClass) => (strong === 'AL' ? ALM : RLM);
    let out = '';
    // An LRM after right-to-left text would make the next European number
    // left-to-right (W7): put the original direction back just before it.
    let restore: StrongClass | null = null;
    for (let index = 0; index < chars.length; index++) {
        const direction = pinned.get(index);
        if (!direction) {
            if (strongClass(chars[index])) restore = null;
            else if (restore && EUROPEAN_DIGIT.test(chars[index])) {
                out += restoreMark(restore);
                restore = null;
            }
            out += chars[index];
            continue;
        }
        const strong = strongBefore(index);
        const pin = direction === 'L' ? LRM : restoreMark(strong);
        out += pin + chars[index];
        // A combining mark stays on its bracket.
        while (index + 1 < chars.length && MARK.test(chars[index + 1])) out += chars[++index];
        out += pin;
        if (direction === 'L' && strong !== 'L') restore = strong;
    }
    return out;
}

let graphemeSegmenter: Intl.Segmenter | null | undefined;

/** User-perceived characters, so a base letter and its marks never split. */
export function graphemes(text: string): string[] {
    if (graphemeSegmenter === undefined) {
        graphemeSegmenter =
            typeof Intl !== 'undefined' && 'Segmenter' in Intl
                ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
                : null;
    }
    if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
    const out: string[] = [];
    for (const char of text) {
        if (out.length > 0 && MARK.test(char)) out[out.length - 1] += char;
        else out.push(char);
    }
    return out;
}

/**
 * Split one line (no newlines) into text runs and picture runs, in logical
 * order. Every grapheme of the input lands in exactly one run, in order.
 */
export function splitTextRuns(line: string): PdfTextRun[] {
    const text = line.normalize('NFC');
    if (text.length === 0) return [];
    if (isWinAnsiText(text)) return [{ text, encodable: true }];
    // Right-to-left text or a bidi control: the whole line, one picture.
    if (RTL_SCRIPT.test(text) || BIDI_CONTROL.test(text)) return [{ text, encodable: false }];

    const runs: PdfTextRun[] = [];
    for (const grapheme of graphemes(text)) {
        const encodable = isWinAnsiText(grapheme);
        const last = runs[runs.length - 1];
        if (last?.encodable === encodable) last.text += grapheme;
        else runs.push({ text: grapheme, encodable });
    }

    // A space between two picture runs joins them: one picture, not three runs.
    const merged: PdfTextRun[] = [];
    for (const run of runs) {
        const previous = merged[merged.length - 1];
        const beforeThat = merged[merged.length - 2];
        if (
            previous?.encodable &&
            /^ +$/.test(previous.text) &&
            beforeThat &&
            !beforeThat.encodable &&
            !run.encodable
        ) {
            beforeThat.text += previous.text + run.text;
            merged.pop();
            continue;
        }
        merged.push(run);
    }
    return merged;
}

/** Glyphs jsPDF's width table leaves at a default (Helvetica AFM, /1000 em). */
const WIDTH_FIXES: Record<string, [normal: number, bold: number]> = {
    '€': [556, 556],
    Š: [667, 667],
    Œ: [1000, 1000],
    Ž: [611, 611],
    š: [500, 556],
    œ: [944, 944],
    ž: [500, 500],
};

// The device's own fonts, Helvetica first so a picture run matches the PDF
// text it continues; anything Helvetica lacks falls back to the system font.
const CANVAS_FONT_STACK = 'Helvetica, Arial, "Helvetica Neue", system-ui, -apple-system, sans-serif';
// What a PDF viewer draws for the built-in Helvetica (Arial is metric-compatible).
const HELVETICA_STACK = 'Helvetica, Arial, sans-serif';
/** Canvas pixels per point: 4 is about 290 dpi, sharp on paper. */
const PX_PER_PT = 4;
const PX_PER_MM = PX_PER_PT / PT_MM;

interface Picture {
    dataUrl: string;
    /** jsPDF image alias: one image object per distinct run. */
    alias: string;
    /** mm, from the run's pen position to the image's left edge (negative). */
    left: number;
    /** mm, from the baseline up to the image's top edge. */
    ascent: number;
    width: number;
    height: number;
}

function cssFont(style: PdfTextStyle, stack = CANVAS_FONT_STACK): string {
    return `${style.bold ? 'bold ' : ''}${style.size * PX_PER_PT}px ${stack}`;
}

function hexRgb(color: string | undefined): [number, number, number] {
    const match = /^#?([0-9a-f]{6})$/i.exec(color ?? '');
    if (!match) return [17, 17, 17];
    const value = Number.parseInt(match[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Lays out and draws text on one jsPDF document. Units are the document's
 * (mm). One writer per document: it caches canvas pictures and widths.
 */
export class PdfTextWriter {
    private canvas: HTMLCanvasElement | null = null;
    private context: CanvasRenderingContext2D | null = null;
    private readonly pictures = new Map<string, Picture>();
    private readonly canvasWidths = new Map<string, number>();

    constructor(private readonly doc: jsPDF) {}

    private ctx(): CanvasRenderingContext2D {
        if (this.context) return this.context;
        this.canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
        this.context = this.canvas?.getContext('2d') ?? null;
        // Without a canvas the run would be lost; fail the export instead, so
        // the sheet says so and the plain text can be sent.
        if (!this.context) throw new Error('This PDF needs a canvas to print non-Latin text');
        return this.context;
    }

    private setFont(style: PdfTextStyle): void {
        this.doc.setFont('helvetica', style.bold ? 'bold' : 'normal');
        this.doc.setFontSize(style.size);
    }

    private textWidth(text: string, style: PdfTextStyle): number {
        this.setFont(style);
        let width = this.doc.getTextWidth(text);
        const em = style.size * PT_MM;
        for (const char of text) {
            const fix = WIDTH_FIXES[char];
            if (fix) width += ((style.bold ? fix[1] : fix[0]) / 1000 - this.doc.getStringUnitWidth(char)) * em;
        }
        return width + (style.charSpace ?? 0) * [...text].length;
    }

    private canvasWidth(text: string, font: string): number {
        const key = `${font}|${text}`;
        const cached = this.canvasWidths.get(key);
        if (cached !== undefined) return cached;
        const ctx = this.ctx();
        ctx.font = font;
        ctx.direction = 'ltr';
        const width = ctx.measureText(bidiCanvasText(text)).width / PX_PER_MM;
        this.canvasWidths.set(key, width);
        return width;
    }

    /**
     * Run widths in mm. On a line with a picture run, the text runs are
     * measured as a viewer draws Helvetica: jsPDF's own table runs about 0.7%
     * narrow, enough over a long run to slide the picture onto the space
     * before it.
     */
    private widths(runs: PdfTextRun[], style: PdfTextStyle): number[] {
        const mixed = runs.some((run) => !run.encodable);
        return runs.map((run) => {
            if (!run.encodable) return this.canvasWidth(run.text, cssFont(style));
            if (!mixed) return this.textWidth(run.text, style);
            return (
                this.canvasWidth(run.text, cssFont(style, HELVETICA_STACK)) +
                (style.charSpace ?? 0) * [...run.text].length
            );
        });
    }

    /** Width in mm of one line as it will be drawn. */
    measure(line: string, style: PdfTextStyle): number {
        return this.widths(splitTextRuns(line), style).reduce((sum, width) => sum + width, 0);
    }

    /**
     * Wrap text to `maxWidth` mm, as CSS pre-wrap does: newlines are kept,
     * leading spaces of a paragraph are kept, a break eats its spaces, and a
     * word wider than the line breaks between characters (never inside one).
     */
    wrap(text: string, style: PdfTextStyle, maxWidth: number): string[] {
        const lines: string[] = [];
        // A typed CR LF is one line break, and a tab is a space, as HTML had it.
        const normalised = text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
        for (const paragraph of normalised.split('\n')) {
            if (paragraph.trim().length === 0) {
                lines.push('');
                continue;
            }
            const indent = /^ */.exec(paragraph)?.[0] ?? '';
            const tokens = paragraph.slice(indent.length).split(/( +)/).filter(Boolean);
            let current = indent;
            let hasWord = false;
            const fits = (candidate: string) => this.measure(candidate, style) <= maxWidth;
            for (const token of tokens) {
                if (token.startsWith(' ')) {
                    // Spaces at a break hang off the line and are not carried over.
                    if (hasWord) current += token;
                    continue;
                }
                if (fits(current + token)) {
                    current += token;
                    hasWord = true;
                    continue;
                }
                if (hasWord) {
                    lines.push(current.trimEnd());
                    current = '';
                    hasWord = false;
                    if (fits(token)) {
                        current = token;
                        hasWord = true;
                        continue;
                    }
                }
                // A word wider than the whole line breaks between graphemes.
                for (const grapheme of graphemes(token)) {
                    if (hasWord && !fits(current + grapheme)) {
                        lines.push(current.trimEnd());
                        current = '';
                    }
                    current += grapheme;
                    hasWord = true;
                }
            }
            lines.push(current.trimEnd());
        }
        return lines;
    }

    private picture(run: PdfTextRun, style: PdfTextStyle): Picture {
        const key = `${cssFont(style)}|${style.color ?? ''}|${run.text}`;
        const cached = this.pictures.get(key);
        if (cached) return cached;
        const ctx = this.ctx();
        const canvas = this.canvas as HTMLCanvasElement;
        const font = cssFont(style);
        const fontPx = style.size * PX_PER_PT;
        ctx.font = font;
        // Always a left-to-right paragraph, never inherited from the page: the
        // brief is one, and the bidi algorithm orders any right-to-left text
        // inside it.
        ctx.direction = 'ltr';
        const canvasText = bidiCanvasText(run.text);
        const metrics = ctx.measureText(canvasText);
        // Room for accents above, descenders and marks below (Thai, Arabic),
        // and glyphs that overhang their advance.
        const ascentPx =
            Math.ceil(
                Math.max(fontPx * 1.1, metrics.actualBoundingBoxAscent || 0, metrics.fontBoundingBoxAscent || 0),
            ) + 2;
        const descentPx =
            Math.ceil(
                Math.max(fontPx * 0.4, metrics.actualBoundingBoxDescent || 0, metrics.fontBoundingBoxDescent || 0),
            ) + 2;
        const padPx = Math.ceil(fontPx * 0.15);
        canvas.width = Math.max(1, Math.ceil(metrics.width) + padPx * 2);
        canvas.height = ascentPx + descentPx;
        // Resizing resets the context.
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = font;
        ctx.direction = 'ltr';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = `#${hexRgb(style.color)
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')}`;
        ctx.fillText(canvasText, padPx, ascentPx);
        const picture: Picture = {
            dataUrl: canvas.toDataURL('image/png'),
            alias: `run${this.pictures.size}`,
            left: -padPx / PX_PER_MM,
            ascent: ascentPx / PX_PER_MM,
            width: canvas.width / PX_PER_MM,
            height: canvas.height / PX_PER_MM,
        };
        this.pictures.set(key, picture);
        return picture;
    }

    /**
     * Draw one line with its baseline at `y`. `x` is the left edge, the centre
     * or the right edge, by `align`. Returns the drawn width in mm.
     */
    draw(line: string, x: number, y: number, style: PdfTextStyle, align: 'left' | 'center' | 'right' = 'left'): number {
        const runs = splitTextRuns(line);
        const widths = this.widths(runs, style);
        const total = widths.reduce((sum, width) => sum + width, 0);
        let pen = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
        runs.forEach((run, index) => {
            if (run.encodable) {
                this.setFont(style);
                this.doc.setTextColor(...hexRgb(style.color));
                this.doc.text(run.text, pen, y, {
                    baseline: 'alphabetic',
                    ...(style.charSpace ? { charSpace: style.charSpace } : {}),
                });
            } else {
                const picture = this.picture(run, style);
                this.doc.addImage(
                    picture.dataUrl,
                    'PNG',
                    pen + picture.left,
                    y - picture.ascent,
                    picture.width,
                    picture.height,
                    picture.alias,
                    'FAST',
                );
            }
            pen += widths[index];
        });
        return total;
    }
}

/**
 * Hand a finished PDF to the share sheet (email, WhatsApp, Files), or download
 * it where there is no share sheet. A dismissed share sheet is a decision, not
 * a failure: it returns quietly.
 */
export async function sharePdfFile(blob: Blob, filename: string, title: string): Promise<void> {
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
        try {
            await navigator.share({ title, files: [file] });
            return;
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return;
            // Anything else falls through to a download.
        }
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}
