import type { jsPDF } from 'jspdf';
import {
    createFloatPlanSharePayload,
    FLOAT_PLAN_GUIDE_HEADING,
    prepareFloatPlan,
    type FloatPlanInput,
} from './floatPlan';
import { PdfTextWriter, PT_MM, sharePdfFile, type PdfTextStyle } from './pdf/pdfText';

/**
 * The float plan as a PDF, for a shore contact who wants a document.
 *
 * Not everyone is comfortable with a link, and a printed page on the fridge
 * still works when the holder's phone is flat and the boat is overdue. So the
 * PDF is a first-class delivery, not a fallback.
 *
 * It prints the EMAIL brief rather than composing its own content. That text
 * is already the considered version, and a second formatter would drift from
 * it — the two would disagree eventually, and the safety document is the wrong
 * place to discover which one is stale.
 *
 * Drawn with jsPDF primitives (129-10). It used to be an HTML page put through
 * jsPDF's html(), which needed html2canvas and DOMPurify (about 230 KB of the app)
 * and printed through the same WinAnsi fonts anyway: "→", the "─" rules and
 * every non-Latin name came out as garbage, and page breaks ran text to the
 * paper's edge. The layout below keeps the old page's sizes (the HTML was 800
 * CSS px across A4), and services/pdf/pdfText.ts prints any script.
 */

type JsPdfConstructor = new (options: { orientation: 'portrait'; unit: 'mm'; format: 'a4' }) => jsPDF;

/** mm per CSS px of the old 800 px-wide page. */
const PX = 210 / 800;
const LEFT = 28 * PX;
const WIDTH = 740 * PX;
const PAGE_TOP = 24 * PX;
/** Later pages start, and every page stops, clear of a printer's margin. */
const CONTINUED_TOP = 10;
const PAGE_BOTTOM = 297 - 10;
/** Blocks this short never split across pages; longer ones keep two lines each side. */
const KEEP_TOGETHER_LINES = 6;

const fontPt = (px: number) => (px * PX) / PT_MM;
const BODY: PdfTextStyle = { size: fontPt(12), color: '#111111' };
const BODY_LINE = 18 * PX;
const RULE = /^─+$/;

/** Baseline of a line box `lineHeight` tall starting at `top`, for a font `size` pt. */
function baseline(top: number, lineHeight: number, size: number): number {
    const em = size * PT_MM;
    return top + (lineHeight - em) / 2 + em * 0.77;
}

interface Block {
    kind: 'text' | 'rule' | 'gap';
    /** One entry per line of the brief: the lines it wrapped to. */
    lines: string[][];
}

/** The brief as blocks: runs of text lines, rules, and the blank lines between. */
function briefBlocks(writer: PdfTextWriter, text: string): Block[] {
    const blocks: Block[] = [];
    for (const raw of text.split('\n')) {
        if (raw.trim().length === 0) {
            blocks.push({ kind: 'gap', lines: [] });
        } else if (RULE.test(raw.trim())) {
            blocks.push({ kind: 'rule', lines: [] });
        } else {
            const last = blocks[blocks.length - 1];
            const wrapped = writer.wrap(raw, BODY, WIDTH);
            if (last?.kind === 'text') last.lines.push(wrapped);
            else blocks.push({ kind: 'text', lines: [wrapped] });
        }
    }
    return blocks;
}

const lineCount = (groups: string[][]) => groups.reduce((sum, group) => sum + group.length, 0);

function blockHeight(block: Block): number {
    return block.kind === 'text' ? lineCount(block.lines) * BODY_LINE : BODY_LINE;
}

function buildFloatPlanPdf(input: FloatPlanInput, JsPdf: JsPdfConstructor): { doc: jsPDF; filename: string } {
    const payload = createFloatPlanSharePayload(input, 'email');
    const headline = prepareFloatPlan(input);
    const filename = `Float plan - ${headline.vesselName}`.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'Float plan';

    const doc = new JsPdf({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const writer = new PdfTextWriter(doc);
    let y = PAGE_TOP;
    let pageTop = PAGE_TOP;
    const newPage = () => {
        doc.addPage();
        y = CONTINUED_TOP;
        pageTop = CONTINUED_TOP;
    };
    const room = () => PAGE_BOTTOM - y;

    // ── Header: what the document is, and whose boat ───────────────────────
    const label: PdfTextStyle = { size: fontPt(11), color: '#555555', charSpace: 2 * PX };
    writer.draw('FLOAT PLAN', LEFT, baseline(y, 11 * 1.15 * PX, label.size), label);
    y += 11 * 1.15 * PX + 2 * PX;
    const nameStyle: PdfTextStyle = { size: fontPt(24), bold: true, color: '#111111' };
    for (const line of writer.wrap(headline.vesselName, nameStyle, WIDTH)) {
        writer.draw(line, LEFT, baseline(y, 24 * 1.15 * PX, nameStyle.size), nameStyle);
        y += 24 * 1.15 * PX;
    }
    y += 10 * PX;
    doc.setDrawColor(17, 17, 17);
    doc.setLineWidth(2 * PX);
    doc.line(LEFT, y + PX, LEFT + WIDTH, y + PX);
    y += 2 * PX + 16 * PX;

    // ── The instruction: the overdue time, set large enough to read across a
    //    kitchen, and the number to ring. Everything else is reference. ─────
    const boxTop = y;
    const inner = WIDTH - 2 * 2 * PX - 2 * 14 * PX;
    const innerLeft = LEFT + 2 * PX + 14 * PX;
    y += 2 * PX + 12 * PX;
    const alarm: PdfTextStyle = { size: fontPt(11), bold: true, color: '#bb0000', charSpace: 2 * PX };
    writer.draw('IF THERE IS NO CONTACT BY', innerLeft, baseline(y, 11 * 1.15 * PX, alarm.size), alarm);
    y += 11 * 1.15 * PX + 4 * PX;
    const overdue: PdfTextStyle = { size: fontPt(22), bold: true, color: '#111111' };
    for (const line of writer.wrap(headline.overdue, overdue, inner)) {
        writer.draw(line, innerLeft, baseline(y, 22 * 1.15 * PX, overdue.size), overdue);
        y += 22 * 1.15 * PX;
    }
    y += 6 * PX;
    const call: PdfTextStyle = { size: fontPt(13), color: '#111111' };
    const callBold: PdfTextStyle = { ...call, bold: true };
    const callPrefix = writer.measure('Call: ', call);
    writer.draw('Call: ', innerLeft, baseline(y, 13 * 1.15 * PX, call.size), call);
    for (const line of writer.wrap(headline.rescueContact, callBold, inner - callPrefix)) {
        writer.draw(line, innerLeft + callPrefix, baseline(y, 13 * 1.15 * PX, call.size), callBold);
        y += 13 * 1.15 * PX;
    }
    y += 12 * PX + 2 * PX;
    doc.setDrawColor(187, 0, 0);
    doc.setLineWidth(2 * PX);
    doc.rect(LEFT + PX, boxTop + PX, WIDTH - 2 * PX, y - boxTop - 2 * PX, 'S');
    y += 18 * PX;

    // ── The brief itself, line for line ────────────────────────────────────
    const blocks = briefBlocks(writer, payload.text);
    const drawLine = (line: string) => {
        if (line.length > 0) writer.draw(line, LEFT, baseline(y, BODY_LINE, BODY.size), BODY);
        y += BODY_LINE;
    };
    blocks.forEach((block, index) => {
        // The overdue guide is what the holder reads at 2am: one page, not two,
        // whenever it fits on one.
        if (block.kind === 'text' && block.lines[0]?.[0] === FLOAT_PLAN_GUIDE_HEADING) {
            let end = index;
            while (end + 1 < blocks.length && blocks[end + 1].kind !== 'rule') end++;
            const height = blocks.slice(index, end + 1).reduce((sum, next) => sum + blockHeight(next), 0);
            if (height > room() && height <= PAGE_BOTTOM - CONTINUED_TOP) newPage();
        }
        if (block.kind === 'gap') {
            if (y === pageTop) return;
            if (BODY_LINE > room()) newPage();
            else y += BODY_LINE;
            return;
        }
        if (block.kind === 'rule') {
            if (BODY_LINE > room()) newPage();
            doc.setDrawColor(187, 187, 187);
            doc.setLineWidth(PX);
            doc.line(LEFT, y + BODY_LINE / 2, LEFT + WIDTH, y + BODY_LINE / 2);
            y += BODY_LINE;
            return;
        }
        let groups = block.lines;
        if (blockHeight(block) > room() && lineCount(groups) <= KEEP_TOGETHER_LINES) newPage();
        while (groups.length > 0) {
            const fit = Math.floor((room() + 1e-6) / BODY_LINE);
            if (fit >= lineCount(groups)) {
                groups.flat().forEach(drawLine);
                break;
            }
            // Split a long block between its lines, leaving at least two
            // printed lines on each page.
            let take = 0;
            while (take < groups.length && lineCount(groups.slice(0, take + 1)) <= fit) take++;
            while (take > 0 && lineCount(groups.slice(take)) < 2) take--;
            if (lineCount(groups.slice(0, take)) < 2) {
                if (y === pageTop) {
                    // One line of the brief taller than a page: break inside it.
                    const [first, ...rest] = groups;
                    groups = [first.slice(0, fit), first.slice(fit), ...rest].filter((group) => group.length > 0);
                    groups[0].forEach(drawLine);
                    groups = groups.slice(1);
                }
                newPage();
                continue;
            }
            groups.slice(0, take).flat().forEach(drawLine);
            groups = groups.slice(take);
            newPage();
        }
    });

    // ── The footer: not for a rescue authority ─────────────────────────────
    const foot: PdfTextStyle = { size: fontPt(10), color: '#666666' };
    const footLines = writer.wrap(
        'Do not file this plan with a rescue authority — it is for the person holding it. ' +
            'Ask the boat to confirm arrival, and if the overdue time passes without contact, make the call above.',
        foot,
        WIDTH,
    );
    const footHeight = 22 * PX + PX + 10 * PX + footLines.length * 10 * 1.15 * PX;
    if (footHeight > room()) newPage();
    else y += 22 * PX;
    doc.setDrawColor(187, 187, 187);
    doc.setLineWidth(PX);
    doc.line(LEFT, y + PX / 2, LEFT + WIDTH, y + PX / 2);
    y += PX + 10 * PX;
    for (const line of footLines) {
        writer.draw(line, LEFT, baseline(y, 10 * 1.15 * PX, foot.size), foot);
        y += 10 * 1.15 * PX;
    }

    return { doc, filename };
}

/** Render the plan to PDF and hand it to the share sheet (email, WhatsApp, Files). */
export async function shareFloatPlanPdf(input: FloatPlanInput): Promise<void> {
    const { default: JsPdf } = await import('jspdf');
    const { doc, filename } = buildFloatPlanPdf(input, JsPdf);
    await sharePdfFile(doc.output('blob'), `${filename}.pdf`, filename);
}

export const __testing = { buildFloatPlanPdf, PAGE_BOTTOM, CONTINUED_TOP };
