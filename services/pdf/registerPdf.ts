/**
 * registerPdf — the page the Stores and Equipment PDFs are drawn on (130-B8).
 *
 * A navy band with the title and the boat's line, then one table per
 * category with its column header repeated on every page, and a footer with
 * the page count. The look is the one both files drew by hand before.
 *
 * Every word goes through PdfTextWriter (services/pdf/pdfText.ts), so an item
 * named in Greek or Japanese prints, and a cell wraps onto more lines rather
 * than cutting a name short: the old tables cut names at 30-odd characters
 * without a mark, and printed emoji and any non-Latin name as garbage.
 */
import type { jsPDF } from 'jspdf';
import { PdfTextWriter, PT_MM, type PdfTextStyle } from './pdfText';

export type JsPdfConstructor = new (options: { orientation: 'portrait'; unit: 'mm'; format: 'a4' }) => jsPDF;

const W = 210;
const H = 297;
const M = 15;
/** The content width, and the width every table's columns add up to. */
export const REGISTER_WIDTH = W - M * 2;
/** Rows stop here; the footer sits below. */
const PAGE_BOTTOM = H - M;
const CONTINUED_TOP = M + 10;

export const REGISTER_COLOURS = {
    navy: '#1a2a3a',
    gold: '#c9a227',
    body: '#282828',
    muted: '#a0a0a0',
    red: '#dc2626',
    amber: '#d97706',
    green: '#16a34a',
} as const;
const RULE_BLUE: [number, number, number] = [3, 105, 161];
const ZEBRA: [number, number, number] = [245, 247, 250];

const CELL_PAD = 2;
const ROW_HEIGHT = 6.5;
const FIRST_BASELINE = 4.5;
const CELL_SIZE = 7.5;
/** Each wrapped line after a cell's first. */
const CELL_LINE = CELL_SIZE * PT_MM * 1.2;
const HEADER_HEIGHT = 7;
const SECTION_HEADING = 8;
const TAG_GAP = 1;

export interface RegisterColumn {
    label: string;
    width: number;
}

export interface RegisterCell {
    text: string;
    color?: string;
    bold?: boolean;
    /** A short word after the text in its own colour (Stores' LOW). */
    tag?: { text: string; color: string };
}

export interface BandLine {
    text: string;
    size: number;
    color: string;
}

function rgb(hex: string): [number, number, number] {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

interface LaidCell {
    cell: RegisterCell;
    x: number;
    width: number;
    style: PdfTextStyle;
    lines: string[];
    /** The line the tag goes on, beside its text or on a line of its own. */
    tagLine: number;
}

export class RegisterPdf {
    readonly doc: jsPDF;
    readonly writer: PdfTextWriter;
    private y = M;

    constructor(JsPdf: JsPdfConstructor) {
        this.doc = new JsPdf({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        this.writer = new PdfTextWriter(this.doc);
    }

    /**
     * The navy band: the title, then each group of lines below it, wrapped
     * and centred. It grows to fit, so a long list of categories or a long
     * boat name stays on the paper.
     */
    band(title: string, groups: BandLine[], minHeight: number): void {
        const centre = W / 2;
        const lines: { text: string; style: PdfTextStyle; baseline: number }[] = [];
        let baseline = 30;
        groups.forEach((group, index) => {
            if (index > 0) baseline += 8;
            const style: PdfTextStyle = { size: group.size, color: group.color };
            this.writer.wrap(group.text, style, REGISTER_WIDTH).forEach((line, at) => {
                if (at > 0) baseline += group.size * PT_MM * 1.3;
                lines.push({ text: line, style, baseline });
            });
        });
        const height = Math.max(minHeight, baseline + 7);
        this.doc.setFillColor(...rgb(REGISTER_COLOURS.navy));
        this.doc.rect(0, 0, W, height, 'F');
        this.doc.setDrawColor(...rgb(REGISTER_COLOURS.gold));
        this.doc.setLineWidth(1.5);
        this.doc.line(M + 20, height - 2, W - M - 20, height - 2);
        this.writer.draw(title, centre, 18, { size: 20, bold: true, color: '#ffffff' }, 'center');
        for (const line of lines) this.writer.draw(line.text, centre, line.baseline, line.style, 'center');
        this.y = height + 10;
    }

    /** Stores' three totals, side by side. */
    boxes(boxes: { label: string; value: string; color: string }[]): void {
        const gap = 3;
        const width = (REGISTER_WIDTH - gap * (boxes.length - 1)) / boxes.length;
        const height = 16;
        boxes.forEach((box, index) => {
            const x = M + index * (width + gap);
            this.doc.setDrawColor(200, 200, 200);
            this.doc.setLineWidth(0.3);
            this.doc.roundedRect(x, this.y, width, height, 2, 2, 'S');
            this.writer.draw(box.label, x + 4, this.y + 5, { size: 7, color: '#787878' });
            this.writer.draw(box.value, x + 4, this.y + 13, { size: 14, bold: true, color: box.color });
        });
        this.y += height + 8;
    }

    private layout(columns: RegisterColumn[], cells: RegisterCell[]): LaidCell[] {
        let x = M;
        return columns.map((column, index) => {
            const cell = cells[index] ?? { text: '' };
            const style: PdfTextStyle = {
                size: CELL_SIZE,
                bold: cell.bold,
                color: cell.color ?? REGISTER_COLOURS.body,
            };
            const width = column.width - CELL_PAD * 2;
            const lines = cell.text ? this.writer.wrap(cell.text, style, width) : [];
            let tagLine = Math.max(0, lines.length - 1);
            if (cell.tag) {
                const last = lines[tagLine] ?? '';
                const room = width - (last ? this.writer.measure(last, style) + TAG_GAP : 0);
                if (this.writer.measure(cell.tag.text, tagStyle(cell.tag.color)) > room) tagLine = lines.length;
            }
            const laid = { cell, x, width: column.width, style, lines, tagLine };
            x += column.width;
            return laid;
        });
    }

    private lineCount(cells: LaidCell[]): number {
        return Math.max(1, ...cells.map((cell) => Math.max(cell.lines.length, cell.cell.tag ? cell.tagLine + 1 : 0)));
    }

    private tableHeader(columns: RegisterColumn[]): void {
        this.doc.setFillColor(...rgb(REGISTER_COLOURS.navy));
        this.doc.rect(M, this.y, REGISTER_WIDTH, HEADER_HEIGHT, 'F');
        let x = M;
        const style: PdfTextStyle = { size: 6.5, bold: true, color: '#ffffff' };
        for (const column of columns) {
            this.writer.draw(column.label, x + CELL_PAD, this.y + 5, style);
            x += column.width;
        }
        this.y += HEADER_HEIGHT;
    }

    private newPage(columns: RegisterColumn[]): void {
        this.doc.addPage();
        this.y = CONTINUED_TOP;
        this.tableHeader(columns);
    }

    /** Lines `from` .. `from + count` of a row, `fill` behind them. */
    private drawRow(cells: LaidCell[], from: number, count: number, fill: boolean): void {
        const height = ROW_HEIGHT + (count - 1) * CELL_LINE;
        if (fill) {
            this.doc.setFillColor(...ZEBRA);
            this.doc.rect(M, this.y, REGISTER_WIDTH, height, 'F');
        }
        for (const { cell, x, style, lines, tagLine } of cells) {
            for (let index = from; index < from + count; index++) {
                const baseline = this.y + FIRST_BASELINE + (index - from) * CELL_LINE;
                const line = lines[index];
                const drawn = line ? this.writer.draw(line, x + CELL_PAD, baseline, style) : 0;
                if (cell.tag && index === tagLine) {
                    const at = x + CELL_PAD + (drawn ? drawn + TAG_GAP : 0);
                    this.writer.draw(cell.tag.text, at, baseline, tagStyle(cell.tag.color));
                }
            }
        }
        this.y += height;
    }

    /**
     * A category: its heading, then its rows under a column header. The
     * heading never sits alone at the foot of a page; a row never splits
     * unless it is taller than a page, and then its lines carry over.
     */
    section(title: string, columns: RegisterColumn[], rows: RegisterCell[][]): void {
        const laid = rows.map((row) => this.layout(columns, row));
        const rowHeight = (cells: LaidCell[]) => ROW_HEIGHT + (this.lineCount(cells) - 1) * CELL_LINE;
        const freshRoom = PAGE_BOTTOM - CONTINUED_TOP - HEADER_HEIGHT;
        const firstRow = laid.length > 0 ? Math.min(rowHeight(laid[0]), freshRoom) : 0;
        if (this.y + SECTION_HEADING + HEADER_HEIGHT + firstRow > PAGE_BOTTOM) {
            this.doc.addPage();
            this.y = CONTINUED_TOP;
        }

        this.writer.draw(title.toUpperCase(), M, this.y, { size: 12, bold: true, color: REGISTER_COLOURS.navy });
        this.doc.setDrawColor(...RULE_BLUE);
        this.doc.setLineWidth(0.8);
        this.doc.line(M, this.y + 2, M + REGISTER_WIDTH, this.y + 2);
        this.y += SECTION_HEADING;
        this.tableHeader(columns);

        laid.forEach((cells, index) => {
            const total = this.lineCount(cells);
            const fill = index % 2 === 0;
            if (this.y + rowHeight(cells) > PAGE_BOTTOM && rowHeight(cells) <= freshRoom) this.newPage(columns);
            let from = 0;
            while (from < total) {
                // Lines of this row that fit above the page's foot.
                const room = Math.floor((PAGE_BOTTOM - this.y - ROW_HEIGHT) / CELL_LINE + 1e-6) + 1;
                if (room < 1) {
                    this.newPage(columns);
                    continue;
                }
                const count = Math.min(total - from, room);
                this.drawRow(cells, from, count, fill);
                from += count;
                if (from < total) this.newPage(columns);
            }
        });
        this.y += 6;
    }

    /** "Generated by Thalassa Marine Weather | date | Page n of N" on every page. */
    finish(dateLabel: string): jsPDF {
        const pages = this.doc.getNumberOfPages();
        const style: PdfTextStyle = { size: 7, color: REGISTER_COLOURS.muted };
        for (let page = 1; page <= pages; page++) {
            this.doc.setPage(page);
            this.writer.draw(
                `Generated by Thalassa Marine Weather | ${dateLabel} | Page ${page} of ${pages}`,
                W / 2,
                H - 8,
                style,
                'center',
            );
        }
        return this.doc;
    }
}

function tagStyle(color: string): PdfTextStyle {
    return { size: 5.5, bold: true, color };
}

export const __testing = { PAGE_BOTTOM, CONTINUED_TOP, M };
