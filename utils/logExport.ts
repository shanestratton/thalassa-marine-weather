/**
 * Ship's Log Export Utilities
 * Generate PDF and CSV exports for legal compliance and analysis
 */

import { ShipLogEntry, VesselProfile, VesselDimensionUnits } from '../types';
import { jsPDF } from 'jspdf';

// Vessel data interface for PDF export
interface VesselData {
    vessel?: VesselProfile;
    vesselUnits?: VesselDimensionUnits;
}

// Colors
const NAVY = '#1a2a3a';
const GOLD = '#c9a227';
const GRAY = '#6a7a8a';
const LIGHT_GRAY = '#e8eef4';

// Helper to decode HTML entities (fixes &amp; &#34; etc in notes)
function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&"/g, '')           // Broken entity
        .replace(/&'/g, "'")          // Broken entity
        .replace(/&#x27;/g, "'")      // Hex apostrophe
        .replace(/&#x22;/g, '"')      // Hex quote
        .replace(/\u2693/g, '>>')     // anchor emoji
        .replace(/[\u2000-\u206F]/g, ' ')  // unicode spaces/control
        .replace(/\s+/g, ' ')         // collapse multiple spaces
        .trim();
}

/**
 * Reverse geocode coordinates to get a place name
 * Returns a simplified location name suitable for PDF display
 */
async function reverseGeocode(lat: number, lon: number): Promise<string> {
    try {
        const mapboxToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
        if (!mapboxToken) return `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;

        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?types=place,locality,region&limit=1&access_token=${mapboxToken}`;
        const response = await fetch(url);

        if (!response.ok) throw new Error('Geocoding failed');

        const data = await response.json();
        if (data.features && data.features.length > 0) {
            const feature = data.features[0];
            // Return short name (e.g., "Brisbane" or "Noumea")
            return feature.text || feature.place_name?.split(',')[0] || `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`;
        }
    } catch (err) {
        console.warn('[Geocode] Error:', err);
    }
    // Fallback to coordinates
    return `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
}

/**
 * Fetch a static map image from Mapbox for the voyage track
 * Includes voyage track line and start/end markers
 */
async function fetchMapboxStaticImage(
    entries: ShipLogEntry[],
    mapWidth: number,
    mapHeight: number
): Promise<string | null> {
    console.log('[MapExport] Starting map generation...');

    try {
        // Try multiple ways to get the token
        let mapboxToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;

        // Debug: log what we got
        console.log('[MapExport] Token from env:', mapboxToken ? `${mapboxToken.substring(0, 20)}...` : 'undefined');

        if (!mapboxToken) {
            console.error('[MapExport] No Mapbox token found in env!');
            return null;
        }

        const validEntries = entries.filter(e => e.latitude && e.longitude);
        console.log('[MapExport] Valid entries:', validEntries.length);

        if (validEntries.length < 2) {
            console.warn('[MapExport] Not enough entries');
            return null;
        }

        // Get chronologically sorted points
        const sorted = [...validEntries].sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        // Simplify to max 50 points for the track (keeps URL reasonable)
        const maxPoints = 50;
        const step = Math.max(1, Math.floor(sorted.length / maxPoints));
        const simplified: typeof sorted = [];
        for (let i = 0; i < sorted.length; i += step) {
            simplified.push(sorted[i]);
        }
        // Always include end point
        if (simplified[simplified.length - 1] !== sorted[sorted.length - 1]) {
            simplified.push(sorted[sorted.length - 1]);
        }
        console.log('[MapExport] Simplified to', simplified.length, 'track points');

        const start = simplified[0];
        const end = simplified[simplified.length - 1];

        console.log('[MapExport] Start:', start.latitude, start.longitude);
        console.log('[MapExport] End:', end.latitude, end.longitude);

        // Build path coordinates string: lon,lat;lon,lat;...
        // Also build coordinates array for polyline encoding
        const coordsForPolyline = simplified.map(e => [e.latitude, e.longitude]);

        // Polyline encode function (Google Polyline Algorithm)
        const encodePolyline = (coords: number[][]): string => {
            let result = '';
            let prevLat = 0;
            let prevLng = 0;

            for (const [lat, lng] of coords) {
                // Multiply by 1e5 and round
                const latE5 = Math.round(lat * 1e5);
                const lngE5 = Math.round(lng * 1e5);

                // Calculate deltas
                const dLat = latE5 - prevLat;
                const dLng = lngE5 - prevLng;

                prevLat = latE5;
                prevLng = lngE5;

                // Encode each delta
                for (const delta of [dLat, dLng]) {
                    let value = delta < 0 ? ~(delta << 1) : (delta << 1);
                    while (value >= 0x20) {
                        result += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
                        value >>= 5;
                    }
                    result += String.fromCharCode(value + 63);
                }
            }
            return result;
        };

        const encodedPath = encodePolyline(coordsForPolyline);
        console.log('[MapExport] Encoded polyline length:', encodedPath.length);

        // Calculate bounds for zoom calculation
        const lats = simplified.map(e => e.latitude);
        const lons = simplified.map(e => e.longitude);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLon = Math.min(...lons);
        const maxLon = Math.max(...lons);

        // Center point
        const centerLon = (minLon + maxLon) / 2;
        const centerLat = (minLat + maxLat) / 2;

        // Calculate zoom level based on bounds span
        const latSpan = maxLat - minLat;
        const lonSpan = maxLon - minLon;
        const maxSpan = Math.max(latSpan, lonSpan);

        // Approximate zoom: smaller span = higher zoom
        let zoom = 5; // Default
        if (maxSpan > 20) zoom = 3;
        else if (maxSpan > 10) zoom = 4;
        else if (maxSpan > 5) zoom = 5;
        else if (maxSpan > 2) zoom = 6;
        else if (maxSpan > 1) zoom = 7;
        else if (maxSpan > 0.5) zoom = 8;
        else if (maxSpan > 0.2) zoom = 9;
        else zoom = 10;

        console.log('[MapExport] Bounds span:', maxSpan.toFixed(2), 'degrees, zoom:', zoom);

        // Path overlay with polyline encoding: path-{strokeWidth}+{strokeColor}({encoded_polyline})
        // Using navy blue (#1e3a5f) with 3px line for clean look
        const pathOverlay = `path-3+1e3a5f(${encodeURIComponent(encodedPath)})`;

        // Markers: pin-{size}-{label}+{color}(lon,lat)
        const startPin = `pin-l-a+22c55e(${start.longitude.toFixed(4)},${start.latitude.toFixed(4)})`;
        const endPin = `pin-l-b+ef4444(${end.longitude.toFixed(4)},${end.latitude.toFixed(4)})`;

        // Waypoint markers (orange, smaller pins)
        const waypointEntries = sorted.filter(e => e.entryType === 'waypoint' && e !== start && e !== end);
        const waypointPins = waypointEntries.slice(0, 10).map((wp, i) =>
            `pin-s-${i + 1}+f59e0b(${wp.longitude!.toFixed(4)},${wp.latitude!.toFixed(4)})`
        ).join(',');

        console.log('[MapExport] Waypoints found:', waypointEntries.length, 'Using:', Math.min(10, waypointEntries.length));

        // Size - higher resolution
        const w = Math.min(1280, Math.round(mapWidth * 3));
        const h = Math.min(1280, Math.round(mapHeight * 3));

        // Use light-v11 for cleaner, less colorful look (nautical-friendly)
        const mapStyle = 'mapbox/light-v11';

        // Build overlays string (path, start, waypoints, end)
        const overlays = waypointPins
            ? `${pathOverlay},${startPin},${waypointPins},${endPin}`
            : `${pathOverlay},${startPin},${endPin}`;

        // Build URL with explicit center/zoom instead of auto (auto fails with markers)
        const url = `https://api.mapbox.com/styles/v1/${mapStyle}/static/${overlays}/${centerLon.toFixed(4)},${centerLat.toFixed(4)},${zoom}/${w}x${h}@2x?access_token=${mapboxToken}&logo=false&attribution=false`;

        console.log('[MapExport] URL length:', url.length);

        const response = await fetch(url);
        console.log('[MapExport] Response status:', response.status, response.statusText);

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'no error text');
            console.error('[MapExport] Fetch failed:', response.status, errorText);
            return null;
        }

        const blob = await response.blob();
        console.log('[MapExport] Got blob - type:', blob.type, 'size:', blob.size);

        if (blob.size < 1000) {
            console.error('[MapExport] Blob too small, likely error response');
            return null;
        }

        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = reader.result as string;
                console.log('[MapExport] Data URL created, length:', result?.length || 0);
                resolve(result);
            };
            reader.onerror = (e) => {
                console.error('[MapExport] FileReader error:', e);
                resolve(null);
            };
            reader.readAsDataURL(blob);
        });
    } catch (err) {
        console.error('[MapExport] Exception:', err);
        return null;
    }
}

/**
 * Export log entries as CSV
 */
export function exportToCSV(
    entries: ShipLogEntry[],
    filename: string = 'ships_log.csv',
    callbacks?: {
        onProgress?: (message: string) => void;
        onSuccess?: () => void;
        onError?: (error: string) => void;
    }
): void {
    try {
        callbacks?.onProgress?.('Preparing CSV export...');

        if (entries.length === 0) {
            throw new Error('No entries to export');
        }

        const headers = [
            'Timestamp', 'Position (DMS)', 'Latitude', 'Longitude',
            'Distance (NM)', 'Cumulative Distance (NM)', 'Speed (kts)',
            'Course (°)', 'Wind Speed (kts)', 'Wind Direction',
            'Wave Height (m)', 'Pressure (mb)', 'Air Temp (°C)',
            'Water Temp (°C)', 'Entry Type', 'Waypoint Name', 'Notes'
        ];

        const rows = entries.map(entry => [
            entry.timestamp,
            entry.positionFormatted,
            entry.latitude,
            entry.longitude,
            entry.distanceNM || '',
            entry.cumulativeDistanceNM || '',
            entry.speedKts || '',
            entry.courseDeg || '',
            entry.windSpeed || '',
            entry.windDirection || '',
            entry.waveHeight || '',
            entry.pressure || '',
            entry.airTemp || '',
            entry.waterTemp || '',
            entry.entryType,
            entry.waypointName || '',
            entry.notes ? `"${entry.notes.replace(/"/g, '""')}"` : ''
        ]);

        const csv = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');

        callbacks?.onProgress?.('Downloading file...');
        downloadFile(csv, filename, 'text/csv');

        setTimeout(() => callbacks?.onSuccess?.(), 500);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to export CSV';
        callbacks?.onError?.(message);
    }
}

/**
 * Export log entries as PDF using print dialog
 */
export async function exportToPDF(
    entries: ShipLogEntry[],
    filename: string = 'ships_log.pdf',
    callbacks?: {
        onProgress?: (message: string) => void;
        onSuccess?: () => void;
        onError?: (error: string) => void;
    },
    vesselName?: string,
    vesselData?: VesselData
): Promise<void> {
    try {
        callbacks?.onProgress?.('Generating PDF...');

        if (entries.length === 0) {
            throw new Error('No entries to export');
        }

        const pdf = await generateDeckLogPDF(entries, vesselName, vesselData);

        callbacks?.onProgress?.('Opening PDF...');
        pdf.save(filename);

        setTimeout(() => callbacks?.onSuccess?.(), 500);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to export PDF';
        callbacks?.onError?.(message);
    }
}

/**
 * Share PDF using jsPDF
 */
export async function sharePDF(
    entries: ShipLogEntry[],
    callbacks?: {
        onProgress?: (message: string) => void;
        onSuccess?: () => void;
        onError?: (error: string) => void;
    },
    vesselName?: string,
    vesselData?: VesselData
): Promise<void> {
    try {
        callbacks?.onProgress?.('Generating PDF...');

        if (entries.length === 0) {
            throw new Error('No entries to share');
        }

        // Get route info for professional filename
        const sortedForRoute = [...entries].sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
        const startEntry = sortedForRoute.find(e => e.latitude && e.longitude);
        const endEntry = [...sortedForRoute].reverse().find(e => e.latitude && e.longitude);

        let startName = '';
        let endName = '';

        if (startEntry) {
            startName = await reverseGeocode(startEntry.latitude!, startEntry.longitude!);
        }
        if (endEntry) {
            endName = await reverseGeocode(endEntry.latitude!, endEntry.longitude!);
        }

        // Create professional filename
        const formatDate = (d: Date) => `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
        const startDate = sortedForRoute.length > 0 ? formatDate(new Date(sortedForRoute[0].timestamp)) : '';

        let pdfFilename = 'DeckLog.pdf';
        let shareTitle = 'Deck Log';

        if (startName && endName && startName !== endName) {
            const routeSlug = `${startName}_to_${endName}`.replace(/[^a-zA-Z0-9_]/g, '');
            pdfFilename = `${routeSlug}_DeckLog_${startDate}.pdf`;
            shareTitle = `${startName} to ${endName} - Deck Log`;
        } else if (vesselName) {
            pdfFilename = `${vesselName.replace(/[^a-zA-Z0-9]/g, '_')}_DeckLog_${startDate}.pdf`;
            shareTitle = `${vesselName} - Deck Log`;
        }

        const pdf = await generateDeckLogPDF(entries, vesselName, vesselData);
        const pdfBlob = pdf.output('blob');
        const pdfFile = new File([pdfBlob], pdfFilename, { type: 'application/pdf' });

        // Try Web Share API
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
            callbacks?.onProgress?.('Opening share sheet...');
            try {
                await navigator.share({
                    title: shareTitle,
                    text: startName && endName ? `Voyage from ${startName} to ${endName}` : undefined,
                    files: [pdfFile]
                });
                callbacks?.onSuccess?.();
            } catch (shareError) {
                if (shareError instanceof Error && shareError.name === 'AbortError') {
                    callbacks?.onSuccess?.();
                } else {
                    pdf.save(pdfFilename);
                    callbacks?.onSuccess?.();
                }
            }
        } else {
            callbacks?.onProgress?.('Saving PDF...');
            pdf.save(pdfFilename);
            callbacks?.onSuccess?.();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate PDF';
        callbacks?.onError?.(message);
    }
}

/**
 * Draw an angled compass rose watermark on the page
 * Positioned coming in from the bottom-left at an angle
 */
function drawCompassRoseWatermark(pdf: jsPDF, pageWidth: number, pageHeight: number): void {
    const centerX = 35;  // Coming in from left
    const centerY = pageHeight - 40;  // Near bottom
    const radius = 28;
    const angle = -15 * (Math.PI / 180);  // 15 degrees rotation

    pdf.setDrawColor(220, 225, 230);
    pdf.setLineWidth(0.25);

    // Helper to rotate a point around center
    const rotate = (x: number, y: number) => {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const dx = x - centerX;
        const dy = y - centerY;
        return {
            x: centerX + dx * cos - dy * sin,
            y: centerY + dx * sin + dy * cos
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
}

/**
 * Generate the Deck Log PDF using jsPDF
 */
async function generateDeckLogPDF(entries: ShipLogEntry[], vesselName?: string, vesselData?: VesselData): Promise<jsPDF> {
    const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
    });

    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 15;
    const contentWidth = pageWidth - margin * 2;

    // Sort entries (newest first for display, but we'll reverse for chronological)
    const sortedEntries = [...entries].sort((a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Calculate statistics
    const startTime = sortedEntries.length > 0 ? new Date(sortedEntries[sortedEntries.length - 1].timestamp) : new Date();
    const endTime = sortedEntries.length > 0 ? new Date(sortedEntries[0].timestamp) : new Date();
    const totalDistance = sortedEntries.length > 0 ? (sortedEntries[0].cumulativeDistanceNM || 0) : 0;

    const durationMs = endTime.getTime() - startTime.getTime();
    const durationHours = Math.round(durationMs / (1000 * 60 * 60));

    const speeds = entries.filter(e => e.speedKts && e.speedKts > 0).map(e => e.speedKts!);
    const avgSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;

    // Format dates
    const formatDate = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
    const startDateStr = formatDate(startTime);
    const endDateStr = formatDate(endTime);
    const vessel = vesselName || 'Vessel';

    // Get start/end entries for route info
    const chronoEntriesForRoute = [...sortedEntries].reverse();
    const startRouteEntry = chronoEntriesForRoute.find(e => e.latitude && e.longitude);
    const endRouteEntry = [...chronoEntriesForRoute].reverse().find(e => e.latitude && e.longitude);

    // Reverse geocode start and end locations
    let startLocationName = '';
    let endLocationName = '';
    let startCoordStr = '';
    let endCoordStr = '';

    if (startRouteEntry) {
        startCoordStr = `${Math.abs(startRouteEntry.latitude!).toFixed(4)}°${startRouteEntry.latitude! < 0 ? 'S' : 'N'}, ${Math.abs(startRouteEntry.longitude!).toFixed(4)}°${startRouteEntry.longitude! < 0 ? 'W' : 'E'}`;
        startLocationName = await reverseGeocode(startRouteEntry.latitude!, startRouteEntry.longitude!);
        console.log('[PDF] Start location:', startLocationName);
    }
    if (endRouteEntry) {
        endCoordStr = `${Math.abs(endRouteEntry.latitude!).toFixed(4)}°${endRouteEntry.latitude! < 0 ? 'S' : 'N'}, ${Math.abs(endRouteEntry.longitude!).toFixed(4)}°${endRouteEntry.longitude! < 0 ? 'W' : 'E'}`;
        endLocationName = await reverseGeocode(endRouteEntry.latitude!, endRouteEntry.longitude!);
        console.log('[PDF] End location:', endLocationName);
    }

    // Group entries by date
    const entriesByDate = new Map<string, ShipLogEntry[]>();
    const chronoEntries = [...sortedEntries].reverse();

    chronoEntries.forEach(entry => {
        const d = new Date(entry.timestamp);
        const dateKey = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
        if (!entriesByDate.has(dateKey)) {
            entriesByDate.set(dateKey, []);
        }
        entriesByDate.get(dateKey)!.push(entry);
    });

    let y = 0;
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
    const routeText = startLocationName && endLocationName
        ? `${startLocationName} to ${endLocationName}`
        : 'Voyage Record';
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
    const sortedByTimeForWeather = [...entries].sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const departureForHeader = sortedByTimeForWeather[0];

    if (departureForHeader && (departureForHeader.windSpeed || departureForHeader.waveHeight || departureForHeader.pressure)) {
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
            wxParts.push(`Wind: ${departureForHeader.windSpeed}kts ${departureForHeader.windDirection || ''}`);
        }
        if (departureForHeader.waveHeight) {
            wxParts.push(`Waves: ${departureForHeader.waveHeight.toFixed(1)}m`);
        }
        if (departureForHeader.pressure) {
            wxParts.push(`Baro: ${departureForHeader.pressure}mb`);
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

    // Vessel Specifications Section (only if vessel data exists)
    const vesselProfile = vesselData?.vessel;
    const vesselUnits = vesselData?.vesselUnits;

    if (vesselProfile && (vesselProfile.length || vesselProfile.beam || vesselProfile.draft || vesselProfile.fuelCapacity || vesselProfile.waterCapacity)) {
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
            specs.push({ label: 'Length', value: `${vesselProfile.length}${lengthUnit}` });
        }
        if (vesselProfile.beam) {
            const beamUnit = vesselUnits?.beam || 'ft';
            specs.push({ label: 'Beam', value: `${vesselProfile.beam}${beamUnit}` });
        }
        if (vesselProfile.draft) {
            const draftUnit = vesselUnits?.draft || 'ft';
            specs.push({ label: 'Draft', value: `${vesselProfile.draft}${draftUnit}` });
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
            const xPos = margin + (specColWidth * (idx + 0.5));
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

    // Table column widths
    const cols = {
        time: 18,
        position: 45,
        cogSog: 25,
        weather: 28,
        notes: contentWidth - 18 - 45 - 25 - 28
    };

    // Process entries by date
    entriesByDate.forEach((dateEntries, dateKey) => {
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
        pdf.text('COG/SOG', x, y + 4);
        x += cols.cogSog;
        pdf.text('WIND/DIR', x, y + 4);
        x += cols.weather;
        pdf.text('NOTES', x, y + 4);
        y += 7;

        // Draw entries
        dateEntries.forEach((entry, idx) => {
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
                pdf.text('COG/SOG', hx, y + 4);
                hx += cols.cogSog;
                pdf.text('WIND/DIR', hx, y + 4);
                hx += cols.weather;
                pdf.text('NOTES', hx, y + 4);
                y += 7;
            }

            const time = new Date(entry.timestamp);
            const timeStr = time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            const hour = time.getHours();

            // Check if this is a watch change (4,4,4,3,3,3,3 pattern)
            // Watch changes at: 00:00, 04:00, 08:00, 12:00, 15:00, 18:00, 21:00
            const watchChangeHours = [0, 4, 8, 12, 15, 18, 21];
            const isWatchChange = watchChangeHours.includes(hour) && time.getMinutes() < 15;

            // Draw weather summary box at watch changes
            if (isWatchChange && (idx === 0 || new Date(dateEntries[idx - 1].timestamp).getHours() !== hour)) {
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
                    21: 'First Watch (2100-0000)'
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

                // Waves
                pdf.setFont('helvetica', 'bold');
                pdf.text('Waves:', wxX, wxY);
                pdf.setFont('helvetica', 'normal');
                const waveText = entry.waveHeight ? `${entry.waveHeight.toFixed(1)}m` : 'N/A';
                pdf.text(waveText, wxX + 12, wxY);
                wxX += 28;

                // Barometer
                pdf.setFont('helvetica', 'bold');
                pdf.text('Baro:', wxX, wxY);
                pdf.setFont('helvetica', 'normal');
                const baroText = entry.pressure ? `${entry.pressure}mb` : 'N/A';
                pdf.text(baroText, wxX + 10, wxY);
                wxX += 30;

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
            pdf.text(pos.substring(0, 22), x, y + 3);
            x += cols.position;

            // COG/SOG
            const cog = entry.courseDeg !== undefined ? `${String(entry.courseDeg).padStart(3, '0')}T` : '';
            const sog = entry.speedKts ? `/${entry.speedKts.toFixed(1)}` : '';
            pdf.text(`${cog}${sog}`, x, y + 3);
            x += cols.cogSog;

            // Weather
            const wind = entry.windSpeed ? `${entry.windSpeed}kts ${entry.windDirection || ''}` : '';
            pdf.text(wind.substring(0, 12), x, y + 3);
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
    pageNum++;

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
    const validEntries = entries.filter(e => e.latitude && e.longitude);

    // Map dimensions
    const mapX = margin;
    const mapY = 55;
    const mapWidth = contentWidth;
    const mapHeight = 160;  // Larger map area for high-res image

    // Fetch high-res Mapbox static image with coastlines
    console.log('[PDF Export] Generating map via Static API...');
    const mapImageDataUrl = await fetchMapboxStaticImage(entries, mapWidth, mapHeight);

    if (mapImageDataUrl) {
        // Embed the high-res Mapbox map image
        try {
            pdf.addImage(mapImageDataUrl, 'PNG', mapX, mapY, mapWidth, mapHeight);
        } catch (err) {
            console.error('Failed to embed map image:', err);
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
            const sorted = [...validEntries].sort((a, b) =>
                new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
            const startPt = sorted[0];
            const endPt = sorted[sorted.length - 1];

            pdf.setFontSize(12);
            pdf.setTextColor(50, 60, 70);
            pdf.text('Voyage Track', mapX + mapWidth / 2, mapY + 20, { align: 'center' });

            pdf.setFontSize(10);
            pdf.text(`Start: ${startPt.latitude?.toFixed(4)}°, ${startPt.longitude?.toFixed(4)}°`, mapX + mapWidth / 2, mapY + 40, { align: 'center' });
            pdf.text(`End: ${endPt.latitude?.toFixed(4)}°, ${endPt.longitude?.toFixed(4)}°`, mapX + mapWidth / 2, mapY + 55, { align: 'center' });
            pdf.text(`Entries: ${sorted.length}`, mapX + mapWidth / 2, mapY + 70, { align: 'center' });

            pdf.setFontSize(8);
            pdf.setTextColor(100, 100, 100);
            pdf.text('(High-res map requires Mapbox API)', mapX + mapWidth / 2, mapY + mapHeight - 10, { align: 'center' });
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
    pdf.setDrawColor(56, 189, 248);
    pdf.setLineWidth(1.5);
    pdf.line(margin + 130, y + 6, margin + 145, y + 6);
    pdf.setTextColor(51, 65, 85);
    pdf.text('Track', margin + 148, y + 7);

    // ===== VOYAGE DETAILS SECTION =====
    y += 18;

    // Get sorted entries for location info
    const sortedForInfo = [...validEntries].sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const startEntry = sortedForInfo[0];
    const endEntry = sortedForInfo[sortedForInfo.length - 1];
    const waypointEntriesForInfo = sortedForInfo.filter(e => e.entryType === 'waypoint');

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
        let wpY = y + 29;
        pdf.setFillColor(245, 158, 11);
        pdf.setFont('helvetica', 'bold');
        pdf.text('Waypoints:', margin + 14, wpY);
        pdf.setFont('helvetica', 'normal');

        waypointEntriesForInfo.slice(0, 5).forEach((wp, i) => {
            const wpCoords = `${Math.abs(wp.latitude!).toFixed(4)}°${wp.latitude! < 0 ? 'S' : 'N'}, ${Math.abs(wp.longitude!).toFixed(4)}°${wp.longitude! < 0 ? 'W' : 'E'}`;
            pdf.setFillColor(245, 158, 11); // Orange - set inside loop
            pdf.circle(margin + 8, wpY + (i * 6) - 1, 1.5, 'F');
            pdf.text(`WP${i + 1}: ${wpCoords}`, margin + 38, wpY + (i * 6));
        });

        if (waypointEntriesForInfo.length > 5) {
            pdf.text(`... and ${waypointEntriesForInfo.length - 5} more waypoints`, margin + 38, wpY + 30);
        }
    }



    // ===== CERTIFICATION PAGE =====
    pdf.addPage();
    pageNum++;

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
    const complianceText = 'This log conforms to IMO Resolution A.916(22) and SOLAS Chapter V standards for ship logbook documentation. ' +
        'The original log entries are generated from GPS tracking data and may require verification.';
    const complianceLines = pdf.splitTextToSize(complianceText, contentWidth - 10);
    pdf.text(complianceLines, margin + 5, pageHeight - 22);

    // Page numbers, headers, footers, and compass watermark on ALL pages
    const totalPages = pdf.getNumberOfPages();
    const generatedDate = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'numeric', year: 'numeric' });

    for (let i = 1; i <= totalPages; i++) {
        pdf.setPage(i);

        // Draw angled compass rose watermark (bottom-left)
        drawCompassRoseWatermark(pdf, pageWidth, pageHeight);

        // Page header (skip first page which has its own title)
        if (i > 1) {
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

/**
 * Helper: Download file
 */
function downloadFile(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
