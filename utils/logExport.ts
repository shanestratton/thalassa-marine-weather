/**
 * Ship's Log Export Utilities
 * Generate PDF and CSV exports for legal compliance and analysis
 */

import { ShipLogEntry } from '../types';
import { VesselData, decodeHtmlEntities, downloadFile, reverseGeocode } from './logExportHelpers';
import { generateDeckLogPDF } from './logExportPdf';

export async function exportToCSV(
    entries: ShipLogEntry[],
    filename: string = 'voyage_waypoints.csv',
    callbacks?: {
        onProgress?: (message: string) => void;
        onSuccess?: () => void;
        onError?: (error: string) => void;
    },
): Promise<void> {
    try {
        callbacks?.onProgress?.('Preparing CSV export...');

        if (entries.length === 0) {
            throw new Error('No entries to export');
        }

        // Sort entries chronologically (oldest first)
        const sortedEntries = [...entries].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        // GPS-compatible headers: Name, Latitude, Longitude, Description
        const headers = ['Name', 'Latitude', 'Longitude', 'Description'];

        // Build rows with decimal degree coordinates
        const rows = sortedEntries.map((entry, index) => {
            const timestamp = new Date(entry.timestamp);
            const dateStr = timestamp.toLocaleDateString('en-AU', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
            });
            const timeStr = timestamp.toLocaleTimeString('en-AU', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            });

            // Generate name based on entry type
            let name = '';
            if (entry.entryType === 'waypoint' && entry.waypointName) {
                name = entry.waypointName;
            } else if (entry.entryType === 'manual') {
                name = `Log ${dateStr} ${timeStr}`;
            } else {
                name = `Track ${String(index + 1).padStart(3, '0')}`;
            }

            // Latitude and Longitude as decimal degrees (e.g., -27.4698, 153.0251)
            const lat = entry.latitude?.toFixed(6) || '';
            const lon = entry.longitude?.toFixed(6) || '';

            // Description combining timestamp, notes, and entry type
            let description = `${dateStr} ${timeStr}`;
            if (entry.notes) {
                // Escape quotes and clean notes for CSV
                const cleanNotes = decodeHtmlEntities(entry.notes).replace(/"/g, '""');
                description += ` - ${cleanNotes}`;
            }
            if (entry.speedKts) {
                description += ` | ${entry.speedKts.toFixed(1)}kts`;
            }
            if (entry.courseDeg) {
                description += ` | ${Math.round(entry.courseDeg)}°`;
            }

            // Quote fields that might contain commas or special characters
            return [`"${name}"`, lat, lon, `"${description}"`];
        });

        // Build CSV with UTF-8 BOM for Excel compatibility
        const BOM = '\uFEFF'; // UTF-8 Byte Order Mark
        const csv = BOM + [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');

        // Create file blob with UTF-8 encoding
        const csvBlob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const _csvFile = new File([csvBlob], filename, { type: 'text/csv' });

        // Generate filename based on voyage dates
        const startDate = sortedEntries[0] ? new Date(sortedEntries[0].timestamp) : new Date();
        const endDate = sortedEntries[sortedEntries.length - 1]
            ? new Date(sortedEntries[sortedEntries.length - 1].timestamp)
            : new Date();
        const formatDateShort = (d: Date) => `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
        const shareFilename = `voyage_${formatDateShort(startDate)}_to_${formatDateShort(endDate)}.csv`;
        const shareFile = new File([csvBlob], shareFilename, { type: 'text/csv' });

        // Try Web Share API (same as PDF share)
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [shareFile] })) {
            callbacks?.onProgress?.('Opening share sheet...');
            try {
                await navigator.share({
                    title: 'Voyage Waypoints',
                    text: `${sortedEntries.length} waypoints from ${formatDateShort(startDate)} to ${formatDateShort(endDate)}`,
                    files: [shareFile],
                });
                callbacks?.onSuccess?.();
            } catch (shareError) {
                if (shareError instanceof Error && shareError.name === 'AbortError') {
                    // User cancelled - still counts as success
                    callbacks?.onSuccess?.();
                } else {
                    // Fallback to download
                    downloadFile(csv, shareFilename, 'text/csv;charset=utf-8');
                    callbacks?.onSuccess?.();
                }
            }
        } else {
            // Fallback to direct download
            callbacks?.onProgress?.('Saving CSV...');
            downloadFile(csv, shareFilename, 'text/csv;charset=utf-8');
            callbacks?.onSuccess?.();
        }
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
    vesselData?: VesselData,
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
    vesselData?: VesselData,
): Promise<void> {
    try {
        callbacks?.onProgress?.('Generating PDF...');

        if (entries.length === 0) {
            throw new Error('No entries to share');
        }

        // Get route info for professional filename
        const sortedForRoute = [...entries].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
        const startEntry = sortedForRoute.find((e) => e.latitude && e.longitude);
        const endEntry = [...sortedForRoute].reverse().find((e) => e.latitude && e.longitude);

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
                    files: [pdfFile],
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
