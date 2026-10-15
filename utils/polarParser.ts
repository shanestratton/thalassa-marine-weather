/**
 * Polar File Parser — reads the two layouts polar files come in (132-B22):
 *
 *  - Expedition ("!Expedition polar", usually .txt or .pol): a line per true
 *    wind speed, then true wind angle / boat speed PAIRS, tab-separated
 *    (spaces read too); lines starting "!" are comments. Each line has its
 *    own angles: the beat and run angles move with the wind.
 *  - A TWA × TWS table (.pol, .csv or .txt: OpenCPN, qtVlm and most VPP
 *    exports): a header of wind speeds ("TWA\TWS", 6, 8, …), then a row per
 *    angle, split by tabs, semicolons, commas or spaces.
 *
 * Until build 132 a .pol was read as a table and called "Expedition", so a
 * real Expedition file was refused — or, without its "!" line, its first
 * line's angles and speeds were read as wind speeds.
 */
import type { PolarData } from '../types';

export type PolarFileFormat = 'expedition' | 'table';

/** What a polar file was read as, for the import preview. */
export interface PolarFileRead {
    polar: PolarData;
    format: PolarFileFormat;
}

/** Why a file could not be read as a polar: plain words, safe to show the skipper. */
export class PolarFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PolarFileError';
    }
}

/**
 * Parse a polar file. Returns normalized PolarData or throws a
 * PolarFileError on a file that is not a polar. The name is not needed: see
 * readPolarFile.
 */
export function parsePolarFile(content: string, _filename?: string): PolarData {
    return readPolarFile(content).polar;
}

/**
 * Read a polar file and say which layout it was. The layout is told from the
 * file itself, not its name: Expedition files are saved as .txt and .pol
 * alike, and so are tables.
 */
export function readPolarFile(content: string): PolarFileRead {
    const lines = content
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length < 2) throw new PolarFileError('Polar file must have at least a header and one data row');
    if (isExpedition(lines)) return { polar: parseExpedition(lines), format: 'expedition' };
    return { polar: parseTable(lines), format: 'table' };
}

// ── Expedition ───────────────────────────────────────────────────

/** Expedition's cells: tabs, or spaces in a hand-made copy. */
const expeditionCells = (line: string) => line.split(/[\t ]+/).map(Number);

/**
 * An Expedition file: its "!" comment lines, or — with none — every line a
 * wind speed and then angle / speed pairs, angles 20–180°. A table's rows
 * fail that: a row's second, fourth… cells are boat speeds, under 20.
 */
function isExpedition(lines: string[]): boolean {
    if (lines.some((l) => l.startsWith('!'))) return true;
    return lines.every((line) => {
        const cells = expeditionCells(line);
        if (cells.length < 3 || cells.length % 2 === 0 || cells.some((n) => !Number.isFinite(n))) return false;
        for (let i = 1; i < cells.length; i += 2) if (cells[i] < 20 || cells[i] > 180) return false;
        return true;
    });
}

/** One Expedition line's pairs, by angle (whole degrees); a repeated angle keeps its first figure. */
function expeditionPairs(cells: number[]): { twa: number; bsp: number }[] {
    const pairs = new Map<number, number>();
    for (let i = 1; i + 1 < cells.length; i += 2) {
        const twa = Math.round(cells[i]);
        const bsp = clampSpeed(cells[i + 1]);
        // A 0 kn pair is no figure: interpolating from it would invent speeds inside her beat angle.
        if (!Number.isFinite(twa) || twa < 0 || twa > 180 || !(bsp > 0) || pairs.has(twa)) continue;
        pairs.set(twa, bsp);
    }
    return [...pairs].map(([twa, bsp]) => ({ twa, bsp })).sort((a, b) => a.twa - b.twa);
}

/**
 * A line's speed at `twa`: interpolated between its own pairs; past its
 * deepest angle its last figure is held (as routes hold any table's last
 * row); closer to the wind than its first angle — her beat angle at that
 * wind — 0, no figure, so routes tack there.
 */
function speedOnLine(pairs: { twa: number; bsp: number }[], twa: number): number {
    if (twa < pairs[0].twa) return 0;
    const last = pairs[pairs.length - 1];
    if (twa >= last.twa) return last.bsp;
    const i = pairs.findIndex((p) => p.twa >= twa);
    const hi = pairs[i];
    if (hi.twa === twa) return hi.bsp;
    const lo = pairs[i - 1];
    return Math.round((lo.bsp + ((hi.bsp - lo.bsp) * (twa - lo.twa)) / (hi.twa - lo.twa)) * 100) / 100;
}

/** Expedition → the app's table: every line's angles as rows, each line's figures on them. */
function parseExpedition(lines: string[]): PolarData {
    const rows = new Map<number, { twa: number; bsp: number }[]>();
    for (const line of lines) {
        if (line.startsWith('!')) continue;
        const cells = expeditionCells(line);
        if (cells.length < 3 || cells.some((n) => !Number.isFinite(n))) continue;
        const tws = cells[0];
        // A 0 kn line is dropped, as a table's 0 kn column is; a repeated wind speed keeps its first line.
        if (!(tws > 0) || rows.has(tws)) continue;
        const pairs = expeditionPairs(cells);
        if (pairs.length > 0) rows.set(tws, pairs);
    }
    if (rows.size === 0) throw new PolarFileError('No valid wind speed lines found');

    const windSpeeds = [...rows.keys()].sort((a, b) => a - b);
    const angles = [...new Set([...rows.values()].flatMap((pairs) => pairs.map((p) => p.twa)))].sort((a, b) => a - b);
    const matrix = angles.map((twa) => windSpeeds.map((tws) => speedOnLine(rows.get(tws)!, twa)));
    return { windSpeeds, angles, matrix };
}

// ── TWA × TWS table ──────────────────────────────────────────────

/**
 * The table's separator, from its header: tabs, else semicolons, else
 * commas, else spaces. Beside tabs, semicolons or spaces a comma is a
 * decimal comma ("4,2").
 */
function tableSplitter(header: string): (line: string) => string[] {
    const by = header.includes('\t') ? /\t+/ : header.includes(';') ? /;/ : header.includes(',') ? /,/ : /\s+/;
    const decimalComma = by.source !== ',';
    return (line) => line.split(by).map((s) => (decimalComma ? s.trim().replace(',', '.') : s.trim()));
}

/**
 * The header with its label as one cell. The label is the first cell and
 * every word after it ("TWA TWS", "TWA / TWS"): a wind speed is a number, and
 * a row's angle is one cell under the whole label. Split by spaces, "TWA TWS"
 * was two cells, so every figure was read one wind speed low, without a word
 * (132-B22 review). An empty cell is a column, not a word.
 */
function headerWithLabel(parts: string[]): string[] {
    let end = 1;
    while (end < parts.length && parts[end] !== '' && isNaN(Number(parts[end]))) end++;
    const header = [parts.slice(0, end).join(' '), ...parts.slice(end)];
    while (header.length > 1 && header[header.length - 1] === '') header.pop();
    return header;
}

/**
 * The header's wind-speed columns: each one's index in the line, and its
 * speed. A 0 kn (or unreadable) column is left out WITH its figures — rows
 * are read at these same indices, never re-counted from the second cell, so
 * dropping a 0 kn column cannot slide every row one column left.
 */
function headerColumns(parts: string[]): { col: number; tws: number }[] {
    return parts
        .map((part, col) => ({ col, tws: Number(part) }))
        .slice(1)
        .filter(({ tws }) => !isNaN(tws) && tws > 0);
}

/** A row's figures under the header's columns (missing or unreadable cells read 0). */
function rowFigures(parts: string[], columns: { col: number }[]): number[] {
    return columns.map(({ col }) => {
        const n = parseFloat(parts[col] ?? '');
        return isNaN(n) ? 0 : clampSpeed(n);
    });
}

/**
 * Parse a TWA × TWS table:
 * First line: TWA\TWS\t6\t8\t10\t12\t15\t20\t25 (or ; , or spaces)
 * Subsequent: 45\t5.2\t6.1\t6.8\t7.2\t7.5\t7.6\t7.4
 */
function parseTable(lines: string[]): PolarData {
    const split = tableSplitter(lines[0]);
    // First column is the label (TWA or similar), rest are wind speeds
    const header = headerWithLabel(split(lines[0]));
    const columns = headerColumns(header);
    const windSpeeds = columns.map((c) => c.tws);
    if (windSpeeds.length === 0) throw new PolarFileError('No valid wind speeds found in header');

    const angles: number[] = [];
    const matrix: number[][] = [];

    for (let i = 1; i < lines.length; i++) {
        const parts = split(lines[i]);
        const angle = parseFloat(parts[0]);
        if (isNaN(angle) || angle < 0 || angle > 180) continue;
        // A figure with no wind speed over it: the header and the rows don't
        // line up (a header without its "TWA" cell, say), and reading on would
        // put every figure under the wrong wind speed. Refused, not guessed (132-B22 review).
        if (parts.slice(header.length).some((cell) => !isNaN(parseFloat(cell)))) {
            throw new PolarFileError(
                `The ${angle}° row has more figures than the header has wind speeds, so its columns don't line up`,
            );
        }

        angles.push(angle);
        matrix.push(rowFigures(parts, columns));
    }

    if (angles.length === 0) throw new PolarFileError('No valid wind angle rows found');
    return { windSpeeds, angles, matrix };
}

/** Clamp boat speed to reasonable range (0-30 kts) */
function clampSpeed(speed: number): number {
    return Math.max(0, Math.min(30, speed));
}

/** Validate polar data for obvious errors */
export function validatePolarData(data: PolarData): { valid: boolean; warnings: string[] } {
    const warnings: string[] = [];

    if (data.windSpeeds.length === 0) return { valid: false, warnings: ['No wind speeds defined'] };
    if (data.angles.length === 0) return { valid: false, warnings: ['No wind angles defined'] };
    if (data.matrix.length !== data.angles.length)
        return { valid: false, warnings: ["Matrix rows don't match angle count"] };

    // Check for anomalous values (potential typos)
    for (let a = 0; a < data.angles.length; a++) {
        for (let w = 0; w < data.windSpeeds.length; w++) {
            const speed = data.matrix[a]?.[w] ?? 0;
            if (speed > 20) {
                warnings.push(`Unusually high speed ${speed}kts at ${data.angles[a]}°/${data.windSpeeds[w]}kts TWS`);
            }
        }
    }

    // Check for non-monotonic wind speeds
    for (let i = 1; i < data.windSpeeds.length; i++) {
        if (data.windSpeeds[i] <= data.windSpeeds[i - 1]) {
            warnings.push(
                `Wind speeds not monotonically increasing: ${data.windSpeeds[i - 1]} ≥ ${data.windSpeeds[i]}`,
            );
        }
    }

    return { valid: true, warnings };
}

/** Create an empty polar data matrix with default wind speeds and angles */
export function createEmptyPolar(): PolarData {
    const windSpeeds = [6, 8, 10, 12, 15, 20, 25];
    const angles = [45, 60, 90, 120, 150, 180];
    const matrix = angles.map(() => windSpeeds.map(() => 0));
    return { windSpeeds, angles, matrix };
}
