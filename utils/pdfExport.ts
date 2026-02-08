import { VoyagePlan, VesselProfile } from '../types';

interface PDFExportOptions {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
    includeTimeline?: boolean;
    includeResources?: boolean;
    includeEmergency?: boolean;
}

/**
 * Generate a printable HTML passage briefing
 * Can be used with browser print or PDF generation library
 */
export const generatePassageBriefHTML = ({
    voyagePlan,
    vessel,
    includeTimeline = true,
    includeResources = true,
    includeEmergency = true
}: PDFExportOptions): string => {
    const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    // Parse duration
    const durationStr = voyagePlan.durationApprox.toLowerCase();
    let durationHours = 0;
    if (durationStr.includes('day')) {
        const days = parseFloat(durationStr.match(/(\d+\.?\d*)/)?.[0] || '0');
        durationHours = days * 24;
    } else if (durationStr.includes('hour')) {
        durationHours = parseFloat(durationStr.match(/(\d+\.?\d*)/)?.[0] || '0');
    }

    // Calculate resources - vessel type aware
    const isSail = vessel.type === 'sail';
    const fuelBurnRate = vessel.fuelBurn || 0;
    const motoringFraction = isSail ? 0.15 : 1.0;
    const motoringHours = durationHours * motoringFraction;
    const fuelRequired = fuelBurnRate * motoringHours;
    const fuelWithReserve = fuelRequired * 1.3;
    const crewCount = vessel.crewCount || 2;

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Passage Brief: ${voyagePlan.origin} to ${voyagePlan.destination}</title>
    <style>
        @media print {
            @page { margin: 0.75in; }
            body { margin: 0; padding: 0; }
            .page-break { page-break-before: always; }
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: 'Arial', sans-serif;
            font-size: 11pt;
            line-height: 1.5;
            color: #1a1a1a;
            background: white;
        }
        
        .container {
            max-width: 8.5in;
            margin: 0 auto;
            padding: 0.5in;
        }
        
        .header {
            text-align: center;
            border-bottom: 3px solid #0369a1;
            padding-bottom: 0.5in;
            margin-bottom: 0.5in;
        }
        
        .header h1 {
            font-size: 24pt;
            color: #0369a1;
            margin-bottom: 0.1in;
            text-transform: uppercase;
            letter-spacing: 2px;
        }
        
        .header .route {
            font-size: 18pt;
            font-weight: bold;
            margin-bottom: 0.1in;
        }
        
        .header .meta {
            font-size: 10pt;
            color: #666;
        }
        
        .header .vessel-badge {
            display: inline-block;
            background: #0369a1;
            color: white;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 9pt;
            font-weight: bold;
            margin-top: 8px;
        }
        
        .section {
            margin-bottom: 0.4in;
        }
        
        .section-title {
            font-size: 14pt;
            font-weight: bold;
            color: #0369a1;
            border-bottom: 2px solid #e5e7eb;
            padding-bottom: 4px;
            margin-bottom: 0.15in;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0.2in;
            margin-bottom: 0.15in;
        }
        
        .info-item {
            border: 1px solid #e5e7eb;
            padding: 8px 12px;
            border-radius: 4px;
            background: #f9fafb;
        }
        
        .info-label {
            font-size: 9pt;
            color: #666;
            text-transform: uppercase;
            font-weight: bold;
            margin-bottom: 2px;
        }
        
        .info-value {
            font-size: 11pt;
            font-weight: bold;
        }
        
        .waypoint-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 0.15in;
        }
        
        .waypoint-table th {
            background: #0369a1;
            color: white;
            padding: 8px;
            text-align: left;
            font-size: 9pt;
            text-transform: uppercase;
        }
        
        .waypoint-table td {
            border: 1px solid #e5e7eb;
            padding: 6px 8px;
            font-size: 10pt;
        }
        
        .waypoint-table tr:nth-child(even) {
            background: #f9fafb;
        }
        
        .hazard-box {
            border-left: 4px solid #dc2626;
            background: #fee;
            padding: 10px;
            margin-bottom: 8px;
        }
        
        .hazard-title {
            font-weight: bold;
            color: #dc2626;
            font-size: 10pt;
            margin-bottom: 4px;
        }
        
        .hazard-text {
            font-size: 9pt;
            color: #333;
        }
        
        .emergency-contact {
            border: 2px solid #f59e0b;
            padding: 10px;
            margin-bottom: 8px;
            border-radius: 4px;
        }
        
        .emergency-title {
            font-weight: bold;
            color: #f59e0b;
            margin-bottom: 6px;
        }
        
        .mayday-box {
            border: 3px solid #dc2626;
            background: #fee;
            padding: 12px;
            margin: 0.2in 0;
            font-family: monospace;
            font-size: 9pt;
            line-height: 1.6;
        }
        
        .disclaimer {
            border: 2px solid #f59e0b;
            background: #fffbeb;
            padding: 12px;
            margin-top: 0.3in;
            font-size: 8pt;
            line-height: 1.4;
        }
        
        .footer {
            text-align: center;
            margin-top: 0.5in;
            padding-top: 0.2in;
            border-top: 1px solid #e5e7eb;
            font-size: 8pt;
            color: #666;
        }
        
        .status-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 8pt;
            font-weight: bold;
        }
        
        .status-safe { background: #d1fae5; color: #065f46; }
        .status-caution { background: #fef3c7; color: #92400e; }
        .status-unsafe { background: #fee2e2; color: #991b1b; }
    </style>
</head>
<body>
    <div class="container">
        <!-- HEADER -->
        <div class="header">
            <h1>Passage Briefing</h1>
            <div class="route">${voyagePlan.origin} → ${voyagePlan.destination}</div>
            <div class="meta">
                Prepared: ${currentDate} | Distance: ${voyagePlan.distanceApprox} | Duration: ${voyagePlan.durationApprox}
            </div>
            <div class="vessel-badge">${vessel.name} (${vessel.type.toUpperCase()}) | ${crewCount} crew</div>
        </div>

        <!-- VOYAGE OVERVIEW -->
        <div class="section">
            <div class="section-title">Voyage Overview</div>
            <div class="info-grid">
                <div class="info-item">
                    <div class="info-label">Departure</div>
                    <div class="info-value">${voyagePlan.origin}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Destination</div>
                    <div class="info-value">${voyagePlan.destination}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Departure Date</div>
                    <div class="info-value">${new Date(voyagePlan.departureDate).toLocaleDateString()}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Est. Duration</div>
                    <div class="info-value">${voyagePlan.durationApprox}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Distance</div>
                    <div class="info-value">${voyagePlan.distanceApprox}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Cruising Speed</div>
                    <div class="info-value">${vessel.cruisingSpeed} kts</div>
                </div>
            </div>
            ${voyagePlan.suitability ? `
            <div class="info-item" style="margin-top: 0.15in;">
                <div class="info-label">Passage Suitability</div>
                <div class="info-value">
                    <span class="status-badge status-${voyagePlan.suitability.status.toLowerCase()}">
                        ${voyagePlan.suitability.status}
                    </span>
                    <div style="margin-top: 6px; font-size: 10pt; font-weight: normal;">${voyagePlan.suitability.reasoning}</div>
                </div>
            </div>
            ` : ''}
        </div>

        <!-- WAYPOINTS -->
        <div class="section">
            <div class="section-title">Waypoints</div>
            <table class="waypoint-table">
                <thead>
                    <tr>
                        <th>WP</th>
                        <th>Name</th>
                        <th>Coordinates</th>
                        <th>Wind</th>
                        <th>Waves</th>
                    </tr>
                </thead>
                <tbody>
                    ${voyagePlan.waypoints.map((wp, idx) => `
                    <tr>
                        <td><strong>WP-${String(idx + 1).padStart(2, '0')}</strong></td>
                        <td>${wp.name}</td>
                        <td>${wp.coordinates ? `${wp.coordinates.lat.toFixed(3)}°, ${wp.coordinates.lon.toFixed(3)}°` : 'N/A'}</td>
                        <td>${wp.windSpeed ? `${wp.windSpeed} kts` : 'N/A'}</td>
                        <td>${wp.waveHeight ? `${wp.waveHeight} ft` : 'N/A'}</td>
                    </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        ${includeResources ? `
        <div class="section page-break">
            <div class="section-title">Resource Planning</div>
            <div class="info-grid">
                <div class="info-item">
                    <div class="info-label">${isSail ? 'Motor Reserve' : 'Fuel Required'} (+ 30% Reserve)</div>
                    <div class="info-value">${fuelWithReserve.toFixed(0)} L</div>
                    <div style="font-size: 9pt; color: #666; margin-top: 4px;">
                        Base: ${fuelRequired.toFixed(0)}L | Reserve: ${(fuelWithReserve - fuelRequired).toFixed(0)}L${isSail ? ' | ~15% motoring' : ''}
                    </div>
                </div>
                <div class="info-item">
                    <div class="info-label">Fuel Capacity</div>
                    <div class="info-value">${vessel.fuelCapacity || 0} L</div>
                    <div style="font-size: 9pt; color: ${(vessel.fuelCapacity || 0) >= fuelWithReserve ? '#10b981' : '#dc2626'}; margin-top: 4px;">
                        ${(vessel.fuelCapacity || 0) >= fuelWithReserve ? '✓ Sufficient' : isSail ? '⚠ Motor reserve exceeds tank' : '⚠ Insufficient - Plan Refueling'}
                    </div>
                </div>
                <div class="info-item">
                    <div class="info-label">Water Required (3L/person/day)</div>
                    <div class="info-value">${(crewCount * (durationHours / 24) * 3).toFixed(0)} L</div>
                    <div style="font-size: 9pt; color: #666; margin-top: 4px;">
                        ${crewCount} crew × ${(durationHours / 24).toFixed(1)} days
                    </div>
                </div>
                <div class="info-item">
                    <div class="info-label">Meals Required</div>
                    <div class="info-value">${Math.ceil((durationHours / 24) * crewCount * 3)}</div>
                    <div style="font-size: 9pt; color: #666; margin-top: 4px;">
                        Plus 48hr emergency rations
                    </div>
                </div>
            </div>
        </div>
        ` : ''}

        <!-- HAZARDS -->
        ${voyagePlan.hazards && voyagePlan.hazards.length > 0 ? `
        <div class="section">
            <div class="section-title">Identified Hazards</div>
            ${voyagePlan.hazards.map(h => `
            <div class="hazard-box">
                <div class="hazard-title">${h.name} [${h.severity}]</div>
                <div class="hazard-text">${h.description}</div>
            </div>
            `).join('')}
        </div>
        ` : ''}

        ${includeEmergency ? `
        <div class="section page-break">
            <div class="section-title">Emergency Procedures</div>
            
            <div class="mayday-box">
                <strong style="color: #dc2626;">MAYDAY PROTOCOL (VHF Channel 16)</strong><br>
                1. MAYDAY MAYDAY MAYDAY<br>
                2. This is ${vessel.name} ${vessel.name} ${vessel.name}<br>
                3. Position: [INSERT LAT/LON]<br>
                4. Nature of distress: [DESCRIBE]<br>
                5. Assistance required: [SPECIFY]<br>
                6. Souls on board: ___<br>
                7. OVER
            </div>

            <div class="emergency-contact">
                <div class="emergency-title">🚨 US Coast Guard</div>
                <div>VHF: Channel 16 (156.8 MHz)</div>
                <div>Phone: 1-800-221-8724</div>
            </div>

            <div class="emergency-contact">
                <div class="emergency-title">📡 Marine Rescue Coordination</div>
                <div>VHF: Channel 16 (156.8 MHz)</div>
                <div>Emergency: 911</div>
            </div>

            <div class="emergency-contact">
                <div class="emergency-title">☁️ NOAA Weather Radio</div>
                <div>Frequency: 162.55 MHz</div>
            </div>
        </div>
        ` : ''}

        <!-- DISCLAIMER -->
        <div class="disclaimer">
            <strong>⚠️ IMPORTANT SAFETY DISCLAIMER</strong><br>
            This passage brief is computer-generated for planning purposes only. The captain must verify all information,
            check current weather forecasts, NOTAMs, and navigational warnings before departure. The captain is solely 
            responsible for the safety of crew and vessel. Weather conditions can change rapidly - maintain continuous 
            monitoring throughout the passage.
        </div>

        <!-- FOOTER -->
        <div class="footer">
            Generated by Thalassa Marine Weather | ${currentDate}<br>
            This document is valid for planning purposes only - verify all information before departure
        </div>
    </div>
</body>
</html>
    `;

    return html.trim();
};

/**
 * Trigger browser print dialog for PDF export
 */
export const printPassageBrief = (options: PDFExportOptions): void => {
    const html = generatePassageBriefHTML(options);

    // Open in new window and trigger print
    const printWindow = window.open('', '_blank');
    if (printWindow) {
        printWindow.document.write(html);
        printWindow.document.close();

        // Wait for content to load, then print
        printWindow.onload = () => {
            printWindow.print();
        };
    }
};

/**
 * Download passage brief as HTML file
 */
export const downloadPassageBrief = (options: PDFExportOptions): void => {
    const html = generatePassageBriefHTML(options);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `Passage_Brief_${options.voyagePlan.origin}_to_${options.voyagePlan.destination}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};
