/**
 * @filesize-justified Single sequential PDF generator function. Already imports logExportHelpers. Splitting would create artificial boundaries in a linear rendering pipeline.
 */
/**
 * Ship's Log Export — PDF Rendering
 * Generates the Deck Log PDF using jsPDF
 */

import { ShipLogEntry } from '../types';
import type { jsPDF as JsPDFType } from 'jspdf';
import { convertMetersTo } from './units';
import {
    VesselData,
    degreesToCardinal16,
    decodeHtmlEntities,
    reverseGeocode,
    fetchMapboxStaticImage,
} from './logExportHelpers';

import { createLogger } from './createLogger';

const log = createLogger('logExportPdf');

/**
 * Draw an angled compass rose watermark on the page
 * Positioned coming in from the bottom-left at an angle
 */
function drawCompassRoseWatermark(pdf: JsPDFType, pageWidth: number, pageHeight: number): void {
    const centerX = 35; // Coming in from left
    const centerY = pageHeight - 40; // Near bottom
    const radius = 28;
    const angle = -15 * (Math.PI / 180); // 15 degrees rotation

    // Set low opacity so watermark appears behind content
    const gState = new (pdf as unknown as { GState: new (opts: { opacity: number }) => string }).GState({
        opacity: 0.15,
    });
    pdf.setGState(gState);

    pdf.setDrawColor(180, 185, 190); // Slightly darker since opacity is low
    pdf.setLineWidth(0.3);

    // Helper to rotate a point around center
    const rotate = (x: number, y: number) => {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const dx = x - centerX;
        const dy = y - centerY;
        return {
            x: centerX + dx * cos - dy * sin,
            y: centerY + dx * sin + dy * cos,
        };
    };

    // Outer circles
    pdf.circle(centerX, centerY, radius, 'S');
    pdf.circle(centerX, centerY, radius * 0.82, 'S');
    pdf.circle(centerX, centerY, radius * 0.2, 'S');

    // 8-point star with rotation
    for (let i = 0; i < 8; i++) {
        const baseAngle = (i * Math.PI * 2) / 8 - Math.PI / 2 + angle;
        const innerR = radius * 0.25;
        const outerR = i % 2 === 0 ? radius * 0.9 : radius * 0.55;

        const x1 = centerX + Math.cos(baseAngle) * innerR;
        const y1 = centerY + Math.sin(baseAngle) * innerR;
        const x2 = centerX + Math.cos(baseAngle) * outerR;
        const y2 = centerY + Math.sin(baseAngle) * outerR;

        pdf.line(x1, y1, x2, y2);

        // Arrow heads on cardinal points
        if (i % 2 === 0) {
            const tipX = centerX + Math.cos(baseAngle) * outerR;
            const tipY = centerY + Math.sin(baseAngle) * outerR;
            const leftAngle = baseAngle + 2.8;
            const rightAngle = baseAngle - 2.8;
            const arrowLen = radius * 0.12;

            pdf.line(tipX, tipY, tipX + Math.cos(leftAngle) * arrowLen, tipY + Math.sin(leftAngle) * arrowLen);
            pdf.line(tipX, tipY, tipX + Math.cos(rightAngle) * arrowLen, tipY + Math.sin(rightAngle) * arrowLen);
        }
    }

    // 16 tick marks
    for (let i = 0; i < 16; i++) {
        const tickAngle = (i * Math.PI * 2) / 16 - Math.PI / 2 + angle;
        const x1 = centerX + Math.cos(tickAngle) * radius * 0.82;
        const y1 = centerY + Math.sin(tickAngle) * radius * 0.82;
        const x2 = centerX + Math.cos(tickAngle) * radius * 0.74;
        const y2 = centerY + Math.sin(tickAngle) * radius * 0.74;
        pdf.line(x1, y1, x2, y2);
    }

    // Cardinal letters (rotated positions)
    pdf.setFontSize(9);
    pdf.setTextColor(200, 205, 210);
    pdf.setFont('helvetica', 'bold');

    const labelDist = radius + 5;
    const nPos = rotate(centerX, centerY - labelDist);
    const sPos = rotate(centerX, centerY + labelDist);
    const ePos = rotate(centerX + labelDist, centerY);
    const wPos = rotate(centerX - labelDist, centerY);

    pdf.text('N', nPos.x, nPos.y + 2, { align: 'center' });
    pdf.text('S', sPos.x, sPos.y + 2, { align: 'center' });
    pdf.text('E', ePos.x, ePos.y + 2, { align: 'center' });
    pdf.text('W', wPos.x, wPos.y + 2, { align: 'center' });

    // Reset opacity to 100% for subsequent drawing
    const resetState = new (pdf as unknown as { GState: new (opts: { opacity: number }) => string }).GState({
        opacity: 1.0,
    });
    pdf.setGState(resetState);
}

/**
 * Thin high-frequency log entries for PDF export.
 * With 5s capture intervals, a 1-hour trip can generate 720+ entries.
 * A deck log PDF should show the "story" of the voyage, not every fix.
 *
 * ALWAYS KEPT (never thinned):
 *   - First and last entry overall
 *   - Manual entries, waypoints, events (anything the user explicitly logged)
 *   - Entries with significant course change (>15°) or speed change (>2 kts)
 *
 * TIME-SAMPLED (auto entries in dense segments):
 *   - If >30 entries/hour detected → keep one per 2 minutes
 *   - If 6-30 entries/hour → keep one per 5 minutes
 *   - If ≤6 entries/hour → keep everything (already sparse = offshore)
 *
 * This handles mixed coastal→offshore→coastal passages naturally.
 */
function thinEntriesForPDF(entries: ShipLogEntry[]): ShipLogEntry[] {
    if (entries.length <= 30) return entries; // Already small enough

    // Sort chronologically
    const sorted = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Calculate overall density (entries per hour)
    const firstTime = new Date(sorted[0].timestamp).getTime();
    const lastTime = new Date(sorted[sorted.length - 1].timestamp).getTime();
    const durationHrs = (lastTime - firstTime) / (1000 * 60 * 60);
    const entriesPerHour = durationHrs > 0 ? sorted.length / durationHrs : sorted.length;

    // If already sparse (≤6/hr), keep everything
    if (entriesPerHour <= 6) return entries;

    // Determine sampling interval based on density
    const samplingMs =
        entriesPerHour > 30
            ? 2 * 60 * 1000 // >30/hr (5s intervals) → keep one per 2 min
            : 5 * 60 * 1000; // 6-30/hr → keep one per 5 min

    const kept: ShipLogEntry[] = [];
    let lastKeptTime = 0;
    let lastCourse: number | undefined;
    let lastSpeed: number | undefined;

    sorted.forEach((entry, idx) => {
        const entryTime = new Date(entry.timestamp).getTime();

        // RULE 1: Always keep first and last
        if (idx === 0 || idx === sorted.length - 1) {
            kept.push(entry);
            lastKeptTime = entryTime;
            lastCourse = entry.courseDeg;
            lastSpeed = entry.speedKts;
            return;
        }

        // RULE 2: Always keep non-auto entries (manual, waypoint, events)
        if (entry.entryType !== 'auto') {
            kept.push(entry);
            lastKeptTime = entryTime;
            lastCourse = entry.courseDeg;
            lastSpeed = entry.speedKts;
            return;
        }

        // RULE 3: Always keep significant course changes (>15°)
        if (entry.courseDeg !== undefined && lastCourse !== undefined) {
            let courseDelta = Math.abs(entry.courseDeg - lastCourse);
            if (courseDelta > 180) courseDelta = 360 - courseDelta;
            if (courseDelta > 15) {
                kept.push(entry);
                lastKeptTime = entryTime;
                lastCourse = entry.courseDeg;
                lastSpeed = entry.speedKts;
                return;
            }
        }

        // RULE 4: Always keep significant speed changes (>2 kts)
        if (entry.speedKts !== undefined && lastSpeed !== undefined) {
            if (Math.abs(entry.speedKts - lastSpeed) > 2) {
                kept.push(entry);
                lastKeptTime = entryTime;
                lastCourse = entry.courseDeg;
                lastSpeed = entry.speedKts;
                return;
            }
        }

        // RULE 5: Always keep entries with notes
        if (entry.notes && entry.notes.trim().length > 0) {
            kept.push(entry);
            lastKeptTime = entryTime;
            lastCourse = entry.courseDeg;
            lastSpeed = entry.speedKts;
            return;
        }

        // RULE 6: Time-sample — keep if enough time has elapsed
        if (entryTime - lastKeptTime >= samplingMs) {
            kept.push(entry);
            lastKeptTime = entryTime;
            lastCourse = entry.courseDeg;
            lastSpeed = entry.speedKts;
        }
    });

    return kept;
}

/**
 * Generate the Deck Log PDF using jsPDF
 */
export async function generateDeckLogPDF(
    entries: ShipLogEntry[],
    vesselName?: string,
    vesselData?: VesselData,
): Promise<JsPDFType> {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
    });

    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 15;
    const contentWidth = pageWidth - margin * 2;

    // Sort entries (newest first for display, but we'll reverse for chronological)
    const sortedEntries = [...entries].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    // Calculate statistics
    const startTime =
        sortedEntries.length > 0 ? new Date(sortedEntries[sortedEntries.length - 1].timestamp) : new Date();
    const endTime = sortedEntries.length > 0 ? new Date(sortedEntries[0].timestamp) : new Date();
    const totalDistance =
        sortedEntries.length > 0 ? Math.max(...sortedEntries.map((e) => e.cumulativeDistanceNM || 0), 0) : 0;

    const durationMs = endTime.getTime() - startTime.getTime();
    const durationHours = Math.round(durationMs / (1000 * 60 * 60));

    const speeds = entries.filter((e) => e.speedKts && e.speedKts > 0).map((e) => e.speedKts!);
    const avgSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;

    // Format dates with times: "05 Feb 2026 (15:43)"
    const formatDate = (d: Date) => {
        const day = d.getDate().toString().padStart(2, '0');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[d.getMonth()];
        const year = d.getFullYear();
        const hours = d.getHours().toString().padStart(2, '0');
        const mins = d.getMinutes().toString().padStart(2, '0');
        return `${day} ${month} ${year} (${hours}:${mins})`;
    };
    const startDateStr = formatDate(startTime);
    const endDateStr = formatDate(endTime);
    const vessel = vesselName || 'Vessel';

    // Get start/end entries for route info
    const chronoEntriesForRoute = [...sortedEntries].reverse();
    const startRouteEntry = chronoEntriesForRoute.find((e) => e.latitude && e.longitude);
    const endRouteEntry = [...chronoEntriesForRoute].reverse().find((e) => e.latitude && e.longitude);

    // Reverse geocode start and end locations
    let startLocationName = '';
    let endLocationName = '';

    if (startRouteEntry) {
        startLocationName = await reverseGeocode(startRouteEntry.latitude!, startRouteEntry.longitude!);
    }
    if (endRouteEntry) {
        endLocationName = await reverseGeocode(endRouteEntry.latitude!, endRouteEntry.longitude!);
    }

    // Reverse geocode waypoints (up to 5)
    const waypointEntriesPreload = chronoEntriesForRoute.filter(
        (e) => e.entryType === 'waypoint' && e.latitude && e.longitude,
    );
    const waypointNames: Map<number, string> = new Map();

    for (let i = 0; i < Math.min(5, waypointEntriesPreload.length); i++) {
        const wp = waypointEntriesPreload[i];
        try {
            const wpName = await reverseGeocode(wp.latitude!, wp.longitude!);
            waypointNames.set(i, wpName);
        } catch (e) {
            log.warn('[logExport]', e);
            // Use coords as fallback
        }
    }

    // Group entries by date
    const entriesByDate = new Map<string, ShipLogEntry[]>();
    // Thin entries for PDF — high-frequency (5s) captures produce too many rows.
    // Statistics above are computed from ALL entries for accuracy.
    // The table below uses the thinned subset for readability.
    const thinnedEntries = thinEntriesForPDF([...sortedEntries].reverse());
    const chronoEntries = thinnedEntries;

    chronoEntries.forEach((entry) => {
        const d = new Date(entry.timestamp);
        const dateKey = d
            .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
            .toUpperCase();
        if (!entriesByDate.has(dateKey)) {
            entriesByDate.set(dateKey, []);
        }
        entriesByDate.get(dateKey)!.push(entry);
    });

    let y = 0;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let pageNum = 1;

    // ===== TITLE PAGE / FIRST PAGE =====

    // Navy header bar
    pdf.setFillColor(26, 42, 58);
    pdf.rect(0, 0, pageWidth, 55, 'F');

    // Title
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(24);
    pdf.setFont('helvetica', 'bold');
    pdf.text('OFFICIAL DECK LOG', pageWidth / 2, 28, { align: 'center' });

    // Subtitle with route
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'normal');
    const routeText =
        startLocationName && endLocationName ? `${startLocationName} to ${endLocationName}` : 'Voyage Record';
    pdf.text(routeText, pageWidth / 2, 40, { align: 'center' });

    // Date range
    pdf.setFontSize(10);
    pdf.text(`${startDateStr} - ${endDateStr}`, pageWidth / 2, 48, { align: 'center' });

    // Gold accent line
    pdf.setDrawColor(201, 162, 39);
    pdf.setLineWidth(1.5);
    pdf.line(margin + 20, 53, pageWidth - margin - 20, 53);

    y = 70;

    // Summary box
    pdf.setDrawColor(200, 200, 200);
    pdf.setLineWidth(0.3);
    pdf.roundedRect(margin, y, contentWidth, 25, 3, 3, 'S');

    const boxY = y + 8;
    const colWidth = contentWidth / 4;

    pdf.setTextColor(26, 42, 58);
    pdf.setFontSize(18);
    pdf.setFont('helvetica', 'bold');

    // Distance
    pdf.text(`${totalDistance.toFixed(1)} NM`, margin + colWidth * 0.5, boxY, { align: 'center' });
    // Avg Speed
    pdf.text(`${avgSpeed.toFixed(1)} kts`, margin + colWidth * 1.5, boxY, { align: 'center' });
    // Duration
    pdf.text(`${durationHours}h`, margin + colWidth * 2.5, boxY, { align: 'center' });
    // Entries
    pdf.text(`${entries.length}`, margin + colWidth * 3.5, boxY, { align: 'center' });

    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(106, 122, 138);
    pdf.text('Distance', margin + colWidth * 0.5, boxY + 8, { align: 'center' });
    pdf.text('Avg Speed', margin + colWidth * 1.5, boxY + 8, { align: 'center' });
    pdf.text('Duration', margin + colWidth * 2.5, boxY + 8, { align: 'center' });
    pdf.text('Entries', margin + colWidth * 3.5, boxY + 8, { align: 'center' });

    y += 35;

    // ===== DEPARTURE WEATHER HEADER =====
    // Add weather conditions at the start of the log for reader context
    const sortedByTimeForWeather = [...entries].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const departureForHeader = sortedByTimeForWeather[0];
    const waveUnit = vesselData?.units?.waveHeight || 'ft';

    if (
        departureForHeader &&
        (departureForHeader.windSpeed || departureForHeader.waveHeight || departureForHeader.pressure)
    ) {
        pdf.setFillColor(26, 42, 58); // Navy background
        pdf.roundedRect(margin, y, contentWidth, 18, 2, 2, 'F');

        // Header title
        pdf.setTextColor(201, 162, 39); // Gold text
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'bold');
        const depTime = new Date(departureForHeader.timestamp);
        const depTimeStr = depTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        pdf.text(`Departure Conditions (${depTimeStr})`, margin + 4, y + 6);

        // Weather data row
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'normal');

        const wxParts: string[] = [];
        if (departureForHeader.windSpeed) {
            const gustStr = departureForHeader.windGust ? ` G${Math.round(departureForHeader.windGust)}` : '';
            wxParts.push(
                `Wind: ${departureForHeader.windSpeed}kts${gustStr} ${departureForHeader.windDirection || ''}`,
            );
        }
        if (departureForHeader.beaufortScale !== undefined) {
            wxParts.push(`Beaufort: F${departureForHeader.beaufortScale}`);
        }
        if (departureForHeader.waveHeight) {
            const waveVal = convertMetersTo(departureForHeader.waveHeight, waveUnit);
            wxParts.push(`Waves: ${waveVal !== null ? waveVal.toFixed(1) : '?'}${waveUnit}`);
        }
        if (departureForHeader.seaState !== undefined) {
            wxParts.push(`Sea State: ${departureForHeader.seaState}`);
        }
        if (departureForHeader.pressure) {
            wxParts.push(`Barometric Pressure: ${Math.round(departureForHeader.pressure)}mb`);
        }
        if (departureForHeader.airTemp !== undefined) {
            wxParts.push(`Air: ${departureForHeader.airTemp}°C`);
        }
        if (departureForHeader.waterTemp !== undefined) {
            wxParts.push(`Sea: ${departureForHeader.waterTemp}°C`);
        }

        pdf.text(wxParts.join('     '), margin + 4, y + 13);

        y += 24;
    }

    // ===== ARRIVAL WEATHER HEADER =====
    // Add weather conditions at the end of the log for arrival context
    const arrivalForHeader = sortedByTimeForWeather[sortedByTimeForWeather.length - 1];

    if (
        arrivalForHeader &&
        arrivalForHeader !== departureForHeader &&
        (arrivalForHeader.windSpeed || arrivalForHeader.waveHeight || arrivalForHeader.pressure)
    ) {
        pdf.setFillColor(26, 42, 58); // Navy background
        pdf.roundedRect(margin, y, contentWidth, 18, 2, 2, 'F');

        // Header title
        pdf.setTextColor(201, 162, 39); // Gold text
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'bold');
        const arrTime = new Date(arrivalForHeader.timestamp);
        const arrTimeStr = arrTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        pdf.text(`Arrival Conditions (${arrTimeStr})`, margin + 4, y + 6);

        // Weather data row
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'normal');

        const arrWxParts: string[] = [];
        if (arrivalForHeader.windSpeed) {
            const gustStr = arrivalForHeader.windGust ? ` G${Math.round(arrivalForHeader.windGust)}` : '';
            arrWxParts.push(`Wind: ${arrivalForHeader.windSpeed}kts${gustStr} ${arrivalForHeader.windDirection || ''}`);
        }
        if (arrivalForHeader.beaufortScale !== undefined) {
            arrWxParts.push(`Beaufort: F${arrivalForHeader.beaufortScale}`);
        }
        if (arrivalForHeader.waveHeight) {
            const arrWaveVal = convertMetersTo(arrivalForHeader.waveHeight, waveUnit);
            arrWxParts.push(`Waves: ${arrWaveVal !== null ? arrWaveVal.toFixed(1) : '?'}${waveUnit}`);
        }
        if (arrivalForHeader.seaState !== undefined) {
            arrWxParts.push(`Sea State: ${arrivalForHeader.seaState}`);
        }
        if (arrivalForHeader.pressure) {
            arrWxParts.push(`Barometric Pressure: ${Math.round(arrivalForHeader.pressure)}mb`);
        }
        if (arrivalForHeader.airTemp !== undefined) {
            arrWxParts.push(`Air: ${arrivalForHeader.airTemp}°C`);
        }
        if (arrivalForHeader.waterTemp !== undefined) {
            arrWxParts.push(`Sea: ${arrivalForHeader.waterTemp}°C`);
        }

        pdf.text(arrWxParts.join('     '), margin + 4, y + 13);

        y += 24;
    }

    // Vessel Specifications Section (only if vessel data exists)
    const vesselProfile = vesselData?.vessel;
    const vesselUnits = vesselData?.vesselUnits;

    if (
        vesselProfile &&
        (vesselProfile.length ||
            vesselProfile.beam ||
            vesselProfile.draft ||
            vesselProfile.fuelCapacity ||
            vesselProfile.waterCapacity)
    ) {
        pdf.setDrawColor(200, 200, 200);
        pdf.setLineWidth(0.3);
        pdf.roundedRect(margin, y, contentWidth, 20, 3, 3, 'S');

        // Header
        pdf.setFillColor(248, 250, 252);
        pdf.roundedRect(margin, y, contentWidth, 6, 3, 3, 'F');
        pdf.setFontSize(7);
        pdf.setTextColor(100, 110, 120);
        pdf.setFont('helvetica', 'bold');
        pdf.text('VESSEL SPECIFICATIONS', margin + 4, y + 4);

        const specY = y + 12;
        const specColWidth = contentWidth / 5;

        pdf.setTextColor(26, 42, 58);
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'normal');

        // Build specifications array
        const specs: { label: string; value: string }[] = [];

        if (vesselProfile.length) {
            const lengthUnit = vesselUnits?.length || 'ft';
            // Length stored in feet, convert if needed
            const lengthVal = lengthUnit === 'm' ? vesselProfile.length * 0.3048 : vesselProfile.length;
            specs.push({ label: 'Length', value: `${lengthVal.toFixed(1)}${lengthUnit}` });
        }
        if (vesselProfile.beam) {
            const beamUnit = vesselUnits?.beam || 'ft';
            // Beam stored in feet, convert to meters if needed
            const beamVal = beamUnit === 'm' ? vesselProfile.beam * 0.3048 : vesselProfile.beam;
            specs.push({ label: 'Beam', value: `${beamVal.toFixed(1)}${beamUnit}` });
        }
        if (vesselProfile.draft) {
            const draftUnit = vesselUnits?.draft || 'ft';
            // Draft stored in feet, convert to meters if needed
            const draftVal = draftUnit === 'm' ? vesselProfile.draft * 0.3048 : vesselProfile.draft;
            specs.push({ label: 'Draft', value: `${draftVal.toFixed(1)}${draftUnit}` });
        }
        if (vesselProfile.fuelCapacity) {
            const volUnit = vesselUnits?.volume || 'L';
            specs.push({ label: 'Fuel', value: `${vesselProfile.fuelCapacity}${volUnit}` });
        }
        if (vesselProfile.waterCapacity) {
            const volUnit = vesselUnits?.volume || 'L';
            specs.push({ label: 'Water', value: `${vesselProfile.waterCapacity}${volUnit}` });
        }

        // Render specs evenly across the box
        specs.forEach((spec, idx) => {
            const xPos = margin + specColWidth * (idx + 0.5);
            pdf.setFont('helvetica', 'bold');
            pdf.text(spec.value, xPos, specY, { align: 'center' });
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(7);
            pdf.setTextColor(106, 122, 138);
            pdf.text(spec.label, xPos, specY + 4, { align: 'center' });
            pdf.setFontSize(9);
            pdf.setTextColor(26, 42, 58);
        });

        y += 25;
    }

    // Maritime Scales Legend
    pdf.setDrawColor(200, 200, 200);
    pdf.setLineWidth(0.3);
    pdf.roundedRect(margin, y, contentWidth, 24, 2, 2, 'S');

    // Legend Header
    pdf.setFillColor(248, 250, 252);
    pdf.roundedRect(margin, y, contentWidth, 6, 2, 2, 'F');
    pdf.setFontSize(7);
    pdf.setTextColor(100, 110, 120);
    pdf.setFont('helvetica', 'bold');
    pdf.text('MARITIME SCALES REFERENCE', margin + 4, y + 4);

    // Beaufort Scale (left half)
    const legendY = y + 10;
    const halfWidth = contentWidth / 2;
    pdf.setFontSize(6);
    pdf.setTextColor(26, 42, 58);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Beaufort Wind Scale:', margin + 4, legendY);
    pdf.setFont('helvetica', 'normal');
    pdf.text(
        'F0-1: Calm  |  F2-3: Light  |  F4-5: Moderate  |  F6-7: Strong  |  F8+: Gale/Storm',
        margin + 4,
        legendY + 4,
    );
    pdf.text(
        'Wind speed in knots: F3=7-10kts, F4=11-16kts, F5=17-21kts, F6=22-27kts, F7=28-33kts',
        margin + 4,
        legendY + 8,
    );

    // Sea State (right half)
    pdf.setFont('helvetica', 'bold');
    pdf.text('Douglas Sea State:', margin + halfWidth + 4, legendY);
    pdf.setFont('helvetica', 'normal');
    pdf.text(
        '0: Calm (glassy)  |  1-2: Smooth  |  3-4: Slight/Moderate  |  5-6: Rough  |  7+: High/Very High',
        margin + halfWidth + 4,
        legendY + 4,
    );
    // Convert sea state reference heights to user's preferred wave unit
    const legendWaveUnit = vesselData?.units?.waveHeight || 'ft';
    const ss3Lo = convertMetersTo(0.5, legendWaveUnit)?.toFixed(1) ?? '?';
    const ss3Hi = convertMetersTo(1.25, legendWaveUnit)?.toFixed(1) ?? '?';
    const ss4Hi = convertMetersTo(2.5, legendWaveUnit)?.toFixed(1) ?? '?';
    const ss5Hi = convertMetersTo(4, legendWaveUnit)?.toFixed(1) ?? '?';
    const ss6Hi = convertMetersTo(6, legendWaveUnit)?.toFixed(1) ?? '?';
    pdf.text(
        `Wave height: SS3=${ss3Lo}-${ss3Hi}${legendWaveUnit}, SS4=${ss3Hi}-${ss4Hi}${legendWaveUnit}, SS5=${ss4Hi}-${ss5Hi}${legendWaveUnit}, SS6=${ss5Hi}-${ss6Hi}${legendWaveUnit}`,
        margin + halfWidth + 4,
        legendY + 8,
    );

    y += 28;

    const cols = {
        time: 18,
        position: 40,
        brg: 12,
        cogSog: 22,
        weather: 26,
        notes: contentWidth - 18 - 40 - 12 - 22 - 26,
    };

    // Track which watch headers have been rendered to prevent duplicates in rapid mode
    const renderedWatches = new Set<string>();

    // Process entries by date (reverse to show newest entries first within each day)
    entriesByDate.forEach((dateEntries, dateKey) => {
        const entriesNewestFirst = [...dateEntries].reverse();
        // Check if we need a new page
        if (y > pageHeight - 40) {
            pdf.addPage();
            pageNum++;
            y = margin;
        }

        // Date header bar
        pdf.setFillColor(26, 42, 58);
        pdf.rect(margin, y, contentWidth, 8, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'bold');
        pdf.text(dateKey, margin + 4, y + 5.5);
        y += 10;

        // Table header
        pdf.setFillColor(248, 249, 250);
        pdf.rect(margin, y, contentWidth, 6, 'F');
        pdf.setTextColor(106, 122, 138);
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'bold');

        let x = margin + 2;
        pdf.text('TIME', x + 6, y + 4);
        x += cols.time;
        pdf.text('POSITION', x, y + 4);
        x += cols.position;
        pdf.text('BRG', x, y + 4);
        x += cols.brg;
        pdf.text('COG/SOG', x, y + 4);
        x += cols.cogSog;
        pdf.text('WEATHER', x, y + 4);
        x += cols.weather;
        pdf.text('NOTES', x, y + 4);
        y += 7;

        // Draw entries (newest first)
        entriesNewestFirst.forEach((entry, idx) => {
            // Check if we need a new page
            if (y > pageHeight - 15) {
                pdf.addPage();
                pageNum++;
                y = margin;

                // Repeat date header on new page
                pdf.setFillColor(26, 42, 58);
                pdf.rect(margin, y, contentWidth, 8, 'F');
                pdf.setTextColor(255, 255, 255);
                pdf.setFontSize(9);
                pdf.setFont('helvetica', 'bold');
                pdf.text(`${dateKey} (cont.)`, margin + 4, y + 5.5);
                y += 10;

                // Table header
                pdf.setFillColor(248, 249, 250);
                pdf.rect(margin, y, contentWidth, 6, 'F');
                pdf.setTextColor(106, 122, 138);
                pdf.setFontSize(7);
                pdf.setFont('helvetica', 'bold');

                let hx = margin + 2;
                pdf.text('TIME', hx + 6, y + 4);
                hx += cols.time;
                pdf.text('POSITION', hx, y + 4);
                hx += cols.position;
                pdf.text('BRG', hx, y + 4);
                hx += cols.brg;
                pdf.text('COG/SOG', hx, y + 4);
                hx += cols.cogSog;
                pdf.text('WIND/DIR', hx, y + 4);
                hx += cols.weather;
                pdf.text('NOTES', hx, y + 4);
                y += 7;
            }

            const time = new Date(entry.timestamp);
            // Show seconds for rapid GPS entries (not aligned to quarter-hour)
            const isRapidEntry = time.getSeconds() !== 0 || time.getMinutes() % 15 !== 0;
            const timeStr = isRapidEntry
                ? time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                : time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            const hour = time.getHours();

            // Check if this is a watch change (4,4,4,3,3,3,3 pattern)
            // Watch changes at: 00:00, 04:00, 08:00, 12:00, 15:00, 18:00, 21:00
            const watchChangeHours = [0, 4, 8, 12, 15, 18, 21];
            const isWatchChange = watchChangeHours.includes(hour) && time.getMinutes() < 15;

            // Draw weather summary box at watch changes
            const watchKey = `${dateKey}:${hour}`;
            if (isWatchChange && !renderedWatches.has(watchKey)) {
                renderedWatches.add(watchKey);
                // Check if we have room for weather box
                if (y > pageHeight - 45) {
                    pdf.addPage();
                    pageNum++;
                    y = margin;
                }

                // Watch period name (4,4,4,3,3,3,3 pattern)
                const watchNames: { [key: number]: string } = {
                    0: 'Middle Watch (0000-0400)',
                    4: 'Morning Watch (0400-0800)',
                    8: 'Forenoon Watch (0800-1200)',
                    12: 'Afternoon Watch (1200-1500)',
                    15: 'First Dog Watch (1500-1800)',
                    18: 'Second Dog Watch (1800-2100)',
                    21: 'First Watch (2100-0000)',
                };

                // Weather summary box
                pdf.setFillColor(240, 244, 248);
                pdf.roundedRect(margin, y, contentWidth, 22, 2, 2, 'F');
                pdf.setDrawColor(201, 162, 39);
                pdf.setLineWidth(0.5);
                pdf.line(margin, y, margin, y + 22);

                // Watch title
                pdf.setTextColor(26, 42, 58);
                pdf.setFontSize(8);
                pdf.setFont('helvetica', 'bold');
                pdf.text(`>> ${watchNames[hour] || 'Watch Change'} - Weather Conditions`, margin + 5, y + 5);

                // Weather data
                pdf.setFont('helvetica', 'normal');
                pdf.setFontSize(7);

                const wxY = y + 12;
                let wxX = margin + 5;

                // Wind
                pdf.setFont('helvetica', 'bold');
                pdf.text('Wind:', wxX, wxY);
                pdf.setFont('helvetica', 'normal');
                const windText = entry.windSpeed ? `${entry.windSpeed}kts ${entry.windDirection || ''}` : 'N/A';
                pdf.text(windText, wxX + 10, wxY);
                wxX += 35;

                // Beaufort
                if (entry.beaufortScale !== undefined) {
                    pdf.setFont('helvetica', 'bold');
                    pdf.text('Bft:', wxX, wxY);
                    pdf.setFont('helvetica', 'normal');
                    pdf.text(`${entry.beaufortScale}`, wxX + 8, wxY);
                    wxX += 18;
                }

                // Waves (converted to user's preferred unit)
                pdf.setFont('helvetica', 'bold');
                pdf.text('Waves:', wxX, wxY);
                pdf.setFont('helvetica', 'normal');
                const watchWaveUnit = vesselData?.units?.waveHeight || 'ft';
                const watchWaveVal = entry.waveHeight ? convertMetersTo(entry.waveHeight, watchWaveUnit) : null;
                const waveText = watchWaveVal !== null ? `${watchWaveVal.toFixed(1)}${watchWaveUnit}` : 'N/A';
                pdf.text(waveText, wxX + 12, wxY);
                wxX += 28;

                // Barometer
                pdf.setFont('helvetica', 'bold');
                pdf.text('Barometric Pressure:', wxX, wxY);
                pdf.setFont('helvetica', 'normal');
                const baroText = entry.pressure ? `${Math.round(entry.pressure)}mb` : 'N/A';
                pdf.text(baroText, wxX + 30, wxY);
                wxX += 50;

                // Temps
                pdf.setFont('helvetica', 'bold');
                pdf.text('Air:', wxX, wxY);
                pdf.setFont('helvetica', 'normal');
                const airText = entry.airTemp !== undefined ? `${entry.airTemp}°C` : 'N/A';
                pdf.text(airText, wxX + 7, wxY);
                wxX += 22;

                pdf.setFont('helvetica', 'bold');
                pdf.text('Sea:', wxX, wxY);
                pdf.setFont('helvetica', 'normal');
                const seaText = entry.waterTemp !== undefined ? `${entry.waterTemp}°C` : 'N/A';
                pdf.text(seaText, wxX + 8, wxY);
                wxX += 22;

                // Visibility
                if (entry.visibility !== undefined) {
                    pdf.setFont('helvetica', 'bold');
                    pdf.text('Vis:', wxX, wxY);
                    pdf.setFont('helvetica', 'normal');
                    pdf.text(`${entry.visibility}nm`, wxX + 8, wxY);
                }

                y += 25;
            }

            // Colored dot
            const dotColor = entry.entryType === 'waypoint' ? [37, 99, 235] : [34, 197, 94]; // blue or green
            pdf.setFillColor(dotColor[0], dotColor[1], dotColor[2]);
            pdf.circle(margin + 4, y + 2.5, 1.5, 'F');

            pdf.setTextColor(26, 42, 58);
            pdf.setFontSize(8);
            pdf.setFont('helvetica', 'normal');

            x = margin + 8;
            pdf.text(timeStr, x, y + 3);
            x = margin + cols.time + 2;

            // Position (truncate if too long)
            const pos = entry.positionFormatted || '';
            pdf.text(pos.substring(0, 20), x, y + 3);
            x += cols.position;

            // BRG (16-point cardinal)
            const brg = entry.courseDeg !== undefined ? degreesToCardinal16(entry.courseDeg) : '';
            pdf.text(brg, x, y + 3);
            x += cols.brg;

            // COG/SOG
            const cog = entry.courseDeg !== undefined ? `${String(entry.courseDeg).padStart(3, '0')}T` : '';
            const sog = entry.speedKts ? `/${entry.speedKts.toFixed(1)}` : '';
            pdf.text(`${cog}${sog}`, x, y + 3);
            x += cols.cogSog;

            // Weather: compact format "15kts G22 NW 1.2ft"
            let wxCell = '';
            if (entry.windSpeed) {
                wxCell = `${entry.windSpeed}kts`;
                if (entry.windGust) wxCell += ` G${Math.round(entry.windGust)}`;
                if (entry.windDirection) wxCell += ` ${entry.windDirection}`;
            }
            if (entry.waveHeight) {
                const rowWaveUnit = vesselData?.units?.waveHeight || 'ft';
                const rowWaveVal = convertMetersTo(entry.waveHeight, rowWaveUnit);
                if (rowWaveVal !== null) wxCell += ` ${rowWaveVal.toFixed(1)}${rowWaveUnit}`;
            }
            pdf.text(wxCell.substring(0, 22), x, y + 3);
            x += cols.weather;

            // Notes (with wrapping) - decode HTML entities and use clean font
            pdf.setFont('helvetica', 'italic');
            pdf.setFontSize(7);

            let notes = '';
            if (entry.waypointName) notes += '>> ' + decodeHtmlEntities(entry.waypointName) + ' ';
            if (entry.notes) notes += decodeHtmlEntities(entry.notes);

            // Clean any remaining problematic characters
            notes = notes.replace(/[^\x20-\x7E\n]/g, ' ').trim();

            let extraRowHeight = 0;
            if (notes) {
                const maxWidth = cols.notes - 2;
                const noteLines = pdf.splitTextToSize(notes, maxWidth);
                // Limit to 4 lines max (increased from 2)
                const displayLines = noteLines.slice(0, 4);
                if (noteLines.length > 4) {
                    displayLines[3] = displayLines[3].substring(0, displayLines[3].length - 3) + '...';
                }
                pdf.text(displayLines, x, y + 3);
                extraRowHeight = (displayLines.length - 1) * 3;
            }
            pdf.setFont('helvetica', 'normal');

            // Row height
            const rowHeight = 5.5 + extraRowHeight;
            y += rowHeight;

            // Light separator line
            if (idx < dateEntries.length - 1) {
                pdf.setDrawColor(230, 230, 230);
                pdf.setLineWidth(0.1);
                pdf.line(margin, y, margin + contentWidth, y);
            }
        });

        y += 5;
    });

    // ===== VOYAGE TRACK MAP PAGE =====
    pdf.addPage();

    // Navy header bar
    pdf.setFillColor(26, 42, 58);
    pdf.rect(0, 0, pageWidth, 45, 'F');

    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(22);
    pdf.setFont('helvetica', 'bold');
    pdf.text('VOYAGE TRACK', pageWidth / 2, 28, { align: 'center' });

    // Gold accent line
    pdf.setDrawColor(201, 162, 39);
    pdf.setLineWidth(1.5);
    pdf.line(margin + 30, 40, pageWidth - margin - 30, 40);

    // Calculate map bounds from entries
    const validEntries = entries.filter((e) => e.latitude && e.longitude);

    // Map dimensions
    const mapX = margin;
    const mapY = 55;
    const mapWidth = contentWidth;
    const mapHeight = 160; // Larger map area for high-res image

    // Fetch high-res Mapbox static image with coastlines
    const mapImageDataUrl = await fetchMapboxStaticImage(entries, mapWidth, mapHeight);

    if (mapImageDataUrl) {
        // Embed the high-res Mapbox map image
        try {
            pdf.addImage(mapImageDataUrl, 'PNG', mapX, mapY, mapWidth, mapHeight);
        } catch (err) {
            // Fallback: draw simple background
            pdf.setFillColor(200, 210, 220);
            pdf.rect(mapX, mapY, mapWidth, mapHeight, 'F');
            pdf.setFontSize(10);
            pdf.setTextColor(100, 100, 100);
            pdf.text('Map image unavailable', mapX + mapWidth / 2, mapY + mapHeight / 2, { align: 'center' });
        }
    } else {
        // Fallback if Mapbox is unavailable: draw coordinates
        pdf.setFillColor(200, 210, 220);
        pdf.rect(mapX, mapY, mapWidth, mapHeight, 'F');

        if (validEntries.length > 0) {
            const sorted = [...validEntries].sort(
                (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
            );
            const startPt = sorted[0];
            const endPt = sorted[sorted.length - 1];

            pdf.setFontSize(12);
            pdf.setTextColor(50, 60, 70);
            pdf.text('Voyage Track', mapX + mapWidth / 2, mapY + 20, { align: 'center' });

            pdf.setFontSize(10);
            pdf.text(
                `Start: ${startPt.latitude?.toFixed(4)}°, ${startPt.longitude?.toFixed(4)}°`,
                mapX + mapWidth / 2,
                mapY + 40,
                { align: 'center' },
            );
            pdf.text(
                `End: ${endPt.latitude?.toFixed(4)}°, ${endPt.longitude?.toFixed(4)}°`,
                mapX + mapWidth / 2,
                mapY + 55,
                { align: 'center' },
            );
            pdf.text(`Entries: ${sorted.length}`, mapX + mapWidth / 2, mapY + 70, { align: 'center' });

            pdf.setFontSize(8);
            pdf.setTextColor(100, 100, 100);
            pdf.text('(High-res map requires Mapbox API)', mapX + mapWidth / 2, mapY + mapHeight - 10, {
                align: 'center',
            });
        }
    }

    // Map border
    pdf.setDrawColor(71, 85, 105);
    pdf.setLineWidth(1);
    pdf.rect(mapX, mapY, mapWidth, mapHeight, 'S');

    // Legend bar
    y = mapY + mapHeight + 8;
    pdf.setFillColor(241, 245, 249);
    pdf.rect(margin, y, contentWidth, 12, 'F');

    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(51, 65, 85);

    // Departure
    pdf.setFillColor(34, 197, 94);
    pdf.circle(margin + 8, y + 6, 2.5, 'F');
    pdf.text('Departure', margin + 14, y + 7);

    // Arrival
    pdf.setFillColor(239, 68, 68);
    pdf.circle(margin + 50, y + 6, 2.5, 'F');
    pdf.text('Arrival', margin + 56, y + 7);

    // Waypoint
    pdf.setFillColor(245, 158, 11);
    pdf.circle(margin + 88, y + 6, 2.5, 'F');
    pdf.text('Waypoint', margin + 94, y + 7);

    // Track line sample
    pdf.setDrawColor(30, 58, 95); // Match track color
    pdf.setLineWidth(1.5);
    pdf.line(margin + 130, y + 6, margin + 145, y + 6);
    pdf.setTextColor(51, 65, 85);
    pdf.text('Track', margin + 148, y + 7);

    // Voyage Stats (right side of legend bar)
    pdf.setFontSize(7);
    pdf.setTextColor(71, 85, 105);

    // Calculate stats from entries
    const statsEntries = [...validEntries].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const statsStart = statsEntries.length > 0 ? new Date(statsEntries[0].timestamp) : null;
    const statsEnd = statsEntries.length > 0 ? new Date(statsEntries[statsEntries.length - 1].timestamp) : null;
    const totalDist = validEntries.length > 0 ? Math.max(...validEntries.map((e) => e.cumulativeDistanceNM || 0)) : 0;
    const statsSpeeds = validEntries.filter((e) => e.speedKts && e.speedKts > 0).map((e) => e.speedKts!);
    const avgSpd = statsSpeeds.length > 0 ? statsSpeeds.reduce((a, b) => a + b, 0) / statsSpeeds.length : 0;

    let durationStr = '';
    if (statsStart && statsEnd) {
        const durMs = statsEnd.getTime() - statsStart.getTime();
        const durHrs = Math.floor(durMs / (1000 * 60 * 60));
        const durDays = Math.floor(durHrs / 24);
        const remHrs = durHrs % 24;
        durationStr = durDays > 0 ? `${durDays}d ${remHrs}h` : `${durHrs}h`;
    }

    // Right-aligned stats
    pdf.setFont('helvetica', 'bold');
    pdf.text(`${totalDist.toFixed(1)} NM`, pageWidth - margin - 50, y + 5);
    pdf.text(durationStr, pageWidth - margin - 25, y + 5);
    pdf.text(`${avgSpd.toFixed(1)} kts avg`, pageWidth - margin - 50, y + 10);
    pdf.setFont('helvetica', 'normal');

    // ===== VOYAGE DETAILS SECTION =====
    y += 18;

    // Get sorted entries for location info
    const sortedForInfo = [...validEntries].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const startEntry = sortedForInfo[0];
    const endEntry = sortedForInfo[sortedForInfo.length - 1];
    const waypointEntriesForInfo = sortedForInfo.filter((e) => e.entryType === 'waypoint');

    // Voyage Info Box
    const infoBoxHeight = 28 + (waypointEntriesForInfo.length > 0 ? Math.min(waypointEntriesForInfo.length, 5) * 6 : 0);
    pdf.setFillColor(248, 250, 252);
    pdf.roundedRect(margin, y, contentWidth, infoBoxHeight, 2, 2, 'F');
    pdf.setDrawColor(201, 205, 215);
    pdf.setLineWidth(0.3);
    pdf.roundedRect(margin, y, contentWidth, infoBoxHeight, 2, 2, 'S');

    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(26, 42, 58);
    pdf.text('VOYAGE ROUTE', margin + 4, y + 5);

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(71, 85, 105);

    // Start location
    if (startEntry) {
        const startCoords = `${Math.abs(startEntry.latitude!).toFixed(4)}°${startEntry.latitude! < 0 ? 'S' : 'N'}, ${Math.abs(startEntry.longitude!).toFixed(4)}°${startEntry.longitude! < 0 ? 'W' : 'E'}`;
        pdf.setFillColor(34, 197, 94);
        pdf.circle(margin + 8, y + 13, 2, 'F');
        pdf.setFont('helvetica', 'bold');
        pdf.text('Departure:', margin + 14, y + 14);
        pdf.setFont('helvetica', 'normal');
        const depText = startLocationName ? `${startCoords} (${startLocationName})` : startCoords;
        pdf.text(depText, margin + 38, y + 14);
    }

    // End location
    if (endEntry) {
        const endCoords = `${Math.abs(endEntry.latitude!).toFixed(4)}°${endEntry.latitude! < 0 ? 'S' : 'N'}, ${Math.abs(endEntry.longitude!).toFixed(4)}°${endEntry.longitude! < 0 ? 'W' : 'E'}`;
        pdf.setFillColor(239, 68, 68);
        pdf.circle(margin + 8, y + 21, 2, 'F');
        pdf.setFont('helvetica', 'bold');
        pdf.text('Arrival:', margin + 14, y + 22);
        pdf.setFont('helvetica', 'normal');
        const arrText = endLocationName ? `${endCoords} (${endLocationName})` : endCoords;
        pdf.text(arrText, margin + 38, y + 22);
    }

    // Waypoints
    if (waypointEntriesForInfo.length > 0) {
        const wpY = y + 29;
        pdf.setFillColor(245, 158, 11);
        pdf.setFont('helvetica', 'bold');
        pdf.text('Waypoints:', margin + 14, wpY);
        pdf.setFont('helvetica', 'normal');

        waypointEntriesForInfo.slice(0, 5).forEach((wp, i) => {
            const wpCoords = `${Math.abs(wp.latitude!).toFixed(4)}°${wp.latitude! < 0 ? 'S' : 'N'}, ${Math.abs(wp.longitude!).toFixed(4)}°${wp.longitude! < 0 ? 'W' : 'E'}`;
            const wpName = waypointNames.get(i);
            const wpText = wpName ? `WP${i + 1}: ${wpCoords} (${wpName})` : `WP${i + 1}: ${wpCoords}`;
            pdf.setFillColor(245, 158, 11); // Orange - set inside loop
            pdf.circle(margin + 8, wpY + i * 6 - 1, 1.5, 'F');
            pdf.text(wpText, margin + 38, wpY + i * 6);
        });

        if (waypointEntriesForInfo.length > 5) {
            pdf.text(`... and ${waypointEntriesForInfo.length - 5} more waypoints`, margin + 38, wpY + 30);
        }
    }

    // ===== CERTIFICATION PAGE =====
    pdf.addPage();
    const certPageStart = pdf.getNumberOfPages();

    // Navy header bar
    pdf.setFillColor(26, 42, 58);
    pdf.rect(0, 0, pageWidth, 45, 'F');

    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(22);
    pdf.setFont('helvetica', 'bolditalic');
    pdf.text('VOYAGE CERTIFICATION', pageWidth / 2, 28, { align: 'center' });

    y = 65;

    // Certification text
    pdf.setTextColor(26, 42, 58);
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'normal');
    const certText = `I, the undersigned Master/Skipper of the vessel ${vessel}, hereby certify that this Deck Log is a true and accurate record of the voyage from ${startDateStr} to ${endDateStr}.`;
    const lines = pdf.splitTextToSize(certText, contentWidth);
    pdf.text(lines, margin, y);

    y += 35;

    // Master/Skipper section
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Master / Skipper', margin, y);
    y += 15;

    // Signature line
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.text('Signature:', margin, y);
    pdf.setDrawColor(0, 0, 0);
    pdf.setLineWidth(0.3);
    pdf.line(margin + 25, y, margin + 80, y);
    y += 12;

    // Name line
    pdf.text('Name (print):', margin, y);
    pdf.line(margin + 28, y, margin + 80, y);
    y += 12;

    // Date line
    pdf.text('Date:', margin, y);
    pdf.line(margin + 15, y, margin + 80, y);

    // Official Stamp box (right side)
    const stampX = pageWidth / 2 + 10;
    const stampY = 100;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text('Official Stamp / Seal', stampX + 30, stampY, { align: 'center' });

    pdf.setDrawColor(150, 150, 150);
    pdf.setLineWidth(0.5);
    pdf.setLineDashPattern([3, 2], 0);
    pdf.roundedRect(stampX, stampY + 5, 60, 45, 3, 3, 'S');
    pdf.setLineDashPattern([], 0);

    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(150, 150, 150);
    pdf.text('(if applicable)', stampX + 30, stampY + 30, { align: 'center' });

    y = 160;

    // Remarks section
    pdf.setTextColor(26, 42, 58);
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Remarks / Voyage Notes:', margin, y);
    y += 8;

    // Blank lines for remarks
    pdf.setDrawColor(200, 200, 200);
    pdf.setLineWidth(0.2);
    for (let i = 0; i < 5; i++) {
        pdf.line(margin, y, margin + contentWidth, y);
        y += 8;
    }

    // IMO Compliance footer
    pdf.setFillColor(245, 247, 250);
    pdf.rect(margin, pageHeight - 28, contentWidth, 18, 'F');

    pdf.setFontSize(7);
    pdf.setTextColor(100, 110, 120);
    pdf.setFont('helvetica', 'normal');
    const complianceText =
        'This log conforms to IMO Resolution A.916(22) and SOLAS Chapter V standards for ship logbook documentation. ' +
        'The original log entries are generated from GPS tracking data and may require verification.';
    const complianceLines = pdf.splitTextToSize(complianceText, contentWidth - 10);
    pdf.text(complianceLines, margin + 5, pageHeight - 22);

    // ========== R&M (REPAIRS & MAINTENANCE) LOG PAGE ==========
    // Filter entries that are equipment/R&M type
    const rmEntries = sortedEntries.filter((e) => e.eventCategory === 'equipment');

    // Add R&M page (even if empty, to show the section exists)
    pdf.addPage();
    const rmPageStart = pdf.getNumberOfPages(); // Track R&M page for header skip
    let rmY = 25;

    // Compass watermark on R&M page
    drawCompassRoseWatermark(pdf, pageWidth, pageHeight);

    // R&M page header - Gold bar with title
    pdf.setFillColor(201, 162, 39); // Gold GOLD constant
    pdf.rect(0, 0, pageWidth, 28, 'F'); // Taller header (was 18)
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(16); // Slightly larger font
    pdf.setFont('helvetica', 'bold');
    pdf.text('REPAIRS & MAINTENANCE LOG', pageWidth / 2, 18, { align: 'center' });

    // Vessel name subtitle
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`M/V ${vessel}`, pageWidth / 2, 36, { align: 'center' });
    rmY = 45;

    // Section description
    pdf.setTextColor(26, 42, 58); // NAVY
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'italic');
    pdf.text('Record of equipment repairs, maintenance activities, and technical issues during voyage.', margin, rmY);
    rmY += 10;

    if (rmEntries.length === 0) {
        // No R&M entries
        pdf.setFillColor(248, 250, 252);
        pdf.rect(margin, rmY, contentWidth, 20, 'F');
        pdf.setFontSize(10);
        pdf.setTextColor(100, 110, 120);
        pdf.setFont('helvetica', 'normal');
        pdf.text('No repairs or maintenance activities logged during this voyage.', pageWidth / 2, rmY + 12, {
            align: 'center',
        });
    } else {
        // Table header
        pdf.setFillColor(26, 42, 58); // NAVY
        pdf.rect(margin, rmY, contentWidth, 8, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'bold');
        pdf.text('Date/Time', margin + 3, rmY + 5.5);
        pdf.text('Description', margin + 45, rmY + 5.5);
        rmY += 10;

        // R&M entries (chronological order - oldest first)
        const chronoRmEntries = [...rmEntries].reverse();

        for (let i = 0; i < chronoRmEntries.length; i++) {
            const entry = chronoRmEntries[i];
            const entryDate = new Date(entry.timestamp);
            const dateStr = entryDate.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
            // Show seconds for rapid GPS entries
            const isRapidEntry = entryDate.getSeconds() !== 0 || entryDate.getMinutes() % 15 !== 0;
            const timeStr = isRapidEntry
                ? entryDate.toLocaleTimeString('en-AU', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      hour12: false,
                  })
                : entryDate.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

            // Row background (alternating)
            if (i % 2 === 0) {
                pdf.setFillColor(248, 250, 252);
                pdf.rect(margin, rmY, contentWidth, 12, 'F');
            }

            // Date/time
            pdf.setTextColor(26, 42, 58);
            pdf.setFontSize(8);
            pdf.setFont('helvetica', 'bold');
            pdf.text(dateStr, margin + 3, rmY + 5);
            pdf.setFont('helvetica', 'normal');
            pdf.text(timeStr, margin + 3, rmY + 9.5);

            // Description (notes)
            const notes = decodeHtmlEntities(entry.notes || 'No details recorded');
            pdf.setTextColor(60, 70, 80);
            pdf.setFontSize(8);
            const noteLines = pdf.splitTextToSize(notes, contentWidth - 50);
            pdf.text(noteLines.slice(0, 2), margin + 45, rmY + 5); // Limit to 2 lines

            rmY += 14;

            // Check if we need a new page
            if (rmY > pageHeight - 40 && i < chronoRmEntries.length - 1) {
                pdf.addPage();
                drawCompassRoseWatermark(pdf, pageWidth, pageHeight);
                rmY = 25;

                // Continuation header
                pdf.setFillColor(26, 42, 58);
                pdf.rect(margin, rmY, contentWidth, 8, 'F');
                pdf.setTextColor(255, 255, 255);
                pdf.setFontSize(8);
                pdf.setFont('helvetica', 'bold');
                pdf.text('Date/Time', margin + 3, rmY + 5.5);
                pdf.text('Description', margin + 45, rmY + 5.5);
                rmY += 10;
            }
        }
    }

    // Page numbers, headers, footers, and compass watermark on ALL pages
    const totalPages = pdf.getNumberOfPages();
    const generatedDate = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'numeric', year: 'numeric' });

    for (let i = 1; i <= totalPages; i++) {
        pdf.setPage(i);

        // Draw angled compass rose watermark (bottom-left)
        drawCompassRoseWatermark(pdf, pageWidth, pageHeight);

        // Page header (skip pages with their own headers: first page, certification, R&M)
        // These pages have custom full-width headers that would be overwritten
        const isSpecialPage = i === 1 || i === certPageStart || i >= rmPageStart;
        if (!isSpecialPage) {
            pdf.setFillColor(248, 250, 252);
            pdf.rect(0, 0, pageWidth, 10, 'F');
            pdf.setFontSize(7);
            pdf.setTextColor(100, 110, 120);
            pdf.setFont('helvetica', 'normal');
            pdf.text(`OFFICIAL DECK LOG - ${vessel}`, pageWidth / 2, 6, { align: 'center' });
        }

        // Page footer
        pdf.setFontSize(7);
        pdf.setTextColor(140, 150, 160);
        pdf.setFont('helvetica', 'normal');

        // Left side: Generated by text
        pdf.text(`Generated by Thalassa Marine Forecasting | ${generatedDate}`, margin, pageHeight - 5);

        // Right side: Page number
        pdf.text(`Page ${i} of ${totalPages}`, pageWidth - margin, pageHeight - 5, { align: 'right' });
    }

    return pdf;
}
