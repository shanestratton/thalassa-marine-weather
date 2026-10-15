/**
 * MaintenancePdfService — PDF export for vessel maintenance.
 *
 * Two templates:
 *   A) Engine Room Clipboard: blank checklist of active/upcoming tasks
 *   B) Formal Service Record: completed history ledger
 *
 * Drawn with jsPDF primitives (129-10): text, rules, filled rows and the
 * shapes of the checkbox and status dot, with services/pdf/pdfText.ts printing
 * any script.
 *
 * These used to be HTML pages put through jsPDF's html() (html2canvas + DOMPurify,
 * about 230 KB). DOMPurify returned only the <body>, so the stylesheet in
 * <head> never applied: the PDFs came out in Times with no header colour or
 * table rules, and the emoji (⚓, 📋, the status dots, the checkbox) printed as
 * garbage. The layout below is the one that stylesheet described, in the same
 * sizes (the page was 800 CSS px across A4).
 *
 * 130-B8: printed from the rows R&M has on the phone, which the caller passes
 * in; they were fetched from the server, so offline at sea the PDFs came out
 * blank. With no rows nothing is made ('empty'). Shared through sharePdfBlob
 * (the share sheet in the iPhone app); dates are the phone's own
 * (services/pdf/pdfDates.ts); the headings carry no emoji; a cost prints as
 * the figure typed, with no '$' the app never asked for.
 */
import type { jsPDF } from 'jspdf';
import { calculateStatus, sortByUrgency, type TaskWithStatus, type TrafficLight } from './MaintenanceService';
import type { MaintenanceTask, MaintenanceHistory } from '../types';
import { PdfTextWriter, PT_MM, type PdfTextStyle } from './pdf/pdfText';
import { pdfFileDay, pdfLongDate, pdfShortDate } from './pdf/pdfDates';
import { sharePdfBlob, shareTitle, type ShareOutcome } from '../utils/sharePdf';

// ── Shared Helpers ──────────────────────────────────────────────

/**
 * A cost as the figure typed, in the phone's number style: the records carry
 * no currency, so the PDF claims none ('$' read as US dollars to anyone else).
 */
function formatCost(val: number | null): string {
    if (val === null || val === undefined || val === 0) return '—';
    return val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── TEMPLATE A: Engine Room Clipboard ───────────────────────────

/**
 * The clipboard's Due column: hours for an hour task, else the date. A due
 * still counted from zero (hoursUnanchored) prints no figure, as the card shows
 * none: '100 hrs' beside a 3,512 reading would read as the schedule.
 */
export function clipboardDueText(task: TaskWithStatus): string {
    if (task.trigger_type === 'engine_hours') {
        const hours = task.next_due_hours;
        return hours === null || hours === undefined || task.hoursUnanchored ? '—' : `${hours.toLocaleString()} hrs`;
    }
    return pdfShortDate(task.next_due_date);
}

/** The clipboard's rows, most urgent first. */
function checklistRows(tasks: MaintenanceTask[], engineHours: number | null): TaskWithStatus[] {
    // Engine hours not entered: judge hour-based tasks on their date alone
    // (as the Maintenance screen does) instead of counting from an invented 0.
    return sortByUrgency(
        tasks.map((t) => {
            if (engineHours !== null || t.next_due_hours === null || t.next_due_hours === undefined) {
                return calculateStatus(t, engineHours ?? 0);
            }
            return { ...calculateStatus({ ...t, next_due_hours: null }, 0), next_due_hours: t.next_due_hours };
        }),
    );
}

// ── Page and table drawing ──────────────────────────────────────

type JsPdfConstructor = new (options: { orientation: 'portrait'; unit: 'mm'; format: 'a4' }) => jsPDF;
type Align = 'left' | 'center' | 'right';

/** mm per CSS px of the old 800 px-wide page. */
const PX = 210 / 800;
const MARGIN = 24 * PX;
const WIDTH = 210 - 2 * MARGIN;
const CONTINUED_TOP = 10;
const PAGE_BOTTOM = 297 - 10;
const fontPt = (px: number) => (px * PX) / PT_MM;
const INK = '#1a1a2e';
const BRAND = '#0f4c81';
const LINE_HEIGHT = 1.15;

/** Status dot colours, as the 🔴 🟡 🟢 ⚪ the template asked for. */
const DOT: Record<TrafficLight, string> = { red: '#e0393e', yellow: '#f5c33b', green: '#3bb54a', grey: '#ffffff' };

function rgb(hex: string): [number, number, number] {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function baseline(top: number, lineHeight: number, size: number): number {
    const em = size * PT_MM;
    return top + (lineHeight - em) / 2 + em * 0.77;
}

interface Segment {
    text: string;
    style: PdfTextStyle;
}

interface Cell {
    text?: string;
    style?: PdfTextStyle;
    align?: Align;
    /** Drawn in the cell: the header's tick, the tick box, or the status dot before the text. */
    lead?: { kind: 'tick' } | { kind: 'checkbox' } | { kind: 'dot'; status: TrafficLight };
    /** The blank "write it here" line of the Notes column. */
    writeLine?: boolean;
    /** Columns this cell spans (the total row's label). */
    span?: number;
}

interface Row {
    cells: Cell[];
    fill?: string;
}

interface Column {
    width: number;
}

const CELL_PAD_X = 6 * PX;
const CELL_PAD_Y = 8 * PX;

class MaintenancePage {
    readonly doc: jsPDF;
    readonly writer: PdfTextWriter;
    y = MARGIN;

    constructor(JsPdf: JsPdfConstructor) {
        this.doc = new JsPdf({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        this.writer = new PdfTextWriter(this.doc);
    }

    room(): number {
        return PAGE_BOTTOM - this.y;
    }

    newPage(): void {
        this.doc.addPage();
        this.y = CONTINUED_TOP;
    }

    /** One line of mixed bold and regular text, wrapped at `width` from `x`. */
    rich(segments: Segment[], x: number, width: number, lineHeight: number, size: number): void {
        const words: Segment[] = [];
        for (const segment of segments) {
            for (const piece of segment.text.split(/( +)/).filter(Boolean)) {
                // A word wider than the line (a long name with no spaces) breaks
                // between its characters rather than running off the page.
                const pieces = /^ +$/.test(piece) ? [piece] : this.writer.wrap(piece, segment.style, width);
                for (const part of pieces) words.push({ text: part, style: segment.style });
            }
        }
        const lines: Segment[][] = [[]];
        let used = 0;
        for (const word of words) {
            const blank = /^ +$/.test(word.text);
            const wordWidth = this.writer.measure(word.text, word.style);
            const line = lines[lines.length - 1];
            if (!blank && line.length > 0 && used + wordWidth > width) {
                while (line.length > 0 && /^ +$/.test(line[line.length - 1].text)) line.pop();
                lines.push([word]);
                used = wordWidth;
                continue;
            }
            if (blank && line.length === 0) continue;
            line.push(word);
            used += wordWidth;
        }
        for (const line of lines) {
            // Words of one style draw as one run, so a right-to-left name is one
            // picture that the bidi algorithm puts in reading order.
            const runs: Segment[] = [];
            for (const word of line) {
                const last = runs[runs.length - 1];
                if (last && last.style === word.style) last.text += word.text;
                else runs.push({ ...word });
            }
            let pen = x;
            const y = baseline(this.y, lineHeight, size);
            for (const run of runs) pen += this.writer.draw(run.text, pen, y, run.style);
            this.y += lineHeight;
        }
    }

    /** The page heading: title, the vessel line, a rule in the brand colour. */
    heading(title: string, meta: Segment[]): void {
        const h1: PdfTextStyle = { size: fontPt(18), bold: true, color: BRAND, charSpace: 0.9 * PX };
        for (const line of this.writer.wrap(title, h1, WIDTH)) {
            this.writer.draw(line, MARGIN, baseline(this.y, 18 * LINE_HEIGHT * PX, h1.size), h1);
            this.y += 18 * LINE_HEIGHT * PX;
        }
        this.y += 4 * PX;
        this.rich(meta, MARGIN, WIDTH, 10 * LINE_HEIGHT * PX, fontPt(10));
        this.y += 12 * PX;
        this.doc.setDrawColor(...rgb(BRAND));
        this.doc.setLineWidth(3 * PX);
        this.doc.line(MARGIN, this.y + 1.5 * PX, MARGIN + WIDTH, this.y + 1.5 * PX);
        this.y += 3 * PX + 16 * PX;
    }

    private cellLines(cell: Cell, width: number): string[] {
        if (!cell.text) return [];
        const lead = cell.lead?.kind === 'dot' ? DOT_SIZE + DOT_GAP : 0;
        return this.writer.wrap(cell.text, cell.style ?? BODY_10, width - 2 * CELL_PAD_X - lead);
    }

    private lineHeight(cell: Cell): number {
        return (cell.style ?? BODY_10).size * PT_MM * LINE_HEIGHT;
    }

    /**
     * A table with its header row repeated on every page. A row never splits
     * unless it is taller than a page; then its lines carry over, so nothing
     * runs off the paper.
     */
    table(columns: Column[], header: Cell[], rows: Row[]): void {
        const spanWidth = (start: number, span = 1) =>
            columns.slice(start, start + span).reduce((sum, column) => sum + column.width, 0);
        const layout = (row: Row) => {
            let column = 0;
            return row.cells.map((cell) => {
                const width = spanWidth(column, cell.span);
                const x = MARGIN + spanWidth(0, column);
                column += cell.span ?? 1;
                return { cell, x, width, lines: this.cellLines(cell, width) };
            });
        };
        const contentHeight = (cells: ReturnType<typeof layout>, from: number, count: number) =>
            Math.max(
                0,
                ...cells.map(({ cell, lines }) => {
                    const shown = Math.max(0, Math.min(lines.length - from, count));
                    const lead = from === 0 && cell.lead?.kind === 'checkbox' ? 18 * LINE_HEIGHT * PX : 0;
                    return Math.max(shown * this.lineHeight(cell), lead);
                }),
            );

        const headerCells = layout({ cells: header });
        const drawRow = (
            cells: ReturnType<typeof layout>,
            fill: string | undefined,
            from: number,
            count: number,
            isHeader: boolean,
        ) => {
            const height = contentHeight(cells, from, count) + 2 * CELL_PAD_Y;
            const top = this.y;
            if (fill) {
                this.doc.setFillColor(...rgb(fill));
                this.doc.rect(MARGIN, top, WIDTH, height, 'F');
            }
            for (const { cell, x, width, lines } of cells) {
                const shown = lines.slice(from, from + count);
                const lineHeight = this.lineHeight(cell);
                const style = cell.style ?? BODY_10;
                const textTop = top + (height - shown.length * lineHeight) / 2;
                const lead = cell.lead && from === 0 ? cell.lead : undefined;
                if (lead?.kind === 'checkbox') {
                    const side = 12 * PX;
                    this.doc.setDrawColor(...rgb(INK));
                    this.doc.setLineWidth(0.25);
                    this.doc.rect(x + (width - side) / 2, top + (height - side) / 2, side, side, 'S');
                } else if (lead?.kind === 'tick') {
                    const cx = x + width / 2;
                    const cy = top + height / 2;
                    const s = 1.1;
                    this.doc.setDrawColor(255, 255, 255);
                    this.doc.setLineWidth(0.35);
                    this.doc.line(cx - s, cy, cx - s * 0.3, cy + s * 0.75);
                    this.doc.line(cx - s * 0.3, cy + s * 0.75, cx + s, cy - s * 0.8);
                }
                let textX = x + CELL_PAD_X;
                if (lead?.kind === 'dot') {
                    const first = baseline(textTop, lineHeight, style.size);
                    this.doc.setFillColor(...rgb(DOT[lead.status]));
                    this.doc.setDrawColor(158, 158, 158);
                    this.doc.setLineWidth(0.15);
                    this.doc.circle(
                        textX + DOT_SIZE / 2,
                        first - style.size * PT_MM * 0.35,
                        DOT_SIZE / 2,
                        lead.status === 'grey' ? 'FD' : 'F',
                    );
                    textX += DOT_SIZE + DOT_GAP;
                }
                const align = cell.align ?? 'left';
                const anchor = align === 'center' ? x + width / 2 : align === 'right' ? x + width - CELL_PAD_X : textX;
                shown.forEach((line, index) => {
                    this.writer.draw(
                        line,
                        anchor,
                        baseline(textTop + index * lineHeight, lineHeight, style.size),
                        style,
                        align,
                    );
                });
                if (cell.writeLine) {
                    this.doc.setDrawColor(204, 204, 204);
                    this.doc.setLineWidth(PX);
                    this.doc.line(x, top + height - PX / 2, x + width, top + height - PX / 2);
                }
            }
            if (!isHeader) {
                this.doc.setDrawColor(238, 238, 238);
                this.doc.setLineWidth(PX);
                this.doc.line(MARGIN, top + height - PX / 2, MARGIN + WIDTH, top + height - PX / 2);
            }
            this.y += height;
        };
        const headerHeight = contentHeight(headerCells, 0, Infinity) + 2 * CELL_PAD_Y;
        const drawHeader = () => drawRow(headerCells, BRAND, 0, Infinity, true);
        drawHeader();

        for (const row of rows) {
            const cells = layout(row);
            const total = Math.max(...cells.map(({ lines }) => lines.length), 1);
            const fullHeight = contentHeight(cells, 0, total) + 2 * CELL_PAD_Y;
            const freshRoom = PAGE_BOTTOM - CONTINUED_TOP - headerHeight;
            if (fullHeight > this.room() && (fullHeight <= freshRoom || this.room() < 2 * CELL_PAD_Y + 10)) {
                this.newPage();
                drawHeader();
            }
            // Lines carry over only for a row taller than a whole page.
            let from = 0;
            while (from < total) {
                let count = total - from;
                while (count > 1 && contentHeight(cells, from, count) + 2 * CELL_PAD_Y > this.room()) count--;
                drawRow(cells, row.fill, from, count, false);
                from += count;
                if (from < total) {
                    this.newPage();
                    drawHeader();
                }
            }
        }
    }

    footer(text: string): void {
        const style: PdfTextStyle = { size: fontPt(8), color: '#999999' };
        const height = 24 * PX + PX + 8 * PX + 8 * LINE_HEIGHT * PX;
        if (height > this.room()) this.newPage();
        else this.y += 24 * PX;
        this.doc.setDrawColor(221, 221, 221);
        this.doc.setLineWidth(PX);
        this.doc.line(MARGIN, this.y + PX / 2, MARGIN + WIDTH, this.y + PX / 2);
        this.y += PX + 8 * PX;
        for (const line of this.writer.wrap(text, style, WIDTH)) {
            this.writer.draw(
                line,
                MARGIN + WIDTH / 2,
                baseline(this.y, 8 * LINE_HEIGHT * PX, style.size),
                style,
                'center',
            );
            this.y += 8 * LINE_HEIGHT * PX;
        }
    }
}

const DOT_SIZE = 11 * 0.9 * PX;
const DOT_GAP = 11 * 0.3 * PX;
const BODY_10: PdfTextStyle = { size: fontPt(10), color: INK };
const TITLE_11: PdfTextStyle = { size: fontPt(11), bold: true, color: INK };
const HEAD_9: PdfTextStyle = { size: fontPt(9), bold: true, color: '#ffffff', charSpace: 0.9 * PX };
const ZEBRA = '#f8f9fa';
const META: PdfTextStyle = { size: fontPt(10), color: '#666666' };
const META_BOLD: PdfTextStyle = { ...META, bold: true };

/** The heading's line, after the boat's name in bold; with no name set, no stand-in for it. */
function metaLine(vesselName: string, rest: Segment[]): Segment[] {
    const name = vesselName.trim();
    return name ? [{ text: name, style: META_BOLD }, { text: '  |  ', style: META }, ...rest] : rest;
}

function buildChecklistPdf(
    tasks: MaintenanceTask[],
    engineHours: number | null,
    vesselName: string,
    JsPdf: JsPdfConstructor,
    now = new Date(),
): jsPDF {
    const page = new MaintenancePage(JsPdf);
    const dateStr = pdfLongDate(now);
    page.heading(
        'VESSEL MAINTENANCE CHECKLIST',
        metaLine(vesselName, [
            { text: `${dateStr}  |  Engine Hours: `, style: META },
            { text: engineHours === null ? '—' : engineHours.toLocaleString(), style: META_BOLD },
        ]),
    );

    const columns = [{ width: 32 * PX }, { width: 0 }, { width: 24 }, { width: 58 }];
    columns[1].width = WIDTH - columns[0].width - columns[2].width - columns[3].width;
    page.table(
        columns,
        [
            { lead: { kind: 'tick' } },
            { text: 'TASK', style: HEAD_9 },
            { text: 'NEXT DUE', style: HEAD_9, align: 'center' },
            { text: 'NOTES / HOURS AT COMPLETION', style: HEAD_9 },
        ],
        checklistRows(tasks, engineHours).map((task, index) => ({
            fill: index % 2 === 1 ? ZEBRA : undefined,
            cells: [
                { lead: { kind: 'checkbox' } },
                { text: task.title, style: TITLE_11, lead: { kind: 'dot', status: task.status } },
                { text: clipboardDueText(task), style: BODY_10, align: 'center' },
                { writeLine: true },
            ],
        })),
    );
    page.footer(`Generated by Thalassa Marine Weather — ${dateStr}`);
    return page.doc;
}

// ── TEMPLATE B: Formal Service Record ───────────────────────────

type HistoryEntry = MaintenanceHistory & { taskTitle?: string; taskCategory?: string };

function buildServiceHistoryPdf(
    history: HistoryEntry[],
    vesselName: string,
    JsPdf: JsPdfConstructor,
    now = new Date(),
): jsPDF {
    const page = new MaintenancePage(JsPdf);
    const dateStr = pdfLongDate(now);
    page.heading(
        'VESSEL SERVICE HISTORY',
        metaLine(vesselName, [
            { text: `Generated: ${dateStr}  |  Entries: `, style: META },
            { text: String(history.length), style: META_BOLD },
        ]),
    );

    // The cost column only when a record has a cost: the log sheet asks for
    // none, so most records carry none, and an empty column took the notes'
    // room.
    const totalCost = history.reduce((sum, h) => sum + (h.cost || 0), 0);
    const withCost = history.some((h) => !!h.cost);
    const columns = [{ width: 24 }, { width: 50 }, { width: 20 }, { width: 0 }, ...(withCost ? [{ width: 24 }] : [])];
    columns[3].width = WIDTH - columns.reduce((sum, column) => sum + column.width, 0);
    const rows: Row[] = history.map((h, index) => ({
        fill: index % 2 === 1 ? ZEBRA : undefined,
        cells: [
            { text: pdfShortDate(h.completed_at), style: BODY_10 },
            { text: h.taskTitle || 'Unknown Task', style: TITLE_11 },
            { text: h.engine_hours_at_service?.toLocaleString() ?? '—', style: BODY_10, align: 'center' },
            { text: h.notes || '—', style: BODY_10 },
            ...(withCost ? [{ text: formatCost(h.cost), style: BODY_10, align: 'right' as const }] : []),
        ],
    }));
    if (withCost && totalCost > 0) {
        const bold: PdfTextStyle = { size: fontPt(11), bold: true, color: INK };
        rows.push({
            fill: '#e3f2fd',
            cells: [
                { text: 'TOTAL EXPENDITURE', style: bold, align: 'right', span: 4 },
                { text: formatCost(totalCost), style: bold, align: 'right' },
            ],
        });
    }
    page.table(
        columns,
        [
            { text: 'DATE COMPLETED', style: HEAD_9 },
            { text: 'TASK PERFORMED', style: HEAD_9 },
            { text: 'ENGINE HRS', style: HEAD_9, align: 'center' },
            { text: 'NOTES / CONDITION', style: HEAD_9 },
            ...(withCost ? [{ text: 'COST', style: HEAD_9, align: 'right' as const }] : []),
        ],
        rows,
    );
    page.footer(`Generated by Thalassa Marine Weather — ${dateStr}`);
    return page.doc;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Share or save the blank checklist (Template A), for printing and taking to
 * the engine room: the active tasks R&M has on this phone, most urgent first.
 * 'empty' with none: no blank checklist goes out.
 */
export async function exportChecklist(
    tasks: MaintenanceTask[],
    engineHours: number | null,
    vesselName: string,
): Promise<ShareOutcome | 'empty'> {
    // A paused task is never due, so it has no place on the clipboard.
    const active = tasks.filter((task) => task.is_active);
    if (active.length === 0) return 'empty';
    const now = new Date();
    const { default: JsPdf } = await import('jspdf');
    const doc = buildChecklistPdf(active, engineHours, vesselName, JsPdf, now);
    return sharePdfBlob(
        doc.output('blob'),
        `Maintenance_Checklist_${pdfFileDay(now)}.pdf`,
        shareTitle('Maintenance checklist', vesselName),
    );
}

/**
 * Share or save the service history (Template B), the ledger of completed
 * work: every record R&M has on this phone, newest first, with its task's
 * title (`tasks`, paused ones included). 'empty' with no records.
 */
export async function exportServiceHistory(
    history: MaintenanceHistory[],
    tasks: MaintenanceTask[],
    vesselName: string,
): Promise<ShareOutcome | 'empty'> {
    if (history.length === 0) return 'empty';
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const enriched = [...history]
        .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at))
        .map((h) => ({
            ...h,
            taskTitle: taskMap.get(h.task_id)?.title,
            taskCategory: taskMap.get(h.task_id)?.category,
        }));

    const now = new Date();
    const { default: JsPdf } = await import('jspdf');
    const doc = buildServiceHistoryPdf(enriched, vesselName, JsPdf, now);
    return sharePdfBlob(
        doc.output('blob'),
        `Service_History_${pdfFileDay(now)}.pdf`,
        shareTitle('Service history', vesselName),
    );
}

export const __testing = { buildChecklistPdf, buildServiceHistoryPdf, checklistRows, PAGE_BOTTOM, CONTINUED_TOP };
