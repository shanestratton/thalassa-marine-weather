/**
 * Ship's Log Export Utilities
 * Generate PDF and CSV exports for legal compliance and analysis
 */

import { ShipLogEntry } from '../types';

/**
 * Export log entries as CSV
 * Compatible with Excel, Google Sheets, maritime software
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

        // CSV Headers
        const headers = [
            'Timestamp',
            'Position (DMS)',
            'Latitude',
            'Longitude',
            'Distance (NM)',
            'Cumulative Distance (NM)',
            'Speed (kts)',
            'Course (°)',
            'Wind Speed (kts)',
            'Wind Direction',
            'Wave Height (m)',
            'Pressure (mb)',
            'Air Temp (°C)',
            'Water Temp (°C)',
            'Entry Type',
            'Waypoint Name',
            'Notes'
        ];

        // Format entries as CSV rows
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
            entry.notes ? `"${entry.notes.replace(/"/g, '""')}"` : '' // Escape quotes in notes
        ]);

        // Combine headers and rows
        const csv = [
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');

        callbacks?.onProgress?.('Downloading file...');

        // Download CSV
        downloadFile(csv, filename, 'text/csv');

        // Success callback after brief delay
        setTimeout(() => {
            callbacks?.onSuccess?.();
        }, 500);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to export CSV';
        callbacks?.onError?.(message);
    }
}

/**
 * Export log entries as PDF
 * Simplified version - creates a text-based PDF using data URIs
 */
export function exportToPDF(
    entries: ShipLogEntry[],
    filename: string = 'ships_log.pdf',
    callbacks?: {
        onProgress?: (message: string) => void;
        onSuccess?: () => void;
        onError?: (error: string) => void;
    }
): void {
    try {
        callbacks?.onProgress?.('Preparing PDF export...');

        if (entries.length === 0) {
            throw new Error('No entries to export');
        }

        // For now, create a detailed text version
        // In production, you'd use a library like jsPDF or pdfmake

        const content = generatePDFContent(entries);

        // Create HTML page for printing
        callbacks?.onProgress?.('Opening print window...');

        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            throw new Error('Please allow popups to export PDF');
        }

        printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Ship's Log</title>
            <style>
                body {
                    font-family: 'Courier New', monospace;
                    font-size: 10pt;
                    margin: 1in;
                    color: #000;
                }
                h1 {
                    text-align: center;
                    border-bottom: 2px solid #000;
                    padding-bottom: 10px;
                }
                .entry {
                    page-break-inside: avoid;
                    margin-bottom: 20px;
                    border-bottom: 1px solid #ccc;
                    padding-bottom: 10px;
                }
                .entry-header {
                    font-weight: bold;
                    margin-bottom: 5px;
                }
                .data-row {
                    display: flex;
                    margin: 2px 0;
                }
                .label {
                    font-weight: bold;
                    width: 150px;
                }
                .waypoint {
                    background: #ffffcc;
                    padding: 5px;
                    margin: 5px 0;
                }
                @media print {
                    body { margin: 0.5in; }
                }
            </style>
        </head>
        <body>
            ${content}
        </body>
        </html>
    `);

        printWindow.document.close();
        printWindow.focus();

        // Auto-print after short delay
        setTimeout(() => {
            printWindow.print();
            callbacks?.onSuccess?.();
        }, 250);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to export PDF';
        callbacks?.onError?.(message);
    }
}

function generatePDFContent(entries: ShipLogEntry[]): string {
    const startDate = entries.length > 0 ? new Date(entries[entries.length - 1].timestamp).toLocaleDateString() : '';
    const endDate = entries.length > 0 ? new Date(entries[0].timestamp).toLocaleDateString() : '';
    const totalDistance = entries.length > 0 ? (entries[0].cumulativeDistanceNM || 0).toFixed(1) : '0.0';

    let html = `
        <h1>SHIP'S LOG</h1>
        <p><strong>Period:</strong> ${startDate} - ${endDate}</p>
        <p><strong>Total Distance:</strong> ${totalDistance} NM</p>
        <p><strong>Total Entries:</strong> ${entries.length}</p>
        <hr/>
    `;

    // Reverse to show chronological order
    const chronological = [...entries].reverse();

    chronological.forEach((entry, index) => {
        const timestamp = new Date(entry.timestamp);
        const typeClass = entry.entryType === 'waypoint' ? 'waypoint' : '';

        html += `
            <div class="entry ${typeClass}">
                <div class="entry-header">Entry #${index + 1} - ${timestamp.toLocaleString()}</div>
                <div class="data-row"><span class="label">Position:</span> ${entry.positionFormatted}</div>
                ${entry.distanceNM ? `<div class="data-row"><span class="label">Distance:</span> ${entry.distanceNM.toFixed(1)} NM</div>` : ''}
                ${entry.speedKts ? `<div class="data-row"><span class="label">Speed:</span> ${entry.speedKts.toFixed(1)} kts</div>` : ''}
                ${entry.courseDeg !== undefined ? `<div class="data-row"><span class="label">Course:</span> ${entry.courseDeg}°</div>` : ''}
                ${entry.windSpeed ? `<div class="data-row"><span class="label">Wind:</span> ${entry.windSpeed} kts ${entry.windDirection || ''}</div>` : ''}
                ${entry.waveHeight ? `<div class="data-row"><span class="label">Wave Height:</span> ${entry.waveHeight.toFixed(1)} m</div>` : ''}
                ${entry.airTemp ? `<div class="data-row"><span class="label">Air Temp:</span> ${entry.airTemp}°C</div>` : ''}
                ${entry.waypointName ? `<div class="data-row"><span class="label">WAYPOINT:</span> <strong>${entry.waypointName}</strong></div>` : ''}
                ${entry.notes ? `<div class="data-row"><span class="label">Notes:</span> ${entry.notes}</div>` : ''}
            </div>
        `;
    });

    return html;
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
