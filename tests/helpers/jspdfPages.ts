/**
 * jspdfPages — read back what a jsPDF document drew, page by page.
 *
 * jsPDF writes its content streams uncompressed, so the text is there to read:
 * every `x y Td (string) Tj` is one run of selectable text, and every
 * `w 0 0 h x y cm /I0 Do` is a placed image (a canvas-drawn run). Positions
 * come back in mm from the top-left corner of an A4 page.
 *
 * installFakeCanvas() stands in for the browser canvas jsdom does not have. It
 * records every fillText (with its direction, font and colour), so a test can
 * prove a non-Latin run was drawn, and in which reading direction.
 */
import { vi } from 'vitest';
import type { jsPDF } from 'jspdf';

const PT_MM = 25.4 / 72;
const PAGE_HEIGHT_MM = 297;

/** WinAnsi's 0x80-0x9F block, back to Unicode. */
const WIN_ANSI_80 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

export interface PdfTextItem {
    text: string;
    /** mm from the left edge. */
    x: number;
    /** mm from the top edge, at the baseline. */
    y: number;
    /** The string was written as two-byte codes: mojibake in a WinAnsi font. */
    garbled: boolean;
    /** The font resource it was set in ('F1' Helvetica, 'F2' Helvetica-Bold, ...). */
    font: string;
    /** Font size in points. */
    size: number;
    /** Letter spacing (Tc) in mm. */
    charSpace: number;
}

export interface PdfImageItem {
    x: number;
    /** mm from the top edge to the image's top. */
    top: number;
    width: number;
    height: number;
}

export interface PdfPage {
    texts: PdfTextItem[];
    images: PdfImageItem[];
    /** Every y of a drawn line or rectangle edge, in mm from the top. */
    ruleYs: number[];
}

function unescapePdfString(raw: string): string {
    return raw.replace(/\\([()\\nrtbf]|[0-7]{1,3})/g, (_, escape: string) => {
        if (/^[0-7]+$/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
        return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[escape] ?? escape;
    });
}

function decodeWinAnsi(bytes: string): string {
    return Array.from(bytes, (char) => {
        const code = char.charCodeAt(0);
        return code >= 0x80 && code <= 0x9f ? WIN_ANSI_80[code - 0x80] : char;
    }).join('');
}

/** What each page of the document draws. */
export function readPages(doc: jsPDF): PdfPage[] {
    const internal = (doc as unknown as { internal: { pages: string[][] } }).internal;
    const pages: PdfPage[] = [];
    for (let index = 1; index <= doc.getNumberOfPages(); index++) {
        const stream = internal.pages[index].join('\n');
        const texts: PdfTextItem[] = [];
        // Font and letter spacing are text state: they hold until set again.
        let font = '';
        let size = 0;
        let charSpace = 0;
        for (const match of stream.matchAll(
            /\/(F\d+) ([-\d.]+) Tf\n|([-\d.]+) Tc\n|([-\d.]+) ([-\d.]+) Td\n\(((?:\\.|[^\\)])*)\) Tj/g,
        )) {
            if (match[1]) {
                font = match[1];
                size = Number(match[2]);
                continue;
            }
            if (match[3]) {
                charSpace = Number(match[3]) * PT_MM;
                continue;
            }
            const raw = unescapePdfString(match[6]);
            // A NUL byte or a code above 0xFF: jsPDF's two-byte form of the string.
            const garbled = Array.from(raw).some((char) => char.charCodeAt(0) === 0 || char.charCodeAt(0) > 0xff);
            texts.push({
                text: decodeWinAnsi(raw),
                x: Number(match[4]) * PT_MM,
                y: PAGE_HEIGHT_MM - Number(match[5]) * PT_MM,
                garbled,
                font,
                size,
                charSpace,
            });
        }
        const images: PdfImageItem[] = [];
        for (const match of stream.matchAll(/([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\n\/I\d+ Do/g)) {
            const width = Number(match[1]) * PT_MM;
            const height = Number(match[2]) * PT_MM;
            const x = Number(match[3]) * PT_MM;
            const bottom = PAGE_HEIGHT_MM - Number(match[4]) * PT_MM;
            images.push({ x, top: bottom - height, width, height });
        }
        const ruleYs: number[] = [];
        for (const match of stream.matchAll(/([-\d.]+) ([-\d.]+) [ml]\n/g)) {
            ruleYs.push(PAGE_HEIGHT_MM - Number(match[2]) * PT_MM);
        }
        for (const match of stream.matchAll(/[-\d.]+ ([-\d.]+) [-\d.]+ ([-\d.]+) re\n/g)) {
            const y = PAGE_HEIGHT_MM - Number(match[1]) * PT_MM;
            ruleYs.push(y, y - Number(match[2]) * PT_MM);
        }
        pages.push({ texts, images, ruleYs });
    }
    return pages;
}

/**
 * Where a text item ends on the right, in mm from the left edge, measured with
 * jsPDF's own Helvetica widths at the item's font, size and letter spacing:
 * independent of the layout code that placed it.
 */
export function textRight(doc: jsPDF, item: PdfTextItem): number {
    const internal = doc.internal as unknown as { getFont: (name: string, style: string) => { id: string } };
    const [fontName, fontStyle] = Object.entries(doc.getFontList())
        .flatMap(([name, styles]) => styles.map((style) => [name, style] as const))
        .find(([name, style]) => internal.getFont(name, style).id === item.font) ?? ['helvetica', 'normal'];
    const before = doc.getFont();
    const beforeSize = doc.getFontSize();
    doc.setFont(fontName, fontStyle);
    doc.setFontSize(item.size);
    const width = doc.getTextWidth(item.text) + item.charSpace * [...item.text].length;
    doc.setFont(before.fontName, before.fontStyle);
    doc.setFontSize(beforeSize);
    return item.x + width;
}

/** A page's selectable text, one entry per drawn line (runs on one baseline joined). */
export function pageLines(page: PdfPage): string[] {
    const lines: { y: number; parts: PdfTextItem[] }[] = [];
    for (const item of page.texts) {
        const line = lines.find((candidate) => Math.abs(candidate.y - item.y) < 0.3);
        if (line) line.parts.push(item);
        else lines.push({ y: item.y, parts: [item] });
    }
    return lines
        .sort((a, b) => a.y - b.y)
        .map((line) =>
            line.parts
                .sort((a, b) => a.x - b.x)
                .map((part) => part.text)
                .join(''),
        );
}

export interface CanvasDraw {
    text: string;
    direction: string;
    font: string;
    fillStyle: string;
}

// A real 1 x 1 PNG, so jsPDF's PNG decoder has something genuine to read.
const PIXEL_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A canvas for jsdom: measures every character at 0.55 em and records fillText. */
export function installFakeCanvas(): { draws: CanvasDraw[]; restore: () => void } {
    const draws: CanvasDraw[] = [];
    const fontPx = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
    const context = {
        font: '10px sans-serif',
        direction: 'ltr',
        fillStyle: '#000000',
        textAlign: 'start',
        textBaseline: 'alphabetic',
        measureText(text: string) {
            const px = fontPx(this.font);
            return {
                width: [...text].length * px * 0.55,
                actualBoundingBoxAscent: px * 0.8,
                actualBoundingBoxDescent: px * 0.2,
                fontBoundingBoxAscent: px * 0.9,
                fontBoundingBoxDescent: px * 0.25,
            };
        },
        fillText(text: string) {
            draws.push({ text, direction: this.direction, font: this.font, fillStyle: String(this.fillStyle) });
        },
        clearRect() {},
    };
    const getContext = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockImplementation(() => context as unknown as CanvasRenderingContext2D);
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => PIXEL_PNG);
    return {
        draws,
        restore: () => {
            getContext.mockRestore();
            toDataURL.mockRestore();
        },
    };
}
