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
import { createLogger } from '../utils/createLogger';
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

function formatDateTime(iso: string): string {
    try {
        return new Date(iso).toLocaleString('en-AU', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    } catch {
        return iso;
    }
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
    doc.text('THALASSA MARINE WEATHER', margin + 6, y + 7);

    doc.setFontSize(16);
    doc.setTextColor(...COLORS.white);
    doc.text('⛵ PASSAGE BRIEF', margin + 6, y + 16);

    if (data.vesselName) {
        doc.setFontSize(9);
        doc.setTextColor(...COLORS.muted);
        doc.text(`🚢 ${data.vesselName}${data.vesselType ? ` • ${data.vesselType}` : ''}`, margin + 6, y + 23);
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
    doc.text('→', margin + 6 + doc.getTextWidth(data.origin.name) + 4, y + 13);

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
    const stats = [
        { label: 'DISTANCE', value: `${data.totalDistanceNM.toFixed(0)} NM`, color: COLORS.primary },
        { label: 'DURATION', value: formatDuration(data.estimatedDuration), color: COLORS.amber },
        { label: 'DEPARTURE', value: formatDateTime(data.departureTime), color: COLORS.green },
        {
            label: 'ESTIMATED ARRIVAL',
            value: formatDateTime(
                new Date(new Date(data.departureTime).getTime() + data.estimatedDuration * 3600_000).toISOString(),
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
        doc.text('🧭 WAYPOINTS', margin + 6, y + 7);

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
            doc.text(`${wp.lat.toFixed(4)}, ${wp.lon.toFixed(4)}`, margin + 70, y);

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
        doc.text('🌊 TIDES', margin + 6, y + 7);

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
                const icon = t.type.toLowerCase().includes('high') ? '▲' : '▼';
                const color = t.type.toLowerCase().includes('high') ? COLORS.primary : COLORS.muted;
                doc.setFontSize(6);
                doc.setTextColor(...color);
                doc.text(
                    `${icon} ${t.type.toUpperCase()} ${t.height.toFixed(1)}m @ ${formatDateTime(t.time)}`,
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
                const icon = t.type.toLowerCase().includes('high') ? '▲' : '▼';
                const color = t.type.toLowerCase().includes('high') ? COLORS.primary : COLORS.muted;
                doc.setFontSize(6);
                doc.setTextColor(...color);
                doc.text(
                    `${icon} ${t.type.toUpperCase()} ${t.height.toFixed(1)}m @ ${formatDateTime(t.time)}`,
                    margin + halfW + 12,
                    y + 5 + i * 4,
                );
            });
        }

        y += 20;
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
    doc.text('Generated by Thalassa Marine Weather', W / 2, y + 10, { align: 'center' });
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
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
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
