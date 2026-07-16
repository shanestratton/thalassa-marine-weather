/**
 * RouteReportPdfService — export the Route Tracer's report as a PDF.
 *
 * A shareable / printable summary of a traced route: the route heading, the
 * clear/caution/no-go tally, the departure window, every waypoint in
 * degrees-decimal-minutes, and each leg's verdict. Navy maritime theme to
 * match PassagePdfService. Returns a Blob (share via utils/sharePdf).
 *
 * jsPDF's built-in fonts are latin-1 only — emoji render as blanks/boxes — so
 * every string runs through pdfSafe() (emoji stripped, em-dash/arrow/quotes
 * folded to ASCII, degree sign kept) and grade icons are DRAWN, not typed.
 */

import { jsPDF } from 'jspdf';
import type { TraceLegVerdict, TracePoint } from './routeTracer';
import { traceHealth } from './routeTracer';
import { windCompass, type WaypointWeather } from './routeReportWeather';

type RGB = [number, number, number];
const COLORS = {
    bg: [15, 23, 42] as RGB, // slate-900
    cardBg: [30, 41, 59] as RGB, // slate-800
    primary: [56, 189, 248] as RGB, // sky-400
    green: [52, 211, 153] as RGB, // emerald-400
    red: [248, 113, 113] as RGB, // red-400
    amber: [251, 191, 36] as RGB, // amber-400
    white: [241, 245, 249] as RGB, // slate-50
    muted: [148, 163, 184] as RGB, // slate-400
    dim: [100, 116, 139] as RGB, // slate-500
};

/** Fold the app's unicode down to what jsPDF's latin-1 fonts can draw. */
function pdfSafe(s: unknown): string {
    return String(s ?? '')
        .replace(/[–—]/g, '-') // en/em dash → hyphen
        .replace(/→/g, ' to ') // → arrow
        .replace(/[‘’]/g, "'") // curly single quotes
        .replace(/[“”]/g, '"') // curly double quotes
        .replace(/[   ]/g, ' ') // nbsp / thin spaces
        .replace(/[^\x20-\x7E°]/g, '') // keep printable ASCII + degree; strip emoji
        .trim();
}

/** Decimal degrees → degrees-decimal-minutes with hemisphere (plotter standard). */
function ddToDMM(v: number, isLat: boolean): string {
    const hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
    const a = Math.abs(v);
    const deg = Math.floor(a);
    const min = (a - deg) * 60;
    return `${deg}°${min.toFixed(2).padStart(5, '0')}'${hemi}`;
}
const fmtFix = (p: TracePoint): string => `${ddToDMM(p.lat, true)}  ${ddToDMM(p.lon, false)}`;

function nowLabel(nowMs: number): string {
    try {
        return new Date(nowMs).toLocaleString('en-AU', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    } catch {
        return '';
    }
}

export interface RouteReportPdfData {
    /** The route heading, e.g. "Bribie - Newport". */
    routeName: string;
    pins: TracePoint[];
    verdicts: Array<TraceLegVerdict | null>;
    tideLabels: Record<number, string>;
    /** null while computing, '' when nothing tide-gated. */
    departureLabel: string | null;
    vesselName?: string;
    draftM?: number;
    /** Per-waypoint ETA + wind (departing now). null/absent → no weather column. */
    weather?: WaypointWeather[] | null;
    /** Cruising speed used for the ETAs (kts), for the header note. */
    cruisingSpeedKts?: number;
    /** Epoch ms for the "generated" stamp (passed in — Date.now() is banned in
     *  some contexts and keeps this pure/testable). */
    nowMs: number;
}

/** "+3h20 14:30" / "now 09:05" arrival label. */
function etaLabel(w: WaypointWeather): string {
    const clock = new Date(w.etaMs).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (w.hoursFromDep < 0.02) return `now ${clock}`;
    const h = Math.floor(w.hoursFromDep);
    const m = Math.round((w.hoursFromDep - h) * 60);
    const rel = h > 0 ? `+${h}h${m > 0 ? String(m).padStart(2, '0') : ''}` : `+${m}m`;
    return `${rel} ${clock}`;
}
/** "SW 14kt G22" / "beyond fcst" / "". */
function windLabel(w: WaypointWeather): string {
    if (w.beyondForecast) return 'beyond fcst';
    if (w.windKts == null || w.windDeg == null) return '';
    const gust = w.gustKts != null && w.gustKts - w.windKts >= 3 ? ` G${Math.round(w.gustKts)}` : '';
    return `${windCompass(w.windDeg)} ${Math.round(w.windKts)}kt${gust}`;
}

export function getRouteReportFileName(routeName: string): string {
    const base = (routeName || 'Route').trim() || 'Route';
    return `Route_${base}.pdf`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function generateRouteReportPdf(data: RouteReportPdfData): Blob {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth(); // 210
    const H = doc.internal.pageSize.getHeight(); // 297
    const margin = 14;
    const contentW = W - margin * 2;
    let y = margin;

    const paintBg = () => {
        doc.setFillColor(...COLORS.bg);
        doc.rect(0, 0, W, H, 'F');
    };
    // Ensure `need` mm of vertical room; new page (repainted) if not.
    const ensure = (need: number) => {
        if (y + need > H - margin) {
            doc.addPage();
            paintBg();
            y = margin;
        }
    };
    paintBg();

    // ── Header card ──
    doc.setFillColor(...COLORS.cardBg);
    doc.roundedRect(margin, y, contentW, 27, 3, 3, 'F');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.dim);
    doc.text('THALASSA MARINE WEATHER', margin + 6, y + 7);
    doc.setFontSize(15);
    doc.setTextColor(...COLORS.white);
    doc.text('ROUTE REPORT', margin + 6, y + 15);
    doc.setFontSize(11);
    doc.setTextColor(...COLORS.primary);
    doc.text(pdfSafe(data.routeName) || 'Untitled route', margin + 6, y + 23, { maxWidth: contentW - 60 });
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.dim);
    doc.text(nowLabel(data.nowMs), W - margin - 6, y + 7, { align: 'right' });
    const vesselLine = [data.vesselName ? pdfSafe(data.vesselName) : '', data.draftM != null ? `${data.draftM.toFixed(1)} m draft` : '']
        .filter(Boolean)
        .join('  ·  ');
    if (vesselLine) doc.text(vesselLine, W - margin - 6, y + 23, { align: 'right' });
    y += 27 + 5;

    // ── Health tally ──
    const h = traceHealth(data.verdicts);
    ensure(13);
    doc.setFillColor(...COLORS.cardBg);
    doc.roundedRect(margin, y, contentW, 12, 3, 3, 'F');
    doc.setFontSize(10);
    let hx = margin + 6;
    const chip = (label: string, col: RGB) => {
        doc.setTextColor(...col);
        doc.text(label, hx, y + 7.8);
        hx += doc.getTextWidth(label) + 7;
    };
    chip(`${h.clear} clear`, COLORS.green);
    chip(`${h.caution} caution`, COLORS.amber);
    chip(`${h.danger} no-go`, COLORS.red);
    if (h.pending > 0) chip(`${h.pending} checking`, COLORS.muted);
    y += 12 + 5;

    // ── Departure window ──
    if (data.departureLabel) {
        const lines = doc.splitTextToSize(pdfSafe(data.departureLabel), contentW - 12) as string[];
        const boxH = Math.max(11, lines.length * 4.4 + 5);
        ensure(boxH);
        doc.setFillColor(...COLORS.cardBg);
        doc.roundedRect(margin, y, contentW, boxH, 3, 3, 'F');
        doc.setFontSize(9);
        doc.setTextColor(...COLORS.primary);
        doc.text(lines, margin + 6, y + 6.5);
        y += boxH + 5;
    }

    // ── Waypoints (with ETA + wind at that time, if we have it) ──
    const wx = data.weather ?? null;
    ensure(9);
    doc.setFontSize(9);
    doc.setTextColor(...COLORS.muted);
    doc.text(`WAYPOINTS (${data.pins.length})`, margin, y + 4);
    if (wx) {
        doc.setFontSize(7);
        doc.setTextColor(...COLORS.dim);
        doc.text(`ETA + wind — leave now @ ${data.cruisingSpeedKts ?? 6} kt`, W - margin, y + 4, { align: 'right' });
    }
    y += 8;
    doc.setFontSize(9.5);
    data.pins.forEach((p, i) => {
        ensure(5.5);
        doc.setTextColor(...COLORS.dim);
        doc.text(`${i + 1}`, margin, y + 3.5, { align: 'left' });
        doc.setTextColor(...COLORS.white);
        doc.text(fmtFix(p), margin + 11, y + 3.5);
        const w = wx?.[i];
        if (w) {
            doc.setFontSize(8);
            doc.setTextColor(...COLORS.primary);
            doc.text(etaLabel(w), W - margin - 34, y + 3.5, { align: 'right' });
            const wind = windLabel(w);
            if (wind) {
                doc.setTextColor(...(w.gustKts != null && w.gustKts >= 25 ? COLORS.amber : COLORS.muted));
                doc.text(pdfSafe(wind), W - margin, y + 3.5, { align: 'right' });
            }
            doc.setFontSize(9.5);
        }
        y += 5.4;
    });
    y += 5;

    // ── Legs ──
    ensure(9);
    doc.setFontSize(9);
    doc.setTextColor(...COLORS.muted);
    doc.text('LEGS', margin, y + 4);
    y += 8;
    data.verdicts.forEach((v, i) => {
        if (!v) return; // still grading — skip
        const col = v.grade === 'danger' ? COLORS.red : v.grade === 'caution' ? COLORS.amber : COLORS.green;
        // On a clear leg an 'info' note (correct mark pass) replaces "clear — N m least".
        const infoNote = v.issues.find((iss) => iss.severity === 'info');
        const problem = v.issues.find((iss) => iss.severity !== 'info');
        const msg =
            v.grade === 'clear'
                ? infoNote
                    ? infoNote.message
                    : v.minDepthM != null
                      ? `clear - ${v.minDepthM.toFixed(1)} m least`
                      : 'clear'
                : (problem?.message ?? v.grade);
        doc.setFontSize(8.5);
        const lines = doc.splitTextToSize(pdfSafe(msg), contentW - 20) as string[];
        const tide = data.tideLabels[i] ? (doc.splitTextToSize(pdfSafe(data.tideLabels[i]), contentW - 20) as string[]) : [];
        const rowH = Math.max(5.4, lines.length * 3.6 + tide.length * 3.2 + 1.6);
        ensure(rowH);
        doc.setFillColor(...col);
        doc.circle(margin + 1.4, y + 2.4, 1.2, 'F');
        doc.setFontSize(8);
        doc.setTextColor(...COLORS.dim);
        doc.text(`${i + 1}-${i + 2}`, margin + 5, y + 3.4);
        doc.setFontSize(8.5);
        doc.setTextColor(...COLORS.white);
        doc.text(lines, margin + 18, y + 3.4);
        if (tide.length) {
            doc.setFontSize(7);
            doc.setTextColor(...COLORS.primary);
            doc.text(tide, margin + 18, y + 3.4 + lines.length * 3.5);
        }
        y += rowH;
    });

    // ── Footer (current page) ──
    doc.setFontSize(6.5);
    doc.setTextColor(...COLORS.dim);
    doc.text('Advisory only - always cross-check against official charts and Notices to Mariners.', margin, H - 7);

    return doc.output('blob');
}
