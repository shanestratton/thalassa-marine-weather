/**
 * GPX Route Export — Generates GPX 1.1 XML from a VoyagePlan.
 *
 * Standards: GPX 1.1 (Topografix schema), compatible with all major chartplotters.
 * Exports route waypoints with proper metadata, wrapped in a <rte> element.
 * Includes bathymetric depth as <ele> (negative = below sea level).
 */

import { VoyagePlan } from '../types';

/** Escape XML special characters */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate GPX 1.1 XML string from a VoyagePlan
 */
export function generateRouteGPX(voyagePlan: VoyagePlan): string {
  const timestamp = new Date().toISOString();
  const routeName = `${voyagePlan.origin} → ${voyagePlan.destination}`;

  // Build route points
  const rtePts: string[] = [];

  // Origin
  if (voyagePlan.originCoordinates) {
    rtePts.push(`      <rtept lat="${voyagePlan.originCoordinates.lat}" lon="${voyagePlan.originCoordinates.lon}">
        <name>${escapeXml(typeof voyagePlan.origin === 'string' ? voyagePlan.origin.split(',')[0] : 'Origin')}</name>
        <desc>Departure</desc>
        <type>DEPARTURE</type>
      </rtept>`);
  }

  // Waypoints
  voyagePlan.waypoints.forEach((wp, i) => {
    if (!wp.coordinates) return;
    const depthEle = wp.depth_m !== undefined ? `\n        <ele>${-wp.depth_m}</ele>` : '';
    const depthDesc = wp.depth_m !== undefined ? ` Depth: ${wp.depth_m}m` : '';
    rtePts.push(`      <rtept lat="${wp.coordinates.lat}" lon="${wp.coordinates.lon}">${depthEle}
        <name>${escapeXml(wp.name || `WP-${String(i + 1).padStart(2, '0')}`)}</name>
        <desc>Wind: ${wp.windSpeed ?? '--'}kts, Waves: ${wp.waveHeight ?? '--'}ft${depthDesc}</desc>
        <type>WAYPOINT</type>
      </rtept>`);
  });

  // Destination
  if (voyagePlan.destinationCoordinates) {
    rtePts.push(`      <rtept lat="${voyagePlan.destinationCoordinates.lat}" lon="${voyagePlan.destinationCoordinates.lon}">
        <name>${escapeXml(typeof voyagePlan.destination === 'string' ? voyagePlan.destination.split(',')[0] : 'Destination')}</name>
        <desc>Arrival</desc>
        <type>ARRIVAL</type>
      </rtept>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1"
     creator="Thalassa Marine Weather"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(routeName)}</name>
    <desc>Passage plan: ${escapeXml(voyagePlan.distanceApprox)}, estimated ${escapeXml(voyagePlan.durationApprox)}. Depth-verified via ETOPO 2022 bathymetry.</desc>
    <time>${timestamp}</time>
    <link href="https://thalassa.app">
      <text>Thalassa Marine Weather</text>
    </link>
  </metadata>
  <rte>
    <name>${escapeXml(routeName)}</name>
    <desc>Departure: ${escapeXml(voyagePlan.departureDate || 'TBD')} | ${escapeXml(voyagePlan.durationApprox)}</desc>
${rtePts.join('\n')}
  </rte>
</gpx>`;
}

/**
 * Download the GPX file via browser or native share
 */
export function downloadRouteGPX(voyagePlan: VoyagePlan): void {
  const gpx = generateRouteGPX(voyagePlan);
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });

  const origin = typeof voyagePlan.origin === 'string' ? voyagePlan.origin.split(',')[0].replace(/\s+/g, '_') : 'Origin';
  const dest = typeof voyagePlan.destination === 'string' ? voyagePlan.destination.split(',')[0].replace(/\s+/g, '_') : 'Destination';
  const filename = `Route_${origin}_to_${dest}.gpx`;

  // Try Web Share API first (native iOS/Android share sheet)
  if (navigator.share && navigator.canShare) {
    const file = new File([blob], filename, { type: 'application/gpx+xml' });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({
        title: `Route: ${voyagePlan.origin} → ${voyagePlan.destination}`,
        text: `Passage plan: ${voyagePlan.distanceApprox}`,
        files: [file],
      }).catch(() => {
        // Fallback to download if share fails
        triggerDownload(blob, filename);
      });
      return;
    }
  }

  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
