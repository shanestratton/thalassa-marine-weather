/**
 * PassagePdfService — Generate professional passage plan PDFs.
 *
 * Uses jsPDF to create a maritime-themed PDF from PassageBriefData.
 * Dark navy theme with Thalassa branding, suitable for printing
 * or sharing via WhatsApp/Email/AirDrop.
 *
 * Output: a Blob that can be shared via Capacitor Share or saved.
 */

import { jsPDF } from 'jspdf';
import { getFirstLight, getLastLight, moonlightByNight, sunAltitudeDeg } from '../utils/celestial';
import { createLogger } from '../utils/createLogger';
import { calculateDistance } from '../utils/navigationCalculations';
import { resolveTimeZone } from '../utils/timezone';
import { readableZoneName } from '../utils/zoneLabel';
import type { PassageBriefData } from './PassageBriefService';

const log = createLogger('PassagePDF');

// ── Colour Palette (navy maritime theme) ──

const COLORS = {
    bg: [15, 23, 42] as [number, number, number], // slate-900
    cardBg: [30, 41, 59] as [number, number, number], // slate-800
    primary: [56, 189, 248] as [number, number, number], // sky-400
    accent: [20, 184, 166] as [number, number, number], // teal-500
    green: [52, 211, 153] as [number, number, number], // emerald-400
    red: [248, 113, 113] as [number, number, number], // red-400
    amber: [251, 191, 36] as [number, number, number], // amber-400
    white: [241, 245, 249] as [number, number, number], // slate-50
    muted: [148, 163, 184] as [number, number, number], // slate-400
    dim: [100, 116, 139] as [number, number, number], // slate-500
    divider: [51, 65, 85] as [number, number, number], // slate-700
};

// ── Helpers ──

function formatDMS(lat: number, lon: number): string {
    const fmt = (v: number, pos: string, neg: string) => {
        const abs = Math.abs(v);
        const d = Math.floor(abs);
        const m = ((abs - d) * 60).toFixed(1);
        return `${d}°${m}'${v >= 0 ? pos : neg}`;
    };
    return `${fmt(lat, 'N', 'S')} ${fmt(lon, 'E', 'W')}`;
}

function formatDuration(hours: number): string {
    if (hours < 24) return `${hours.toFixed(1)}h`;
    const days = Math.floor(hours / 24);
    const rem = Math.round(hours % 24);
    return `${days}d ${rem}h`;
}

/** Date and time, on `timeZone`'s clock when given (the phone's otherwise). */
function formatDateTime(iso: string, timeZone?: string): string {
    try {
        return new Date(iso).toLocaleString('en-AU', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            ...(timeZone ? { timeZone } : {}),
        });
    } catch {
        return iso;
    }
}

const HOUR_MS = 3_600_000;

const clockIn = (d: Date, timeZone: string) =>
    d.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });

/** "Mon 10 Aug" on `timeZone`'s calendar, built from parts so no locale
 *  punctuation creeps in. */
function dayLabel(ms: number, timeZone: string): string {
    const p: Record<string, string> = {};
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
    for (const part of fmt.formatToParts(ms)) p[part.type] = part.value;
    return `${p.weekday} ${p.day} ${p.month}`;
}

/** A zone as a reader takes it ('Etc/GMT+3' printed as UTC-3): shared with the Glass's sun & moon sheet. */
const zoneName = readableZoneName;

type LatLon = { lat: number; lon: number };

/** Where the boat is at an instant: along the planned route at the planned
 *  pace (origin → turns → destination), taking a date-line crossing the
 *  short way round. */
function routePosition(data: PassageBriefData): (ms: number) => LatLon {
    const pts: LatLon[] = [data.origin, ...(data.turnWaypoints ?? []), data.destination].map((p) => ({ ...p }));
    for (let i = 1; i < pts.length; i++) {
        pts[i].lon -= 360 * Math.round((pts[i].lon - pts[i - 1].lon) / 360);
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + calculateDistance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
    }
    const total = cum[cum.length - 1];
    const dep = Date.parse(data.departureTime);
    const durMs = data.estimatedDuration * HOUR_MS;
    return (ms) => {
        const along = total * Math.min(1, Math.max(0, (ms - dep) / durMs || 0));
        let i = 1;
        while (i < cum.length - 1 && cum[i] < along) i++;
        const f = Math.min(1, (along - cum[i - 1]) / (cum[i] - cum[i - 1] || 1));
        const lon = pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * f;
        return {
            lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * f,
            lon: ((((lon + 180) % 360) + 360) % 360) - 180,
        };
    };
}

export interface ArrivalLight {
    /** Light enough to see by on arrival: the sun no more than 6° down. */
    daylight: boolean;
    /** The destination's IANA zone; every time in `text` is on its clock. */
    timeZone: string;
    text: string;
    /** The destination's civil dusk on the arrival day (or the evening before a pre-dawn arrival). */
    lastLight?: Date;
    /** The destination's next civil dawn after a dark arrival. */
    firstLight?: Date;
}

/**
 * Arrive before dark? Judged at the DESTINATION, by its civil dusk and dawn
 * on its own clock (tz-lookup), naming the zone. Replaces the phone-clock
 * `6 <= hour < 18`, which read a Brisbane phone's 08:30 as daylight for an
 * 18:30 Caribbean landfall and called a midsummer Arctic evening dark.
 */
export function arrivalLightNote(data: PassageBriefData): ArrivalLight {
    const { lat, lon } = data.destination;
    const timeZone = resolveTimeZone(lat, lon);
    const eta = new Date(Date.parse(data.departureTime) + data.estimatedDuration * HOUR_MS);
    if (isNaN(eta.getTime())) {
        return { daylight: false, timeZone, text: 'Estimated arrival unknown: check the departure time.' };
    }
    const lead = `Estimated arrival ${formatDateTime(eta.toISOString(), timeZone)} (${zoneName(timeZone, eta.getTime())} time)`;
    const sun = sunAltitudeDeg(eta, lat, lon);
    const last = getLastLight(eta, lat, lon, timeZone);

    if (sun >= -6) {
        // Daylight or civil twilight by the sun's height at the ETA first: a
        // 00:40 Tromsø arrival in May is twilight even with no true night.
        const how =
            sun < -0.833
                ? 'in civil twilight: light enough to see, with the sun below the horizon.'
                : 'a daylight arrival.';
        if (last.state === 'no-true-night') {
            return {
                daylight: true,
                timeZone,
                text: `${lead} — ${how} There is no true night there at this time of year.`,
            };
        }
        const lastLight = last.at && last.at > eta ? last.at : undefined;
        const tail = lastLight ? ` Last light there is ${clockIn(lastLight, timeZone)}.` : '';
        return { daylight: true, timeZone, text: `${lead} — ${how}${tail}`, lastLight };
    }

    const first = getFirstLight(eta, lat, lon, timeZone);
    if (first.state === 'stays-dark') {
        return {
            daylight: false,
            timeZone,
            text: `${lead} — AFTER DARK. The sun stays more than 6° below the horizon all day there at this time of year: plan the approach for the dark.`,
        };
    }
    // Last light before the ETA (this evening's, or yesterday's for a
    // pre-dawn arrival) and the next first light after it.
    const lastLight =
        last.at && last.at <= eta
            ? last.at
            : (getLastLight(new Date(eta.getTime() - 24 * HOUR_MS), lat, lon, timeZone).at ?? undefined);
    const firstLight =
        first.at && first.at > eta
            ? first.at
            : (getFirstLight(new Date(eta.getTime() + 24 * HOUR_MS), lat, lon, timeZone).at ?? undefined);
    const times = [
        lastLight && `last light there ${clockIn(lastLight, timeZone)}`,
        firstLight &&
            `first light ${clockIn(firstLight, timeZone)}${dayLabel(firstLight.getTime(), timeZone) === dayLabel(eta.getTime(), timeZone) ? '' : ' next morning'}`,
    ].filter(Boolean);
    return {
        daylight: false,
        timeZone,
        text: `${lead} — AFTER DARK${times.length ? ` (${times.join('; ')})` : ''}. Consider adjusting departure or slowing down to make the approach in daylight.`,
        lastLight,
        firstLight,
    };
}

/** Nights listed in the dossier before it summarises the rest. */
const MAX_NIGHT_LINES = 14;

/**
 * One moonlight line per night underway: hours of civil dark at the planned
 * position, the hours the moon is up in it, and illumination × those hours
 * (hours of full-moon-equivalent light). Nights are dated by the evening
 * they begin, on the departure port's clock.
 */
export function passageMoonlightLines(data: PassageBriefData): string[] {
    const dep = Date.parse(data.departureTime);
    const end = dep + data.estimatedDuration * HOUR_MS;
    if (!Number.isFinite(dep) || !(end > dep)) return [];
    const zone = resolveTimeZone(data.origin.lat, data.origin.lon);
    // A half-hour floor: the minutes of dusk on a late arrival are the
    // arrival note's business, not a "night".
    const nights = moonlightByNight(dep, end, routePosition(data)).filter((n) => n.darkHours >= 0.5);
    const lines = nights.slice(0, MAX_NIGHT_LINES).map((n, i) => {
        const ratio = n.moonlightHours / n.darkHours;
        const verdict = ratio >= 0.5 ? 'A bright night.' : ratio >= 0.15 ? 'Some moonlight.' : 'A dark night.';
        const light = n.moonlightHours >= 1 ? n.moonlightHours.toFixed(1) : n.moonlightHours.toFixed(2);
        const moon =
            n.moonUpHours < 0.05
                ? 'The moon stays below the horizon all night.'
                : `Moon up ${n.moonUpHours.toFixed(1)} h of it at ${Math.round(n.illumination * 100)}% lit: ${light} h of full-moon light.`;
        // Dated by the evening the night belongs to: 12 h before its middle (a
        // pre-dawn departure's few dark hours belong to the evening before).
        const evening = (n.startMs + n.endMs) / 2 - 12 * HOUR_MS;
        return `Night ${i + 1} (${dayLabel(evening, zone)}): ${n.darkHours.toFixed(1)} h dark. ${moon} ${verdict}`;
    });
    if (nights.length > MAX_NIGHT_LINES) lines.push(`...and ${nights.length - MAX_NIGHT_LINES} more nights.`);
    return lines;
}

// ── Main PDF Generator ──

export function generatePassagePdf(data: PassageBriefData): Blob {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth(); // 210
    const margin = 14;
    const contentW = W - 2 * margin;
    let y = 0;

    // ── Page background ──
    const fillPage = () => {
        doc.setFillColor(...COLORS.bg);
        doc.rect(0, 0, W, doc.internal.pageSize.getHeight(), 'F');
    };
    fillPage();

    // ── Header ribbon ──
    y = 10;
    doc.setFillColor(...COLORS.cardBg);
    doc.roundedRect(margin, y, contentW, 28, 3, 3, 'F');

    // Logo text
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.dim);
    doc.text('THALASSA — KEEPS WATCH WITH YOU', margin + 6, y + 7);

    doc.setFontSize(16);
    doc.setTextColor(...COLORS.white);
    doc.text('PASSAGE BRIEF', margin + 6, y + 16);

    if (data.vesselName) {
        doc.setFontSize(9);
        doc.setTextColor(...COLORS.muted);
        doc.text(`${data.vesselName}${data.vesselType ? ` • ${data.vesselType}` : ''}`, margin + 6, y + 23);
    }

    // Generation timestamp
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.dim);
    doc.text(formatDateTime(new Date().toISOString()), W - margin - 6, y + 7, { align: 'right' });

    y += 34;

    // ── Route Card ──
    doc.setFillColor(...COLORS.cardBg);
    doc.roundedRect(margin, y, contentW, 22, 3, 3, 'F');

    doc.setFontSize(8);
    doc.setTextColor(...COLORS.dim);
    doc.text('ROUTE', margin + 6, y + 6);

    // Origin
    doc.setFontSize(11);
    doc.setTextColor(...COLORS.green);
    doc.text(data.origin.name, margin + 6, y + 13);

    // Arrow
    doc.setTextColor(...COLORS.dim);
    doc.text('>', margin + 6 + doc.getTextWidth(data.origin.name) + 4, y + 13);

    // Destination
    doc.setTextColor(...COLORS.red);
    const arrowX = margin + 6 + doc.getTextWidth(data.origin.name) + 4 + doc.getTextWidth('→') + 4;
    doc.text(data.destination.name, arrowX, y + 13);

    // Coordinates
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.dim);
    doc.text(formatDMS(data.origin.lat, data.origin.lon), margin + 6, y + 18);
    doc.text(formatDMS(data.destination.lat, data.destination.lon), W - margin - 6, y + 18, { align: 'right' });

    y += 28;

    // ── Stats Grid (2×2) ──
    const statW = (contentW - 4) / 2;
    const statH = 18;
    // Each end on its own clock, zone named (W1-06): the phone's clock read
    // a Caribbean landfall in Brisbane time.
    const originZone = resolveTimeZone(data.origin.lat, data.origin.lon);
    const destZone = resolveTimeZone(data.destination.lat, data.destination.lon);
    const stats = [
        { label: 'DISTANCE', value: `${data.totalDistanceNM.toFixed(0)} NM`, color: COLORS.primary },
        { label: 'DURATION', value: formatDuration(data.estimatedDuration), color: COLORS.amber },
        {
            label: `DEPARTURE (${zoneName(originZone, Date.parse(data.departureTime))})`,
            value: formatDateTime(data.departureTime, originZone),
            color: COLORS.green,
        },
        {
            label: `ESTIMATED ARRIVAL (${zoneName(destZone, Date.parse(data.departureTime) + data.estimatedDuration * HOUR_MS)})`,
            value: formatDateTime(
                new Date(new Date(data.departureTime).getTime() + data.estimatedDuration * 3600_000).toISOString(),
                destZone,
            ),
            color: COLORS.red,
        },
    ];

    stats.forEach((stat, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const sx = margin + col * (statW + 4);
        const sy = y + row * (statH + 3);

        doc.setFillColor(...COLORS.cardBg);
        doc.roundedRect(sx, sy, statW, statH, 2, 2, 'F');

        doc.setFontSize(6);
        doc.setTextColor(...COLORS.dim);
        doc.text(stat.label, sx + statW / 2, sy + 6, { align: 'center' });

        doc.setFontSize(12);
        doc.setTextColor(...stat.color);
        doc.text(stat.value, sx + statW / 2, sy + 14, { align: 'center' });
    });

    y += 2 * (statH + 3) + 4;

    // ── Via Waypoints ──
    if (data.viaWaypoints && data.viaWaypoints.length > 0) {
        doc.setFontSize(7);
        doc.setTextColor(...COLORS.amber);
        doc.text(`Via: ${data.viaWaypoints.map((wp) => wp.name).join(' → ')}`, margin + 6, y + 4);
        y += 10;
    }

    // ── Waypoint Table ──
    if (data.turnWaypoints && data.turnWaypoints.length > 0) {
        doc.setFillColor(...COLORS.cardBg);
        const tableH = 10 + data.turnWaypoints.length * 7;
        doc.roundedRect(margin, y, contentW, tableH, 3, 3, 'F');

        doc.setFontSize(8);
        doc.setTextColor(...COLORS.white);
        doc.text('WAYPOINTS', margin + 6, y + 7);

        // Header row
        y += 12;
        doc.setFontSize(6);
        doc.setTextColor(...COLORS.dim);
        doc.text('#', margin + 6, y);
        doc.text('NAME', margin + 16, y);
        doc.text('POSITION', margin + 70, y);
        doc.text('WIND', margin + 130, y);
        doc.text('BRG', margin + 155, y);

        // Draw divider
        doc.setDrawColor(...COLORS.divider);
        doc.line(margin + 6, y + 1.5, W - margin - 6, y + 1.5);

        // Data rows
        data.turnWaypoints.forEach((wp, i) => {
            y += 7;
            if (y > 270) {
                doc.addPage();
                fillPage();
                y = 15;
            }

            doc.setFontSize(7);
            doc.setTextColor(...COLORS.dim);
            doc.text(`${i + 1}`, margin + 6, y);

            doc.setTextColor(...COLORS.white);
            doc.text(wp.name || `WP${i + 1}`, margin + 16, y);

            doc.setFontSize(6);
            doc.setTextColor(...COLORS.muted);
            doc.text(formatDMS(wp.lat, wp.lon), margin + 70, y);

            doc.setTextColor(...COLORS.primary);
            doc.text(wp.tws !== undefined ? `${wp.tws.toFixed(0)} kts` : '—', margin + 130, y);

            doc.text(wp.bng !== undefined ? `${Math.round(wp.bng)}°` : '—', margin + 155, y);
        });

        y += 10;
    }

    // ── Tides Section ──
    if (
        (data.departureTides && data.departureTides.length > 0) ||
        (data.arrivalTides && data.arrivalTides.length > 0)
    ) {
        if (y > 240) {
            doc.addPage();
            fillPage();
            y = 15;
        }

        doc.setFillColor(...COLORS.cardBg);
        const tideH = 30;
        doc.roundedRect(margin, y, contentW, tideH, 3, 3, 'F');

        doc.setFontSize(8);
        doc.setTextColor(...COLORS.white);
        doc.text('TIDES', margin + 6, y + 7);

        y += 12;
        const halfW = (contentW - 10) / 2;

        // Departure tides
        if (data.departureTides && data.departureTides.length > 0) {
            doc.setFontSize(6);
            doc.setTextColor(...COLORS.green);
            doc.text(`DEPARTURE — ${data.origin.name}`, margin + 6, y);

            const depTime = new Date(data.departureTime);
            const nearest = [...data.departureTides]
                .map((t) => ({ ...t, delta: Math.abs(new Date(t.time).getTime() - depTime.getTime()) }))
                .sort((a, b) => a.delta - b.delta)
                .slice(0, 2);

            nearest.forEach((t, i) => {
                const color = t.type.toLowerCase().includes('high') ? COLORS.primary : COLORS.muted;
                doc.setFontSize(6);
                doc.setTextColor(...color);
                doc.text(
                    `${t.type.toUpperCase()} ${t.height.toFixed(1)}m @ ${formatDateTime(t.time, originZone)}`,
                    margin + 8,
                    y + 5 + i * 4,
                );
            });
        }

        // Arrival tides
        if (data.arrivalTides && data.arrivalTides.length > 0) {
            doc.setFontSize(6);
            doc.setTextColor(...COLORS.red);
            doc.text(`ARRIVAL — ${data.destination.name}`, margin + halfW + 10, y);

            const arrTime = new Date(new Date(data.departureTime).getTime() + data.estimatedDuration * 3600_000);
            const nearest = [...data.arrivalTides]
                .map((t) => ({ ...t, delta: Math.abs(new Date(t.time).getTime() - arrTime.getTime()) }))
                .sort((a, b) => a.delta - b.delta)
                .slice(0, 2);

            nearest.forEach((t, i) => {
                const color = t.type.toLowerCase().includes('high') ? COLORS.primary : COLORS.muted;
                doc.setFontSize(6);
                doc.setTextColor(...color);
                doc.text(
                    `${t.type.toUpperCase()} ${t.height.toFixed(1)}m @ ${formatDateTime(t.time, destZone)}`,
                    margin + halfW + 12,
                    y + 5 + i * 4,
                );
            });
        }

        y += 20;
    }

    // ═══ DOSSIER SECTIONS ═══
    // The brief used to stop at the stat grid — "not showing much" (Shane
    // 2026-08-04, with his South Pacific reference dossier). These sections
    // raise it to that level: passage character, watch schedule,
    // provisioning and a preparedness checklist, all in the same card style.

    const pageH = doc.internal.pageSize.getHeight();
    const ensureSpace = (needed: number) => {
        if (y + needed > pageH - 18) {
            doc.addPage();
            fillPage();
            y = 15;
        }
    };
    /** Card with a section title; returns the y where body content starts. */
    const sectionCard = (title: string, bodyH: number): number => {
        ensureSpace(bodyH + 16);
        doc.setFillColor(...COLORS.cardBg);
        doc.roundedRect(margin, y, contentW, bodyH + 12, 3, 3, 'F');
        doc.setFontSize(8);
        doc.setTextColor(...COLORS.white);
        doc.text(title, margin + 6, y + 7);
        return y + 12;
    };
    const bodyWidth = contentW - 12;

    // ── Passage Plan (character + arrival read) ──
    {
        const hours = data.estimatedDuration;
        const days = hours / 24;
        const character =
            hours <= 10
                ? `A day sail of ${data.totalDistanceNM.toFixed(0)} NM at ${data.speed.toFixed(1)} kts — about ${formatDuration(hours)} underway.`
                : hours <= 36
                  ? `An overnight passage of ${data.totalDistanceNM.toFixed(0)} NM at ${data.speed.toFixed(1)} kts — about ${formatDuration(hours)} underway. Run a formal watch schedule from the first evening.`
                  : `A multi-day passage of ${data.totalDistanceNM.toFixed(0)} NM at ${data.speed.toFixed(1)} kts — roughly ${Math.ceil(days)} days at sea. Provision, crew and rest accordingly; the first 48 hours are the hardest while everyone finds their sea legs.`;

        // The destination's civil dusk and dawn on its own clock (W1-06).
        const arrival = arrivalLightNote(data);
        const daylightArrival = arrival.daylight;
        const arrivalNote = arrival.text;

        doc.setFontSize(7);
        const charLines = doc.splitTextToSize(character, bodyWidth) as string[];
        const arrLines = doc.splitTextToSize(arrivalNote, bodyWidth) as string[];
        const bodyH = (charLines.length + arrLines.length) * 3.6 + 6;
        const by = sectionCard('PASSAGE PLAN', bodyH);
        doc.setFontSize(7);
        doc.setTextColor(...COLORS.muted);
        doc.text(charLines, margin + 6, by + 2);
        doc.setTextColor(...(daylightArrival ? COLORS.green : COLORS.amber));
        doc.text(arrLines, margin + 6, by + 2 + charLines.length * 3.6 + 2);
        y = by + bodyH + 6;
    }

    // ── Moonlight (one line per night underway, W1-06) ──
    {
        const nightLines = passageMoonlightLines(data);
        if (nightLines.length > 0) {
            const intro = `Dark hours each night underway (sun more than 6° down) at the planned position, and how much of them the moon lights. Nights are dated by their evening, ${zoneName(originZone, Date.parse(data.departureTime))} time.`;
            doc.setFontSize(7);
            const introLines = doc.splitTextToSize(intro, bodyWidth) as string[];
            const rows = nightLines.flatMap((l) => doc.splitTextToSize(l, bodyWidth - 2) as string[]);
            const bodyH = (introLines.length + rows.length) * 3.6 + 6;
            const by = sectionCard('MOONLIGHT', bodyH);
            doc.setFontSize(7);
            doc.setTextColor(...COLORS.muted);
            doc.text(introLines, margin + 6, by + 2);
            doc.setTextColor(...COLORS.primary);
            doc.text(rows, margin + 8, by + 2 + introLines.length * 3.6 + 2);
            y = by + bodyH + 6;
        }
    }

    // ── Watch Schedule (crew-count derived, passages > 8h) ──
    if ((data.crewCount ?? 0) >= 1 && data.estimatedDuration > 8) {
        const crew = Math.max(data.crewCount ?? 1, 1);
        let rows: string[];
        let intro: string;
        if (crew === 1) {
            intro = 'Single-handed: there is no off-watch. Rest in short cycles and make the boat sail itself.';
            rows = [
                'Set a 20-minute alarm cycle for horizon scans and AIS checks.',
                'Heave-to or slow down to rest; sleep before fatigue decides for you.',
                'File a float plan ashore and check in on schedule.',
            ];
        } else {
            const onH = 3;
            const offH = onH * (crew - 1);
            intro = `${crew} crew — suggested rotation ${onH}h on / ${offH}h off, dogged so nobody owns the 0200 watch every night.`;
            const names = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, crew);
            rows = [];
            for (let slot = 0; slot < 8; slot++) {
                const start = slot * 3;
                const who = names[slot % crew];
                rows.push(`${String(start).padStart(2, '0')}00-${String(start + 3).padStart(2, '0')}00  Watch ${who}`);
            }
        }
        doc.setFontSize(7);
        const introLines = doc.splitTextToSize(intro, bodyWidth) as string[];
        const bodyH = introLines.length * 3.6 + rows.length * 3.6 + 6;
        const by = sectionCard('WATCH SCHEDULE', bodyH);
        doc.setFontSize(7);
        doc.setTextColor(...COLORS.muted);
        doc.text(introLines, margin + 6, by + 2);
        doc.setTextColor(...COLORS.primary);
        rows.forEach((row, i) => {
            doc.text(row, margin + 8, by + 2 + introLines.length * 3.6 + 2 + i * 3.6);
        });
        y = by + bodyH + 6;
    }

    // ── Provisioning (crew × duration derived) ──
    if (data.estimatedDuration > 8) {
        const crew = Math.max(data.crewCount ?? 1, 1);
        const days = Math.max(1, Math.ceil(data.estimatedDuration / 24));
        const meals = crew * days * 3;
        const waterL = Math.ceil(crew * days * 3 * 1.5);
        const numbers = `${crew} aboard for ~${days} day${days > 1 ? 's' : ''}: plan ${meals} meals and ${waterL} L water (3 L/person/day + 50% reserve).`;
        const tips = [
            "Pre-cook and freeze the first days' dinners — assume nobody wants to cook until day 3.",
            'Day 1 grab-and-go: pre-made wraps, a roasted "passage chicken", boiled eggs.',
            'Stock a night-watch snack station: bars, nuts, chocolate, biscuits.',
            'Decant packets into sealable containers; strip cardboard ashore.',
        ];
        doc.setFontSize(7);
        const numLines = doc.splitTextToSize(numbers, bodyWidth) as string[];
        const tipLines = tips.flatMap((t) => doc.splitTextToSize(`- ${t}`, bodyWidth) as string[]);
        const bodyH = numLines.length * 3.6 + tipLines.length * 3.6 + 6;
        const by = sectionCard('PROVISIONING', bodyH);
        doc.setFontSize(7);
        doc.setTextColor(...COLORS.amber);
        doc.text(numLines, margin + 6, by + 2);
        doc.setTextColor(...COLORS.muted);
        doc.text(tipLines, margin + 6, by + 2 + numLines.length * 3.6 + 2);
        y = by + bodyH + 6;
    }

    // ── Preparedness Checklist (two columns of checkboxes) ──
    {
        const items = [
            'Rig: visual check, split pins taped',
            'Engine serviced, impeller inspected',
            'Fuel + reserve for calms',
            'Bilge pumps tested, floats verified',
            'Steering checked, emergency tiller',
            'Through-hulls free, bungs attached',
            'Storm sails accessible',
            'EPIRB / PLB registered, in date',
            'Liferaft in service, grab bag packed',
            'Flares in date',
            'Jacklines rigged, tethers aboard',
            'Nav lights + torches checked',
            'MOB gear ready, drill refreshed',
            'VHF check, DSC MMSI programmed',
            'Charts + publications aboard',
            'Float plan sent to shore contact',
        ];
        const colW = (contentW - 12) / 2;
        const perCol = Math.ceil(items.length / 2);
        const bodyH = perCol * 4.6 + 4;
        const by = sectionCard('PREPAREDNESS', bodyH);
        doc.setFontSize(6.5);
        items.forEach((item, i) => {
            const col = i < perCol ? 0 : 1;
            const row = i % perCol;
            const ix = margin + 6 + col * (colW + 6);
            const iy = by + 2 + row * 4.6;
            doc.setDrawColor(...COLORS.dim);
            doc.rect(ix, iy - 2.4, 2.6, 2.6);
            doc.setTextColor(...COLORS.muted);
            doc.text(item, ix + 4.5, iy);
        });
        y = by + bodyH + 6;
    }

    // ── Safety & Comms ──
    {
        const crew = Math.max(data.crewCount ?? 1, 1);
        const lines = [
            `Souls on board: ${crew}. Leave a float plan with one shore contact — overdue alarm at ETA + 10% of passage time.`,
            'Keep a listening watch on VHF 16. Log position, course and speed every 2 hours (every hour in heavy weather).',
            'On arrival, close out the float plan — an uncancelled plan starts a real search.',
        ];
        doc.setFontSize(7);
        const wrapped = lines.flatMap((l) => doc.splitTextToSize(l, bodyWidth) as string[]);
        const bodyH = wrapped.length * 3.6 + 4;
        const by = sectionCard('SAFETY + COMMS', bodyH);
        doc.setFontSize(7);
        doc.setTextColor(...COLORS.muted);
        doc.text(wrapped, margin + 6, by + 2);
        y = by + bodyH + 6;
    }

    // ── Footer ──
    if (y > 260) {
        doc.addPage();
        fillPage();
        y = 15;
    }

    doc.setDrawColor(...COLORS.divider);
    doc.line(margin, y + 4, W - margin, y + 4);

    doc.setFontSize(7);
    doc.setTextColor(...COLORS.dim);
    doc.text('Generated by Thalassa — keeps watch with you', W / 2, y + 10, { align: 'center' });
    doc.text(
        'Not a substitute for proper passage planning. Use in conjunction with official charts and publications.',
        W / 2,
        y + 14,
        { align: 'center' },
    );

    // Output
    const fileName = `Passage_${data.origin.name}_to_${data.destination.name}.pdf`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    log.info(`[PDF] Generated: ${fileName}`);

    return doc.output('blob');
}

/**
 * Generate PDF and return as a data URI for sharing.
 */
export function generatePassagePdfDataUri(data: PassageBriefData): string {
    // Re-use the same generator logic but output as data URI
    const blob = generatePassagePdf(data);
    // For data URI, we need to re-generate
    return URL.createObjectURL(blob);
}

/**
 * Get a suggested filename for the PDF.
 */
export function getPassagePdfFileName(data: PassageBriefData): string {
    return `Passage_${data.origin.name}_to_${data.destination.name}.pdf`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}
