/**
 * TripPdfService — multi-page passage-plan PDF for a whole trip.
 *
 * Where PassagePdfService produces a single-leg brief (one ocean
 * crossing, the on-the-water doc you hand the watch keeper),
 * this builds the captain's overarching trip plan: itinerary across
 * all legs, country/visa/biosecurity info, crew watch options,
 * provisioning notes, and a safety checklist.
 *
 * Modeled on PassagePdfService for visual consistency — same navy
 * maritime palette, same header ribbon shape, same font scaling —
 * but laid out for many pages with auto-paginated body sections.
 *
 * Output: Blob, ready for Capacitor Share or direct download.
 */

import { jsPDF } from 'jspdf';
import { createLogger } from '../utils/createLogger';
import type { EnrichedTripOverview, LegForecast, TripOverview } from './TripOverviewService';
import { getCountrySnippets } from './TripOverviewService';
import type { ResolvedCountrySnippet } from './CountrySnippetService';
import type { RouteHazardReport, RouteHazardReportEntry } from './enc/EncHazardReportService';
import { CATZOC_LABELS, isLowConfidenceCatzoc } from './enc/types';

const log = createLogger('TripPDF');

// ── Palette (matches PassagePdfService for cross-doc consistency) ──
const COLORS = {
    bg: [15, 23, 42] as [number, number, number],
    cardBg: [30, 41, 59] as [number, number, number],
    primary: [56, 189, 248] as [number, number, number],
    accent: [20, 184, 166] as [number, number, number],
    green: [52, 211, 153] as [number, number, number],
    red: [248, 113, 113] as [number, number, number],
    amber: [251, 191, 36] as [number, number, number],
    white: [241, 245, 249] as [number, number, number],
    muted: [148, 163, 184] as [number, number, number],
    dim: [100, 116, 139] as [number, number, number],
    divider: [51, 65, 85] as [number, number, number],
};

// ── Helpers ──

function formatDuration(hours: number): string {
    if (!Number.isFinite(hours) || hours <= 0) return '—';
    if (hours < 24) return `${hours.toFixed(1)}h`;
    const days = Math.floor(hours / 24);
    const rem = Math.round(hours % 24);
    return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

function formatDate(iso?: string | null): string {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleDateString('en-AU', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        });
    } catch {
        return '—';
    }
}

/** Wrap text to a width, returning lines. jsPDF's splitTextToSize is
 *  the canonical way; this is just a thin wrapper for readability. */
function wrap(doc: jsPDF, text: string, widthMm: number): string[] {
    return doc.splitTextToSize(text, widthMm);
}

// ── Watch-schedule recommendations by crew count ──
//
// Mirrors the user's South Pacific Passage doc — includes "why" each
// pattern works so the skipper can pick what fits their crew.
function watchScheduleNotes(crewCount?: number): { title: string; body: string }[] {
    const recs: { title: string; body: string }[] = [];
    if (!crewCount || crewCount < 2) {
        recs.push({
            title: 'Solo / short-handed',
            body: 'Use a 20-minute alarm watch system below decks with a high-volume kitchen timer and AIS guard zones. Avoid solo offshore where possible — fatigue is the dominant risk.',
        });
        return recs;
    }
    if (crewCount === 2) {
        recs.push({
            title: 'Two-up: 3 on / 3 off',
            body: 'Each watch keeper runs solo for three hours, off for three. Sustainable for short hops; fatigue accumulates fast on multi-day passages — plan a long stop every 5 days.',
        });
        recs.push({
            title: 'Two-up: 4 on / 4 off (rotating)',
            body: 'Slightly longer watches reduce handover overhead. Rotate the dog-watch each evening so neither person owns the worst shift permanently.',
        });
        return recs;
    }
    if (crewCount === 3) {
        recs.push({
            title: 'Three-up: 3 on / 6 off (solo watches)',
            body: 'Two full watch periods off — generous sleep. Cruiser favourite for offshore. Requires confidence from every crew member alone in the cockpit at night.',
        });
        recs.push({
            title: 'Three-up: 4 on / 8 off',
            body: 'Even longer rest periods, but a 4 hr watch can drag in calm conditions. Better for fully-crewed bluewater than coastal hops.',
        });
        return recs;
    }
    // 4+
    recs.push({
        title: 'Four-up: 3 on / 9 off (solo watches)',
        body: 'Maximum rest per crew member. Each person stands watch alone for 3 hours, off for 9. Sustainable for multi-week passages but assumes everyone can run the boat solo at night.',
    });
    recs.push({
        title: 'Two teams of two: 6 on / 6 off',
        body: 'Always two in the cockpit — great for sail changes, reefing, company in the dark. Simpler to remember; the midnight–06:00 shift is heavy.',
    });
    recs.push({
        title: 'Swedish system: 6-6-4-4-4 (rotating)',
        body: 'Two teams, varied watch lengths so nobody is stuck on the same overnight permanently. More to track but the fairest rotation over a long trip.',
    });
    return recs;
}

// ── Provisioning blurb (lightly templated by trip length) ──

function provisioningNotes(totalDurationHours: number): string[] {
    const days = Math.ceil(totalDurationHours / 24);
    const longTrip = days >= 5;
    return [
        `Plan for at least ${days + 2} days of meals onboard — the +2 covers weather delays and the day after arrival before you can re-provision.`,
        `Pre-cook & freeze 3-4 complete meals for the first 48 hrs at sea. Adapting to watch schedule + motion saps energy; reheating beats cooking.`,
        longTrip
            ? 'Decant pasta, rice, oats, and flour from bags into sealed containers. Saves space, keeps moisture out, and stops weevil-prone packaging from contaminating the locker.'
            : 'Keep grab-and-go snacks within reach of the cockpit — muesli bars, nuts, hard-boiled eggs (peeled), crackers with peanut butter.',
        'Reduce cardboard packaging before you depart — every box you bring aboard is rubbish you carry to your next port.',
        'Hard-skinned fruit (apples, oranges, lemons, limes) lasts the full passage. Bananas only for the first 2-3 days.',
        'Onions, garlic, potatoes, sweet potatoes, butternut, cabbage, carrots, capsicum, hard avocados — the long-life veg list. Store in cool, dark, ventilated lockers, NOT the fridge.',
        'Pantry powerhouses: tinned tuna/salmon/chicken, beans/lentils, tinned tomatoes, pasta sauce, curry pastes, UHT milk, oats, muesli, instant + plunger coffee.',
    ];
}

// ── Skipper-prep checklist (the doc's "Essential Preparedness") ──

const VESSEL_PREP = [
    'Rigging: visual check from masthead to deck — turnbuckles, split pins, fittings, fatigue or corrosion. Tape all split pins.',
    'Running rigging: end-for-end any ropes showing chafe at specific points.',
    'Sails: stitching, UV degradation, clew/head wear. Storm jib + trysail accessible; rig them at the dock at least once.',
    'Engine: full service — oil, oil filter, primary + secondary fuel filters. Fresh impeller (keep the old one as a spare). Coolant level + colour.',
    'Bilge: clean and dry; manually test all bilge pumps + verify automatic float switches.',
    'Steering: wheel-to-quadrant — cables, chains, pins. Practice rigging the emergency tiller.',
    'Through-hulls: every seacock works; softwood plug + lanyard at each one.',
    'Hatches + portholes: all seals watertight under hose test.',
];

const SAFETY_GEAR = [
    'Life jacket + harness + tether + strobe + whistle for every crew member. CO₂ cartridges in date.',
    'PLB / AIS beacon ideally on each crew member, attached to their PFD.',
    'Jacklines rigged on deck before departure — clip-in before stepping into the cockpit.',
    'Liferaft serviced + accessible. EPIRB registered with AMSA, in date.',
    'Offshore flare kit, in date, in a waterproof grab bag.',
    'Grab bag: handheld VHF, EPIRB, water, rehydration salts, seasickness tabs, first aid, passports, ship’s papers.',
    'Fire extinguishers in date, locations briefed to all crew.',
    'AIS transmitting + receiving. VHF + HF/SSB tested. Sat phone subscription active.',
];

// ── ENC hazard report rendering ──────────────────────────────────

/**
 * Format a hazard distance for the PDF body. Uses the same
 * conventions as the on-screen panel so users see consistent
 * numbers across surfaces.
 */
function formatHazardDistance(nm: number): string {
    if (nm < 0.05) return '<0.05 NM';
    if (nm < 1) return `${nm.toFixed(2)} NM`;
    return `${nm.toFixed(1)} NM`;
}

function hazardSideLabel(side: RouteHazardReportEntry['side']): string {
    return side === 'port' ? 'port' : side === 'starboard' ? 'stbd' : 'on track';
}

function hazardTypeLabel(type: RouteHazardReportEntry['hazardType']): string {
    switch (type) {
        case 'wreck':
            return 'Wreck';
        case 'rock':
            return 'Underwater rock';
        case 'obstruction':
            return 'Obstruction';
        case 'coast':
            return 'Charted coastline';
        default:
            return 'Hazard';
    }
}

function hazardLatLon(p: { lat: number; lon: number }): string {
    const lat = `${Math.abs(p.lat).toFixed(3)} ${p.lat >= 0 ? 'N' : 'S'}`;
    const lon = `${Math.abs(p.lon).toFixed(3)} ${p.lon >= 0 ? 'E' : 'W'}`;
    return `${lat}  ${lon}`;
}

/**
 * Render the "ENC Hazards Along Route" section — pulled out so it
 * doesn't bloat the main `generateTripPdf` body. Caller is
 * responsible for confirming the report is non-empty before
 * calling.
 */
function renderHazardReportSection(b: PdfBuilder, report: RouteHazardReport): void {
    b.sectionTitle('ENC Hazards Along Route');
    b.paragraph(
        `Charted obstructions, wrecks, rocks, and coastline within ${report.bufferNm.toFixed(1)} NM of the planned route, derived from your imported S-57 ENC cells (${report.cellsConsulted} cell${report.cellsConsulted === 1 ? '' : 's'} consulted). Verify visually before relying on these positions — Pacific atolls and remote shores often have positional uncertainty of 100–500 m.`,
        COLORS.muted,
        8.5,
    );

    for (const entry of report.entries) {
        b.ensureRoom(20);

        // Card background
        b.doc.setFillColor(...COLORS.cardBg);
        b.doc.roundedRect(b.margin, b.y, b.contentW, 17, 2, 2, 'F');

        // Type + description on first line
        b.doc.setFontSize(9.5);
        b.doc.setTextColor(...COLORS.amber);
        const headline = entry.description ?? hazardTypeLabel(entry.hazardType);
        b.doc.text(headline, b.margin + 4, b.y + 6);

        // Distance + side on the right
        b.doc.setFontSize(8.5);
        b.doc.setTextColor(...COLORS.muted);
        const distLabel = `${formatHazardDistance(entry.distanceNm)}  ${hazardSideLabel(entry.side)}`;
        b.doc.text(distLabel, b.margin + b.contentW - 4, b.y + 6, { align: 'right' });

        // Detail line: depth + cell + CATZOC + lat/lon
        b.doc.setFontSize(7.5);
        b.doc.setTextColor(...COLORS.dim);
        const detailParts: string[] = [];
        if (entry.minDepthM != null) detailParts.push(`${entry.minDepthM.toFixed(1)} m`);
        detailParts.push(`${entry.cellId} (${entry.sourceHO})`);
        if (entry.catzoc != null) {
            const catzocLabel = `CATZOC ${CATZOC_LABELS[entry.catzoc]}`;
            detailParts.push(isLowConfidenceCatzoc(entry.catzoc) ? `${catzocLabel} — verify visually` : catzocLabel);
        }
        b.doc.text(detailParts.join('  ·  '), b.margin + 4, b.y + 11.5);

        // Lat/lon on the right of the detail line
        b.doc.text(hazardLatLon(entry.representativePoint), b.margin + b.contentW - 4, b.y + 11.5, {
            align: 'right',
        });

        b.y += 19;
    }
}

const MEDICAL_KIT = [
    'Personal Rx for every crew member — full passage supply + 3-month contingency. Copies of original prescriptions.',
    'OTC pain/fever: paracetamol, ibuprofen, aspirin (for suspected MI under medical guidance).',
    'Stomach: Gaviscon/Mylanta, loperamide (Imodium), promethazine, oral rehydration salts (Gastrolyte).',
    'Allergies: non-drowsy antihistamine (Zyrtec/Claratyne), 1% hydrocortisone cream, calamine lotion.',
    'Seasickness: preferred prevention (Kwells / Travacalm). Test ashore before relying on it offshore.',
    'Antiseptics: Betadine, alcohol/iodine wipes, antifungal cream (Canesten), triple antibiotic ointment.',
    'Prescription tier: broad-spectrum oral antibiotics (skin/respiratory/GI), strong pain relief, antibiotic eye + ear drops, EpiPen if anyone has anaphylaxis history.',
    'Coral kit: sterile scrub brush + extra Betadine. Coral cuts go septic fast in the tropics.',
    'Box jellyfish / Irukandji first aid: large bottle of plain white vinegar.',
    'Telemedicine subscription via sat phone — direct line to an emergency doctor when you need one.',
];

// ── Page management ──

class PdfBuilder {
    doc: jsPDF;
    margin: number;
    W: number;
    H: number;
    contentW: number;
    y: number;

    constructor() {
        this.doc = new jsPDF({ unit: 'mm', format: 'a4' });
        this.margin = 14;
        this.W = this.doc.internal.pageSize.getWidth();
        this.H = this.doc.internal.pageSize.getHeight();
        this.contentW = this.W - 2 * this.margin;
        this.y = 0;
        this.fillPage();
    }

    fillPage() {
        this.doc.setFillColor(...COLORS.bg);
        this.doc.rect(0, 0, this.W, this.H, 'F');
    }

    /** Add a new page if the next block would overflow. */
    ensureRoom(needMm: number) {
        if (this.y + needMm > this.H - 14) {
            this.doc.addPage();
            this.fillPage();
            this.y = 16;
            this.runningHeader();
        }
    }

    /** Subtle running header on continuation pages. */
    runningHeader() {
        this.doc.setFontSize(7);
        this.doc.setTextColor(...COLORS.dim);
        this.doc.text('THALASSA · TRIP PLAN', this.margin, 10);
        this.y = Math.max(this.y, 16);
    }

    sectionTitle(text: string) {
        this.ensureRoom(16);
        this.doc.setDrawColor(...COLORS.primary);
        this.doc.setLineWidth(0.6);
        this.doc.line(this.margin, this.y, this.margin + 4, this.y);
        this.doc.setFontSize(13);
        this.doc.setTextColor(...COLORS.white);
        this.doc.text(text, this.margin + 7, this.y + 1.5);
        this.y += 8;
    }

    paragraph(text: string, color: [number, number, number] = COLORS.muted, fontSize = 9) {
        this.doc.setFontSize(fontSize);
        this.doc.setTextColor(...color);
        const lines = wrap(this.doc, text, this.contentW);
        for (const line of lines) {
            this.ensureRoom(fontSize * 0.5);
            this.doc.text(line, this.margin, this.y);
            this.y += fontSize * 0.45;
        }
        this.y += 1;
    }

    bullets(items: string[]) {
        for (const item of items) {
            this.doc.setFontSize(9);
            this.doc.setTextColor(...COLORS.muted);
            const lines = wrap(this.doc, item, this.contentW - 5);
            this.ensureRoom(lines.length * 4 + 1);
            // Bullet
            this.doc.setFillColor(...COLORS.primary);
            this.doc.circle(this.margin + 1.2, this.y - 1.2, 0.6, 'F');
            // Text
            this.doc.setTextColor(...COLORS.muted);
            for (let i = 0; i < lines.length; i++) {
                this.doc.text(lines[i], this.margin + 5, this.y);
                this.y += 4;
            }
            this.y += 0.5;
        }
        this.y += 1;
    }

    /** Inline two-column key/value pair. */
    keyValue(key: string, value: string) {
        this.ensureRoom(5);
        this.doc.setFontSize(8);
        this.doc.setTextColor(...COLORS.dim);
        this.doc.text(key.toUpperCase(), this.margin, this.y);
        this.doc.setFontSize(10);
        this.doc.setTextColor(...COLORS.white);
        this.doc.text(value, this.margin + 38, this.y);
        this.y += 5.5;
    }
}

// ── Main entry ──

export function generateTripPdf(
    trip: TripOverview | EnrichedTripOverview,
    opts?: {
        vesselName?: string;
        /** Pre-resolved country snippets — pass through from the
         *  trip overview sheet which already fetched them via the
         *  CountrySnippetService (curated → cache → AI → stub).
         *  When omitted, the PDF falls back to the curated-only
         *  list so a stand-alone caller still gets sensible output. */
        countrySnippets?: ResolvedCountrySnippet[];
        /** Route hazard report for the most recently validated
         *  route (caller usually passes EncHazardReportService.
         *  getLastReport()). Renders an "ENC Hazards Along Route"
         *  section when present + non-empty; absent when no ENC
         *  coverage on the route. */
        hazardReport?: RouteHazardReport | null;
    },
): Blob {
    const b = new PdfBuilder();
    const vesselLabel = opts?.vesselName || 'Your Vessel';
    // Narrow the input — Enriched has extra optional fields. We
    // type-guard via property presence so a plain TripOverview still
    // passes through and just skips the live-data sections.
    const enriched = trip as EnrichedTripOverview;
    const liveLegs = enriched.legsWithForecast;
    const bestWindow = enriched.bestDepartureWindow;
    const enrichedAtIso = enriched.enrichedAt;

    // ─────────────────────────────────────────────────────────
    // Page 1 — Cover
    // ─────────────────────────────────────────────────────────
    // Header ribbon
    b.y = 12;
    b.doc.setFillColor(...COLORS.cardBg);
    b.doc.roundedRect(b.margin, b.y, b.contentW, 30, 3, 3, 'F');
    b.doc.setFontSize(8);
    b.doc.setTextColor(...COLORS.dim);
    b.doc.text('THALASSA · TRIP PLAN', b.margin + 6, b.y + 8);
    b.doc.setFontSize(18);
    b.doc.setTextColor(...COLORS.white);
    b.doc.text(trip.name, b.margin + 6, b.y + 18);
    b.doc.setFontSize(9);
    b.doc.setTextColor(...COLORS.muted);
    b.doc.text(`⛵ ${vesselLabel}`, b.margin + 6, b.y + 25);
    b.doc.setFontSize(7);
    b.doc.setTextColor(...COLORS.dim);
    b.doc.text(formatDate(new Date().toISOString()), b.W - b.margin - 6, b.y + 8, { align: 'right' });
    b.y += 38;

    // Stats card
    b.doc.setFillColor(...COLORS.cardBg);
    b.doc.roundedRect(b.margin, b.y, b.contentW, 28, 3, 3, 'F');
    const colW = b.contentW / 4;
    const stat = (label: string, value: string, color: [number, number, number], col: number) => {
        const x = b.margin + col * colW + colW / 2;
        b.doc.setFontSize(7);
        b.doc.setTextColor(...COLORS.dim);
        b.doc.text(label, x, b.y + 8, { align: 'center' });
        b.doc.setFontSize(14);
        b.doc.setTextColor(...color);
        b.doc.text(value, x, b.y + 18, { align: 'center' });
    };
    stat('LEGS', trip.legs.length.toString(), COLORS.primary, 0);
    stat('TOTAL NM', trip.totalDistanceNm.toFixed(0), COLORS.green, 1);
    stat('DURATION', formatDuration(trip.totalDurationHours), COLORS.amber, 2);
    stat('COUNTRIES', trip.countries.length.toString() || '—', COLORS.accent, 3);
    b.y += 35;

    // Date range
    if (trip.earliestDepartureIso || trip.latestArrivalIso) {
        b.doc.setFontSize(8);
        b.doc.setTextColor(...COLORS.dim);
        b.doc.text('PLANNED WINDOW', b.margin, b.y);
        b.doc.setFontSize(11);
        b.doc.setTextColor(...COLORS.white);
        b.doc.text(
            `${formatDate(trip.earliestDepartureIso)} → ${formatDate(trip.latestArrivalIso)}`,
            b.margin,
            b.y + 6,
        );
        b.y += 14;
    }

    // ─────────────────────────────────────────────────────────
    // Live forecast banner — only when enrichment succeeded.
    // Tells the reader the per-leg numbers below are live, not the
    // template-static "your skipper estimated" placeholder.
    // ─────────────────────────────────────────────────────────
    if (enrichedAtIso) {
        b.ensureRoom(12);
        b.doc.setFillColor(...COLORS.accent);
        b.doc.roundedRect(b.margin, b.y, b.contentW, 9, 2, 2, 'F');
        b.doc.setFontSize(8);
        b.doc.setTextColor(...COLORS.bg);
        b.doc.text(`LIVE FORECAST · pulled ${formatDate(enrichedAtIso)}`, b.margin + 4, b.y + 6);
        b.y += 13;
    }

    // ─────────────────────────────────────────────────────────
    // Itinerary table — taller cards when the leg has a live
    // forecast attached so the wind/wave/condition strip fits.
    // ─────────────────────────────────────────────────────────
    b.sectionTitle('Itinerary');
    for (let i = 0; i < trip.legs.length; i++) {
        const leg = trip.legs[i];
        const liveLeg = liveLegs?.[i];
        const forecast: LegForecast | undefined = liveLeg?.forecast;
        const realNm = liveLeg?.realDistanceNm;
        const displayNm = realNm !== undefined && realNm > 0 ? realNm : leg.distanceNm;
        const cardH = forecast ? 26 : 18;
        b.ensureRoom(cardH + 2);
        // Card
        b.doc.setFillColor(...COLORS.cardBg);
        b.doc.roundedRect(b.margin, b.y, b.contentW, cardH, 2, 2, 'F');
        // Leg number badge
        b.doc.setFillColor(...COLORS.primary);
        b.doc.roundedRect(b.margin + 3, b.y + 3, 14, 12, 1.5, 1.5, 'F');
        b.doc.setFontSize(9);
        b.doc.setTextColor(...COLORS.bg);
        b.doc.text(`L${leg.legNumber}`, b.margin + 10, b.y + 11, { align: 'center' });
        // Route
        b.doc.setFontSize(11);
        b.doc.setTextColor(...COLORS.white);
        b.doc.text(`${leg.departurePort} → ${leg.arrivalPort}`, b.margin + 22, b.y + 8);
        b.doc.setFontSize(7);
        b.doc.setTextColor(...COLORS.dim);
        const subParts = [
            displayNm > 0 ? `${displayNm.toFixed(0)} NM` : null,
            leg.durationHours > 0 ? formatDuration(leg.durationHours) : null,
            leg.departureDateIso ? `Depart ${formatDate(leg.departureDateIso)}` : null,
            leg.arrivalCountry || null,
        ].filter(Boolean);
        b.doc.text(subParts.join('  ·  '), b.margin + 22, b.y + 14);
        // Forecast strip
        if (forecast) {
            b.doc.setDrawColor(...COLORS.divider);
            b.doc.setLineWidth(0.2);
            b.doc.line(b.margin + 22, b.y + 17, b.margin + b.contentW - 4, b.y + 17);
            b.doc.setFontSize(7);
            b.doc.setTextColor(...COLORS.accent);
            const wind = `${forecast.windDirection} ${forecast.windSpeedKt}${
                forecast.windGustKt ? `/${forecast.windGustKt}` : ''
            } kt`;
            const wave = forecast.waveHeightM !== null ? `${forecast.waveHeightM.toFixed(1)} m` : '—';
            b.doc.text(`💨 ${wind}   🌊 ${wave}   ${forecast.condition}`, b.margin + 22, b.y + 22);
        }
        b.y += cardH + 4;
    }

    // ─────────────────────────────────────────────────────────
    // Best Departure Window (live) — top of the next 16 days
    // for the trip's first leg, scored Go / Marginal / Wait.
    // ─────────────────────────────────────────────────────────
    if (bestWindow) {
        b.sectionTitle('Best Departure Window (live)');
        const ratingColor: [number, number, number] =
            bestWindow.rating === 'go' ? COLORS.green : bestWindow.rating === 'marginal' ? COLORS.amber : COLORS.red;
        const ratingLabel =
            bestWindow.rating === 'go' ? '✅ GO' : bestWindow.rating === 'marginal' ? '⚠ MARGINAL' : '✕ WAIT';
        b.ensureRoom(22);
        b.doc.setFillColor(...COLORS.cardBg);
        b.doc.roundedRect(b.margin, b.y, b.contentW, 18, 2, 2, 'F');
        b.doc.setFontSize(9);
        b.doc.setTextColor(...ratingColor);
        b.doc.text(ratingLabel, b.margin + 4, b.y + 6);
        b.doc.setFontSize(11);
        b.doc.setTextColor(...COLORS.white);
        b.doc.text(bestWindow.label, b.margin + 4, b.y + 12);
        b.doc.setFontSize(8);
        b.doc.setTextColor(...COLORS.dim);
        b.doc.text(`${bestWindow.score}/100`, b.margin + b.contentW - 4, b.y + 12, { align: 'right' });
        b.y += 22;
        b.paragraph(bestWindow.description, COLORS.muted, 8.5);
    }

    // ─────────────────────────────────────────────────────────
    // Best time to sail (region-aware blurb — seasonal context)
    // ─────────────────────────────────────────────────────────
    if (trip.countries.some((c) => ['New Caledonia', 'Vanuatu', 'Fiji', 'Tonga', 'French Polynesia'].includes(c))) {
        b.sectionTitle('Best Time to Sail');
        b.paragraph(
            'The South Pacific dry season runs May to October — outside cyclone season (November to April), with reliable southeast trade winds for an eastbound run. Plan departure for a 5-7 day forecast window of sustained 15-25 kt SE/E winds and combined sea/swell under 3 m. A long swell period (8 s+) makes the difference between rough and rolling.',
        );
    }

    // ─────────────────────────────────────────────────────────
    // ENC hazards along route (if a report was supplied)
    // ─────────────────────────────────────────────────────────
    if (opts?.hazardReport && opts.hazardReport.entries.length > 0) {
        renderHazardReportSection(b, opts.hazardReport);
    }

    // ─────────────────────────────────────────────────────────
    // Per-country snippets (visa + biosecurity + ports of entry).
    //
    // Pre-resolved snippets passed in via opts.countrySnippets win —
    // those went through the curated → cache → AI → stub pipeline so
    // every detected country has SOMETHING to show, including the
    // long-tail Caribbean/Med/Asia destinations the curated table
    // doesn't cover. When omitted (e.g. a stand-alone PDF caller),
    // fall back to the synchronous curated-only list.
    // ─────────────────────────────────────────────────────────
    const resolvedSnippets: (
        | ResolvedCountrySnippet
        | (ReturnType<typeof getCountrySnippets>[number] & { source?: undefined; notes?: string })
    )[] =
        opts?.countrySnippets && opts.countrySnippets.length > 0
            ? opts.countrySnippets
            : getCountrySnippets(trip.countries);
    if (resolvedSnippets.length > 0) {
        b.sectionTitle('Customs, Visas & Biosecurity');
        const anyAi = resolvedSnippets.some((s) => 'source' in s && s.source === 'ai');
        if (anyAi) {
            b.paragraph(
                'Entries marked ✦ AI are AI-generated as a starting point. Always verify visa, biosecurity, and Port of Entry rules with the consulate or local maritime authority before departure.',
                COLORS.amber,
                8,
            );
        }
        for (const s of resolvedSnippets) {
            b.ensureRoom(38);
            b.doc.setFillColor(...COLORS.cardBg);
            b.doc.roundedRect(b.margin, b.y, b.contentW, 34, 2, 2, 'F');

            // Country header + source badge (only for AI / stub —
            // curated/cache hits stay silent).
            b.doc.setFontSize(11);
            b.doc.setTextColor(...COLORS.primary);
            b.doc.text(s.country, b.margin + 4, b.y + 6);
            const source = ('source' in s ? s.source : undefined) as 'curated' | 'cache' | 'ai' | 'stub' | undefined;
            if (source === 'ai' || source === 'stub') {
                const badgeText = source === 'ai' ? '✦ AI · verify' : 'Generic · research';
                b.doc.setFontSize(7);
                b.doc.setTextColor(...(source === 'ai' ? ([192, 132, 252] as [number, number, number]) : COLORS.amber));
                const tw = b.doc.getTextWidth(badgeText);
                b.doc.text(badgeText, b.margin + b.contentW - 4 - tw, b.y + 6);
            }

            b.doc.setFontSize(8);
            b.doc.setTextColor(...COLORS.muted);
            const visaLines = wrap(b.doc, `Visa: ${s.visa}`, b.contentW - 8);
            let lineY = b.y + 11;
            for (const line of visaLines) {
                b.doc.text(line, b.margin + 4, lineY);
                lineY += 3.4;
            }
            b.doc.setTextColor(...COLORS.amber);
            const bioLines = wrap(b.doc, `Biosecurity: ${s.biosecurity}`, b.contentW - 8);
            for (const line of bioLines) {
                b.doc.text(line, b.margin + 4, lineY);
                lineY += 3.4;
            }
            b.doc.setTextColor(...COLORS.dim);
            const portsLines = wrap(b.doc, `Ports: ${s.portsOfEntry}`, b.contentW - 8);
            for (const line of portsLines) {
                b.doc.text(line, b.margin + 4, lineY);
                lineY += 3.4;
            }
            if (s.notes) {
                b.doc.setTextColor(...COLORS.dim);
                const notesLines = wrap(b.doc, `Note: ${s.notes}`, b.contentW - 8);
                for (const line of notesLines) {
                    b.doc.text(line, b.margin + 4, lineY);
                    lineY += 3.4;
                }
            }
            const consumed = lineY - b.y + 2;
            b.y += Math.max(consumed, 36);
        }
    }

    // ─────────────────────────────────────────────────────────
    // Crewing & watch schedules
    // ─────────────────────────────────────────────────────────
    b.sectionTitle('Crewing & Watch Schedules');
    b.paragraph(
        `Crew planned: ${trip.crewCount ?? '—'}. Pick the watch system that fits the length of the longest leg AND the experience of your shortest-handed crew member.`,
    );
    for (const w of watchScheduleNotes(trip.crewCount)) {
        b.ensureRoom(14);
        b.doc.setFontSize(10);
        b.doc.setTextColor(...COLORS.green);
        b.doc.text(w.title, b.margin, b.y);
        b.y += 5;
        b.paragraph(w.body, COLORS.muted, 8.5);
    }

    // ─────────────────────────────────────────────────────────
    // Provisioning
    // ─────────────────────────────────────────────────────────
    b.sectionTitle('Provisioning');
    b.bullets(provisioningNotes(trip.totalDurationHours));

    // ─────────────────────────────────────────────────────────
    // Vessel preparation
    // ─────────────────────────────────────────────────────────
    b.sectionTitle('Vessel Preparation');
    b.bullets(VESSEL_PREP);

    // ─────────────────────────────────────────────────────────
    // Safety gear
    // ─────────────────────────────────────────────────────────
    b.sectionTitle('Safety Equipment');
    b.bullets(SAFETY_GEAR);

    // ─────────────────────────────────────────────────────────
    // Medical kit
    // ─────────────────────────────────────────────────────────
    b.sectionTitle('Offshore Medical Kit');
    b.bullets(MEDICAL_KIT);

    // ─────────────────────────────────────────────────────────
    // Closing footer
    // ─────────────────────────────────────────────────────────
    b.ensureRoom(20);
    b.doc.setFillColor(...COLORS.divider);
    b.doc.rect(b.margin, b.y, b.contentW, 0.3, 'F');
    b.y += 4;
    b.doc.setFontSize(7);
    b.doc.setTextColor(...COLORS.dim);
    b.doc.text(
        'Suggested itinerary only — confirm pilotage, channel markers, tide timing, and local hazards on official charts before sailing. Generated by Thalassa Marine Weather.',
        b.margin,
        b.y,
        { maxWidth: b.contentW },
    );

    log.info(`generated trip PDF: ${trip.name}, ${trip.legs.length} legs, ${trip.countries.length} countries`);
    return b.doc.output('blob');
}
