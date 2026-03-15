import type { jsPDF as JsPDFType } from 'jspdf';
import { VoyagePlan, VesselProfile } from '../types';
import { fmtCoord } from './coords';

interface PDFExportOptions {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
}

// ─── Helper: draw a compass rose watermark ───────────────────────────────────
function drawCompassRose(pdf: JsPDFType, cx: number, cy: number, r: number, opacity = 0.12): void {
    const GState = (pdf as any).GState;
    if (GState) {
        pdf.setGState(new GState({ opacity }));
    }

    pdf.setDrawColor(180, 185, 190);
    pdf.setLineWidth(0.3);

    pdf.circle(cx, cy, r, 'S');
    pdf.circle(cx, cy, r * 0.82, 'S');
    pdf.circle(cx, cy, r * 0.2, 'S');

    const angle = -15 * (Math.PI / 180);

    for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI * 2) / 8 - Math.PI / 2 + angle;
        const inner = r * 0.25;
        const outer = i % 2 === 0 ? r * 0.9 : r * 0.55;
        pdf.line(
            cx + Math.cos(a) * inner,
            cy + Math.sin(a) * inner,
            cx + Math.cos(a) * outer,
            cy + Math.sin(a) * outer,
        );
        if (i % 2 === 0) {
            const tip = { x: cx + Math.cos(a) * outer, y: cy + Math.sin(a) * outer };
            const al = r * 0.12;
            pdf.line(tip.x, tip.y, tip.x + Math.cos(a + 2.8) * al, tip.y + Math.sin(a + 2.8) * al);
            pdf.line(tip.x, tip.y, tip.x + Math.cos(a - 2.8) * al, tip.y + Math.sin(a - 2.8) * al);
        }
    }

    for (let i = 0; i < 16; i++) {
        const ta = (i * Math.PI * 2) / 16 - Math.PI / 2 + angle;
        pdf.line(
            cx + Math.cos(ta) * r * 0.82,
            cy + Math.sin(ta) * r * 0.82,
            cx + Math.cos(ta) * r * 0.74,
            cy + Math.sin(ta) * r * 0.74,
        );
    }

    pdf.setFontSize(9);
    pdf.setTextColor(200, 205, 210);
    pdf.setFont('helvetica', 'bold');
    const d = r + 5;
    const rot = (x: number, y: number) => {
        const cos = Math.cos(angle),
            sin = Math.sin(angle);
        return { x: cx + (x - cx) * cos - (y - cy) * sin, y: cy + (x - cx) * sin + (y - cy) * cos };
    };
    const n = rot(cx, cy - d),
        s = rot(cx, cy + d),
        e = rot(cx + d, cy),
        w = rot(cx - d, cy);
    pdf.text('N', n.x, n.y + 2, { align: 'center' });
    pdf.text('S', s.x, s.y + 2, { align: 'center' });
    pdf.text('E', e.x, e.y + 2, { align: 'center' });
    pdf.text('W', w.x, w.y + 2, { align: 'center' });

    if (GState) {
        pdf.setGState(new GState({ opacity: 1.0 }));
    }
}

// ─── Helper: wrapped text ────────────────────────────────────────────────────
function drawWrappedText(
    pdf: JsPDFType,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
): number {
    const lines = pdf.splitTextToSize(text, maxWidth);
    lines.forEach((line: string, i: number) => {
        pdf.text(line, x, y + i * lineHeight);
    });
    return y + lines.length * lineHeight;
}

// ─── Helper: section header ──────────────────────────────────────────────────
function drawSectionHeader(pdf: JsPDFType, title: string, y: number, margin: number, contentWidth: number): number {
    pdf.setFontSize(12);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(26, 42, 58);
    pdf.text(title.toUpperCase(), margin, y);

    pdf.setDrawColor(3, 105, 161);
    pdf.setLineWidth(0.8);
    pdf.line(margin, y + 2, margin + contentWidth, y + 2);

    return y + 8;
}

// ─── Helper: info box ────────────────────────────────────────────────────────
function drawInfoBox(pdf: JsPDFType, label: string, value: string, x: number, y: number, w: number, h: number): void {
    pdf.setDrawColor(200, 200, 200);
    pdf.setLineWidth(0.3);
    pdf.roundedRect(x, y, w, h, 2, 2, 'S');

    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(120, 120, 120);
    pdf.text(label.toUpperCase(), x + 4, y + 5);

    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(26, 42, 58);
    pdf.text(value, x + 4, y + 13);
}

// ─── Helper: check new page ─────────────────────────────────────────────────
function checkPage(pdf: JsPDFType, y: number, needed: number, pageHeight: number, margin: number): number {
    if (y + needed > pageHeight - margin) {
        pdf.addPage();
        return margin + 10;
    }
    return y;
}

// ─── Generate the passage brief PDF ─────────────────────────────────────────
async function generatePassageBriefPDF({ voyagePlan, vessel }: PDFExportOptions): Promise<JsPDFType> {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = 210,
        H = 297,
        M = 15;
    const CW = W - M * 2;
    const isSail = vessel.type === 'sail';

    // Parse duration for resource calcs
    const durStr = voyagePlan.durationApprox.toLowerCase();
    let durationHours = 0;
    if (durStr.includes('day')) {
        durationHours = parseFloat(durStr.match(/(\d+\.?\d*)/)?.[0] || '0') * 24;
    } else if (durStr.includes('hour')) {
        durationHours = parseFloat(durStr.match(/(\d+\.?\d*)/)?.[0] || '0');
    }

    const fuelBurnRate = vessel.fuelBurn || 0;
    const motorFrac = isSail ? 0.15 : 1.0;
    const fuelReq = fuelBurnRate * durationHours * motorFrac;
    const fuelRes = fuelReq * 1.3;
    const crew = vessel.crewCount || 2;

    const currentDate = new Date().toLocaleDateString('en-AU', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    // ═══════════════════════════════════════════════════════════════════════
    // PAGE 1 — TITLE + OVERVIEW
    // ═══════════════════════════════════════════════════════════════════════

    // Navy header
    pdf.setFillColor(26, 42, 58);
    pdf.rect(0, 0, W, 55, 'F');

    // Gold accent line
    pdf.setDrawColor(201, 162, 39);
    pdf.setLineWidth(1.5);
    pdf.line(M + 20, 53, W - M - 20, 53);

    // Title
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(22);
    pdf.setFont('helvetica', 'bold');
    pdf.text('PASSAGE BRIEFING', W / 2, 22, { align: 'center' });

    // Route
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'normal');
    const origin = (voyagePlan.origin || '').split(',')[0];
    const dest = (voyagePlan.destination || '').split(',')[0];
    pdf.text(`${origin}  →  ${dest}`, W / 2, 34, { align: 'center' });

    // Vessel + Date
    pdf.setFontSize(10);
    pdf.text(`${vessel.name} (${vessel.type.toUpperCase()}) | ${crew} crew | ${currentDate}`, W / 2, 44, {
        align: 'center',
    });

    // Compass rose watermark
    drawCompassRose(pdf, 35, H - 40, 28);

    let y = 68;

    // ─── VOYAGE SUMMARY BOXES ────────────────────────────────────────────
    const bH = 18,
        gap = 3;
    const bW = (CW - gap * 3) / 4;

    drawInfoBox(pdf, 'Distance', voyagePlan.distanceApprox || '--', M, y, bW, bH);
    drawInfoBox(pdf, 'Duration', voyagePlan.durationApprox || '--', M + bW + gap, y, bW, bH);
    drawInfoBox(pdf, 'Cruising Speed', `${vessel.cruisingSpeed} kts`, M + (bW + gap) * 2, y, bW, bH);

    const suitStatus = voyagePlan.suitability?.status || '--';
    drawInfoBox(pdf, 'Suitability', suitStatus, M + (bW + gap) * 3, y, bW, bH);
    // Color the suitability value
    if (suitStatus === 'SAFE') {
        pdf.setTextColor(22, 163, 74);
    } else if (suitStatus === 'CAUTION') {
        pdf.setTextColor(217, 119, 6);
    } else if (suitStatus === 'UNSAFE') {
        pdf.setTextColor(220, 38, 38);
    }

    y += bH + 6;

    // ─── POSITIONS ───────────────────────────────────────────────────────
    y = drawSectionHeader(pdf, 'Positions', y, M, CW);
    const halfW = (CW - gap) / 2;

    drawInfoBox(pdf, 'Departure', origin, M, y, halfW, bH);
    drawInfoBox(
        pdf,
        'Position',
        fmtCoord(voyagePlan.originCoordinates?.lat, voyagePlan.originCoordinates?.lon) || '--',
        M,
        y + bH + 2,
        halfW,
        bH,
    );

    drawInfoBox(pdf, 'Arrival', dest, M + halfW + gap, y, halfW, bH);
    drawInfoBox(
        pdf,
        'Position',
        fmtCoord(voyagePlan.destinationCoordinates?.lat, voyagePlan.destinationCoordinates?.lon) || '--',
        M + halfW + gap,
        y + bH + 2,
        halfW,
        bH,
    );

    y += bH * 2 + 8;

    // ─── SUITABILITY ASSESSMENT ──────────────────────────────────────────
    if (voyagePlan.suitability?.reasoning) {
        y = drawSectionHeader(pdf, 'Suitability Assessment', y, M, CW);
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(40, 40, 40);
        y = drawWrappedText(pdf, voyagePlan.suitability.reasoning, M, y, CW, 4.5);
        y += 4;

        // Max conditions
        if (voyagePlan.suitability.maxWindEncountered || voyagePlan.suitability.maxWaveEncountered) {
            const thirdW = (CW - gap * 2) / 3;
            drawInfoBox(pdf, 'Max Wind', `${voyagePlan.suitability.maxWindEncountered ?? '--'} kts`, M, y, thirdW, bH);
            drawInfoBox(
                pdf,
                'Max Seas',
                `${voyagePlan.suitability.maxWaveEncountered ?? '--'} ft`,
                M + thirdW + gap,
                y,
                thirdW,
                bH,
            );
            drawInfoBox(
                pdf,
                'Vessel Limits',
                `${vessel.maxWindSpeed || '--'} kts / ${vessel.maxWaveHeight || '--'} ft`,
                M + (thirdW + gap) * 2,
                y,
                thirdW,
                bH,
            );
            y += bH + 6;
        }
    }

    // ─── ROUTE STRATEGY ──────────────────────────────────────────────────
    if (voyagePlan.routeReasoning) {
        y = checkPage(pdf, y, 30, H, M);
        y = drawSectionHeader(pdf, 'Route Strategy', y, M, CW);
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(40, 40, 40);
        y = drawWrappedText(pdf, voyagePlan.routeReasoning, M, y, CW, 4.5);
        y += 6;
    }

    // ─── BEST DEPARTURE WINDOW ───────────────────────────────────────────
    if (voyagePlan.bestDepartureWindow) {
        y = checkPage(pdf, y, 25, H, M);
        y = drawSectionHeader(pdf, 'Optimal Departure', y, M, CW);
        drawInfoBox(pdf, 'Window', voyagePlan.bestDepartureWindow.timeRange || '--', M, y, halfW, bH);
        y += bH + 3;
        if (voyagePlan.bestDepartureWindow.reasoning) {
            pdf.setFontSize(9);
            pdf.setFont('helvetica', 'normal');
            pdf.setTextColor(40, 40, 40);
            y = drawWrappedText(pdf, voyagePlan.bestDepartureWindow.reasoning, M, y, CW, 4.5);
        }
        y += 6;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ROUTE CHART (Mapbox Static Image — matches logbook PDF style)
    // ═══════════════════════════════════════════════════════════════════════
    const chartWaypoints: { lat: number; lon: number; name: string; depth_m?: number }[] = [];
    if (voyagePlan.originCoordinates)
        chartWaypoints.push({
            lat: voyagePlan.originCoordinates.lat,
            lon: voyagePlan.originCoordinates.lon,
            name: origin,
        });
    voyagePlan.waypoints.forEach((wp, i) => {
        if (wp.coordinates)
            chartWaypoints.push({
                lat: wp.coordinates.lat,
                lon: wp.coordinates.lon,
                name: wp.name || `WP-${String(i + 1).padStart(2, '0')}`,
                depth_m: wp.depth_m,
            });
    });
    if (voyagePlan.destinationCoordinates)
        chartWaypoints.push({
            lat: voyagePlan.destinationCoordinates.lat,
            lon: voyagePlan.destinationCoordinates.lon,
            name: dest,
        });

    if (chartWaypoints.length >= 2) {
        const chartH = 75;
        y = checkPage(pdf, y, chartH + 15, H, M);
        y = drawSectionHeader(pdf, 'Route Chart', y, M, CW);

        const cx = M,
            cy = y,
            cw = CW,
            ch = chartH;
        let mapRendered = false;

        // ── Try Mapbox Static Image (same style as logbook) ──
        try {
            const mapboxToken = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_MAPBOX_ACCESS_TOKEN) || '';
            if (mapboxToken && chartWaypoints.length >= 2) {
                // Polyline encode function (Google Polyline Algorithm — same as logbook)
                const encodePolyline = (coords: number[][]): string => {
                    let result = '';
                    let prevLat = 0,
                        prevLng = 0;
                    for (const [lat, lng] of coords) {
                        const latE5 = Math.round(lat * 1e5);
                        const lngE5 = Math.round(lng * 1e5);
                        const dLat = latE5 - prevLat;
                        const dLng = lngE5 - prevLng;
                        prevLat = latE5;
                        prevLng = lngE5;
                        for (const delta of [dLat, dLng]) {
                            let value = delta < 0 ? ~(delta << 1) : delta << 1;
                            while (value >= 0x20) {
                                result += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
                                value >>= 5;
                            }
                            result += String.fromCharCode(value + 63);
                        }
                    }
                    return result;
                };

                const coordsForPolyline = chartWaypoints.map((wp) => [wp.lat, wp.lon]);
                const encodedPath = encodePolyline(coordsForPolyline);

                // Calculate bounds
                const lats = chartWaypoints.map((wp) => wp.lat);
                const lons = chartWaypoints.map((wp) => wp.lon);
                const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
                const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;
                const maxSpan = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lons) - Math.min(...lons));
                const zoom =
                    maxSpan > 20
                        ? 3
                        : maxSpan > 10
                          ? 4
                          : maxSpan > 5
                            ? 5
                            : maxSpan > 2
                              ? 6
                              : maxSpan > 1
                                ? 7
                                : maxSpan > 0.5
                                  ? 8
                                  : 9;

                // Build overlays — navy route line + green start pin + red end pin
                const pathOverlay = `path-3+1e3a5f(${encodeURIComponent(encodedPath)})`;
                const start = chartWaypoints[0];
                const end = chartWaypoints[chartWaypoints.length - 1];
                const startPin = `pin-l-a+22c55e(${start.lon.toFixed(4)},${start.lat.toFixed(4)})`;
                const endPin = `pin-l-b+ef4444(${end.lon.toFixed(4)},${end.lat.toFixed(4)})`;
                const overlays = `${pathOverlay},${startPin},${endPin}`;

                const w = Math.min(1280, Math.round(cw * 4));
                const h = Math.min(1280, Math.round(ch * 4));
                const mapStyle = 'mapbox/light-v11';
                const url = `https://api.mapbox.com/styles/v1/${mapStyle}/static/${overlays}/${centerLon.toFixed(4)},${centerLat.toFixed(4)},${zoom}/${w}x${h}@2x?access_token=${mapboxToken}&logo=false&attribution=false`;

                const resp = await fetch(url);
                if (resp.ok) {
                    const blob = await resp.blob();
                    if (blob.size > 1000) {
                        const dataUrl: string = await new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result as string);
                            reader.onerror = () => resolve('');
                            reader.readAsDataURL(blob);
                        });
                        if (dataUrl) {
                            pdf.addImage(dataUrl, 'PNG', cx, cy, cw, ch);
                            mapRendered = true;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[pdfExport]', e);
            // Mapbox unavailable — fall through to vector fallback
        }

        // ── Vector fallback (if Mapbox not available) ──
        if (!mapRendered) {
            pdf.setFillColor(15, 23, 42);
            pdf.roundedRect(cx, cy, cw, ch, 2, 2, 'F');

            let minLat = Infinity,
                maxLat = -Infinity,
                minLon = Infinity,
                maxLon = -Infinity;
            for (const wp of chartWaypoints) {
                minLat = Math.min(minLat, wp.lat);
                maxLat = Math.max(maxLat, wp.lat);
                minLon = Math.min(minLon, wp.lon);
                maxLon = Math.max(maxLon, wp.lon);
            }
            const padLat = Math.max(0.5, (maxLat - minLat) * 0.15);
            const padLon = Math.max(0.5, (maxLon - minLon) * 0.15);
            minLat -= padLat;
            maxLat += padLat;
            minLon -= padLon;
            maxLon += padLon;

            const chartPad = 4;
            const toX = (lon: number) => cx + chartPad + ((lon - minLon) / (maxLon - minLon)) * (cw - chartPad * 2);
            const toY = (lat: number) => cy + chartPad + ((maxLat - lat) / (maxLat - minLat)) * (ch - chartPad * 2);

            // Grid
            pdf.setDrawColor(30, 50, 70);
            pdf.setLineWidth(0.15);
            const latStep = Math.ceil((maxLat - minLat) / 5);
            const lonStep = Math.ceil((maxLon - minLon) / 5);
            for (let lat = Math.ceil(minLat); lat <= maxLat; lat += Math.max(1, latStep)) {
                const gy = toY(lat);
                pdf.line(cx + 1, gy, cx + cw - 1, gy);
                pdf.setFontSize(5);
                pdf.setTextColor(60, 90, 120);
                pdf.text(`${Math.abs(lat)}°${lat >= 0 ? 'N' : 'S'}`, cx + 2, gy - 0.5);
            }
            for (let lon = Math.ceil(minLon); lon <= maxLon; lon += Math.max(1, lonStep)) {
                const gx = toX(lon);
                pdf.line(gx, cy + 1, gx, cy + ch - 1);
                pdf.setFontSize(5);
                pdf.setTextColor(60, 90, 120);
                pdf.text(`${Math.abs(lon)}°${lon >= 0 ? 'E' : 'W'}`, gx + 0.5, cy + ch - 1);
            }

            // Route line
            pdf.setDrawColor(56, 189, 248);
            pdf.setLineWidth(0.6);
            for (let i = 1; i < chartWaypoints.length; i++) {
                pdf.line(
                    toX(chartWaypoints[i - 1].lon),
                    toY(chartWaypoints[i - 1].lat),
                    toX(chartWaypoints[i].lon),
                    toY(chartWaypoints[i].lat),
                );
            }

            // Waypoint markers
            chartWaypoints.forEach((wp, i) => {
                const px = toX(wp.lon),
                    py = toY(wp.lat);
                if (i === 0 || i === chartWaypoints.length - 1) {
                    pdf.setFillColor(56, 189, 248);
                    pdf.circle(px, py, 1.5, 'F');
                    pdf.setFontSize(6);
                    pdf.setFont('helvetica', 'bold');
                    pdf.setTextColor(255, 255, 255);
                    pdf.text(wp.name.split(',')[0].substring(0, 15), px + 2.5, py + 1.5);
                } else {
                    pdf.setFillColor(100, 200, 255);
                    pdf.circle(px, py, 0.7, 'F');
                    if (wp.depth_m !== undefined) {
                        pdf.setFontSize(4.5);
                        pdf.setFont('helvetica', 'normal');
                        pdf.setTextColor(100, 200, 255);
                        pdf.text(`${wp.depth_m}m`, px + 1.5, py + 0.5);
                    }
                }
            });

            pdf.setFontSize(6);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(255, 255, 255);
            pdf.text(`${voyagePlan.distanceApprox}`, cx + cw - 3, cy + 5, { align: 'right' });
        }

        y += ch + 4;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // WAYPOINTS TABLE
    // ═══════════════════════════════════════════════════════════════════════
    y = checkPage(pdf, y, 30, H, M);
    y = drawSectionHeader(pdf, `Waypoints (${voyagePlan.waypoints.length + 2})`, y, M, CW);

    // Table header
    const cols = [12, 40, 48, 18, 22, 22]; // WP, Name, Coords, Depth, Wind, Seas
    const colX = [M];
    for (let i = 1; i < cols.length; i++) colX.push(colX[i - 1] + cols[i - 1]);

    pdf.setFillColor(26, 42, 58);
    pdf.rect(M, y, CW, 7, 'F');
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(255, 255, 255);
    ['WP', 'NAME', 'COORDINATES', 'DEPTH', 'WIND', 'SEAS'].forEach((h, i) => pdf.text(h, colX[i] + 2, y + 5));
    y += 7;

    // Departure row
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    const drawRow = (
        wp: string,
        name: string,
        coords: string,
        depth: string,
        wind: string,
        seas: string,
        y: number,
        fill: boolean,
    ) => {
        if (fill) {
            pdf.setFillColor(245, 247, 250);
            pdf.rect(M, y, CW, 6.5, 'F');
        }
        pdf.setTextColor(40, 40, 40);
        pdf.text(wp, colX[0] + 2, y + 4.5);
        pdf.text(name.substring(0, 25), colX[1] + 2, y + 4.5);
        pdf.text(coords, colX[2] + 2, y + 4.5);
        pdf.text(depth, colX[3] + 2, y + 4.5);
        pdf.text(wind, colX[4] + 2, y + 4.5);
        pdf.text(seas, colX[5] + 2, y + 4.5);
    };

    drawRow(
        'DEP',
        origin,
        fmtCoord(voyagePlan.originCoordinates?.lat, voyagePlan.originCoordinates?.lon) || '',
        '--',
        '--',
        '--',
        y,
        true,
    );
    y += 6.5;

    voyagePlan.waypoints.forEach((wp, i) => {
        y = checkPage(pdf, y, 7, H, M);
        drawRow(
            `WP-${String(i + 1).padStart(2, '0')}`,
            wp.name || '--',
            wp.coordinates ? fmtCoord(wp.coordinates.lat, wp.coordinates.lon) : '--',
            wp.depth_m !== undefined ? `${wp.depth_m}m` : '--',
            wp.windSpeed ? `${wp.windSpeed} kts` : '--',
            wp.waveHeight ? `${wp.waveHeight} ft` : '--',
            y,
            i % 2 === 1,
        );
        y += 6.5;
    });

    drawRow(
        'ARR',
        dest,
        fmtCoord(voyagePlan.destinationCoordinates?.lat, voyagePlan.destinationCoordinates?.lon) || '',
        '--',
        '--',
        '--',
        y,
        voyagePlan.waypoints.length % 2 === 0,
    );
    y += 10;

    // ═══════════════════════════════════════════════════════════════════════
    // HAZARDS
    // ═══════════════════════════════════════════════════════════════════════
    if (voyagePlan.hazards && voyagePlan.hazards.length > 0) {
        y = checkPage(pdf, y, 20, H, M);
        y = drawSectionHeader(pdf, 'Identified Hazards', y, M, CW);

        voyagePlan.hazards.forEach((h) => {
            y = checkPage(pdf, y, 15, H, M);

            // Severity bar
            const sevColor =
                h.severity === 'CRITICAL'
                    ? [220, 38, 38]
                    : h.severity === 'HIGH'
                      ? [234, 88, 12]
                      : h.severity === 'MEDIUM'
                        ? [217, 119, 6]
                        : [34, 197, 94];
            pdf.setFillColor(sevColor[0], sevColor[1], sevColor[2]);
            pdf.rect(M, y, 3, 12, 'F');

            pdf.setFontSize(9);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(40, 40, 40);
            pdf.text(`${h.name}  [${h.severity}]`, M + 6, y + 5);

            pdf.setFontSize(8);
            pdf.setFont('helvetica', 'normal');
            pdf.setTextColor(80, 80, 80);
            y = drawWrappedText(pdf, h.description, M + 6, y + 9, CW - 8, 4);
            y += 3;
        });
        y += 4;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CUSTOMS & CLEARANCE
    // ═══════════════════════════════════════════════════════════════════════
    if (voyagePlan.customs?.required) {
        y = checkPage(pdf, y, 30, H, M);
        y = drawSectionHeader(pdf, 'Customs & Clearance', y, M, CW);

        if (voyagePlan.customs.departingCountry) {
            drawInfoBox(pdf, 'Departing Country', voyagePlan.customs.departingCountry, M, y, halfW, bH);
        }
        drawInfoBox(pdf, 'Destination Country', voyagePlan.customs.destinationCountry, M + halfW + gap, y, halfW, bH);
        y += bH + 4;

        if (voyagePlan.customs.departureProcedures) {
            pdf.setFontSize(8);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(80, 80, 80);
            pdf.text('DEPARTURE PROCEDURES:', M, y);
            y += 4;
            pdf.setFont('helvetica', 'normal');
            pdf.setTextColor(40, 40, 40);
            y = drawWrappedText(pdf, voyagePlan.customs.departureProcedures, M, y, CW, 4);
            y += 3;
        }

        if (voyagePlan.customs.procedures) {
            pdf.setFontSize(8);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(80, 80, 80);
            pdf.text('ARRIVAL PROCEDURES:', M, y);
            y += 4;
            pdf.setFont('helvetica', 'normal');
            pdf.setTextColor(40, 40, 40);
            y = drawWrappedText(pdf, voyagePlan.customs.procedures, M, y, CW, 4);
            y += 3;
        }

        if (voyagePlan.customs.contactPhone) {
            pdf.setFontSize(8);
            pdf.setFont('helvetica', 'bold');
            pdf.text(`Contact: ${voyagePlan.customs.contactPhone}`, M, y);
            y += 6;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RESOURCE PLANNING
    // ═══════════════════════════════════════════════════════════════════════
    y = checkPage(pdf, y, 30, H, M);
    y = drawSectionHeader(pdf, 'Resource Planning', y, M, CW);

    const thirdW = (CW - gap * 2) / 3;
    drawInfoBox(
        pdf,
        isSail ? 'Motor Reserve (+30%)' : 'Fuel (+30% reserve)',
        `${fuelRes.toFixed(0)} L`,
        M,
        y,
        thirdW,
        bH,
    );
    drawInfoBox(
        pdf,
        'Water (3L/crew/day)',
        `${(crew * (durationHours / 24) * 3).toFixed(0)} L`,
        M + thirdW + gap,
        y,
        thirdW,
        bH,
    );
    drawInfoBox(
        pdf,
        'Meals Required',
        `${Math.ceil((durationHours / 24) * crew * 3)}`,
        M + (thirdW + gap) * 2,
        y,
        thirdW,
        bH,
    );
    y += bH + 4;

    // Fuel capacity check
    const cap = vessel.fuelCapacity || 0;
    if (cap > 0) {
        const sufficient = cap >= fuelRes;
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(sufficient ? 22 : 220, sufficient ? 163 : 38, sufficient ? 74 : 38);
        pdf.text(
            `${sufficient ? '✓' : '⚠'} Fuel Capacity: ${cap}L — ${sufficient ? 'Sufficient' : isSail ? 'Motor reserve exceeds tank' : 'Insufficient — Plan Refuelling'}`,
            M,
            y,
        );
        y += 6;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EMERGENCY PROCEDURES
    // ═══════════════════════════════════════════════════════════════════════
    y = checkPage(pdf, y, 50, H, M);
    y = drawSectionHeader(pdf, 'Emergency Procedures', y, M, CW);

    // Mayday box
    pdf.setDrawColor(220, 38, 38);
    pdf.setLineWidth(0.8);
    pdf.roundedRect(M, y, CW, 38, 2, 2, 'S');
    pdf.setFillColor(255, 245, 245);
    pdf.roundedRect(M + 0.4, y + 0.4, CW - 0.8, 37.2, 2, 2, 'F');

    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(220, 38, 38);
    pdf.text('MAYDAY PROTOCOL (VHF Channel 16)', M + 5, y + 7);

    pdf.setFontSize(8);
    pdf.setFont('courier', 'normal');
    pdf.setTextColor(40, 40, 40);
    const mayday = [
        '1. MAYDAY MAYDAY MAYDAY',
        `2. This is ${vessel.name} ${vessel.name} ${vessel.name}`,
        '3. Position: [INSERT LAT/LON]',
        '4. Nature of distress: [DESCRIBE]',
        '5. Assistance required: [SPECIFY]',
        '6. Souls on board: ___',
        '7. OVER',
    ];
    mayday.forEach((line, i) => pdf.text(line, M + 5, y + 13 + i * 3.5));
    y += 42;

    // Emergency contacts
    const contacts = [
        { label: 'Coast Guard / MRCC', detail: 'VHF Channel 16 (156.8 MHz)' },
        { label: 'EPIRB Activation', detail: 'Deploy & switch to CH16 — await rescue' },
        { label: 'NOAA Weather', detail: '162.55 MHz' },
    ];
    contacts.forEach((c) => {
        y = checkPage(pdf, y, 8, H, M);
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(217, 119, 6);
        pdf.text(`🚨 ${c.label}:`, M, y + 4);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(40, 40, 40);
        pdf.text(c.detail, M + 50, y + 4);
        y += 6;
    });
    y += 4;

    // ═══════════════════════════════════════════════════════════════════════
    // DISCLAIMER
    // ═══════════════════════════════════════════════════════════════════════
    y = checkPage(pdf, y, 25, H, M);

    pdf.setDrawColor(217, 119, 6);
    pdf.setLineWidth(0.6);
    pdf.roundedRect(M, y, CW, 18, 2, 2, 'S');
    pdf.setFillColor(255, 251, 235);
    pdf.roundedRect(M + 0.3, y + 0.3, CW - 0.6, 17.4, 2, 2, 'F');

    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(146, 64, 14);
    pdf.text('⚠ IMPORTANT SAFETY DISCLAIMER', M + 4, y + 5);

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(6.5);
    pdf.setTextColor(100, 80, 60);
    const disclaimer =
        'This passage brief is AI-generated for planning purposes only. The captain must verify all information, check current weather forecasts, NOTAMs, and navigational warnings before departure. The captain is solely responsible for the safety of crew and vessel. Weather conditions can change rapidly — maintain continuous monitoring throughout the passage.';
    drawWrappedText(pdf, disclaimer, M + 4, y + 9, CW - 8, 3.2);

    // Footer
    y = H - 10;
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(160, 160, 160);
    pdf.text(`Generated by Thalassa Marine Weather | ${currentDate}`, W / 2, y, { align: 'center' });

    return pdf;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API — matches logbook export behaviour (navigator.share → fallback)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Export passage brief as PDF using share sheet (same behaviour as logbook)
 * Falls back to direct download if Web Share API not available
 */
export const printPassageBrief = async ({ voyagePlan, vessel }: PDFExportOptions): Promise<void> => {
    const pdf = await generatePassageBriefPDF({ voyagePlan, vessel });

    const origin = (voyagePlan.origin || 'Origin')
        .split(',')[0]
        .replace(/[^a-zA-Z0-9 ]/g, '')
        .trim()
        .replace(/\s+/g, '_');
    const dest = (voyagePlan.destination || 'Dest')
        .split(',')[0]
        .replace(/[^a-zA-Z0-9 ]/g, '')
        .trim()
        .replace(/\s+/g, '_');
    const date = voyagePlan.departureDate || new Date().toISOString().split('T')[0];
    const filename = `PassageBrief_${origin}_to_${dest}_${date}.pdf`;

    const pdfBlob = pdf.output('blob');
    const pdfFile = new File([pdfBlob], filename, { type: 'application/pdf' });

    // Try Web Share API (same as logbook export)
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
        try {
            await navigator.share({
                title: `Passage Brief: ${origin} to ${dest}`,
                text: `Passage plan from ${voyagePlan.origin} to ${voyagePlan.destination}`,
                files: [pdfFile],
            });
            return;
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return;
            // Fall through to download
        }
    }

    // Fallback — direct download
    pdf.save(filename);
};
