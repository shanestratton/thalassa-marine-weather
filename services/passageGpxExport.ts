/**
 * Passage GPX Export
 * Export a planned passage route as GPX 1.1 with route waypoints + full track.
 *
 * Creates:
 *   - <rte> with <rtept> for departure, each turn waypoint, and arrival
 *   - <trk> with full route coordinates as trackpoints
 *   - Thalassa wind/speed extensions on each point
 */

import { type TurnWaypoint, type IsochroneResult } from './IsochroneRouter';

function escapeXml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function exportPassageAsGPX(
    isoResult: IsochroneResult,
    waypoints: TurnWaypoint[],
    departureName: string,
    arrivalName: string,
    departureTime: string,
): string {
    const depTime = new Date(departureTime).getTime();
    const routeName = `${departureName} → ${arrivalName}`;

    // ── Route waypoints (<rte>) ──
    const rtePts = waypoints.map(wp => {
        const name = wp.id === 'DEP' ? departureName
            : wp.id === 'ARR' ? arrivalName
                : wp.id;
        return `    <rtept lat="${wp.lat.toFixed(6)}" lon="${wp.lon.toFixed(6)}">
      <ele>0</ele>
      <time>${wp.eta}</time>
      <name>${escapeXml(name)}</name>
      <desc>${wp.distanceNM} NM, ${wp.timeHours.toFixed(1)}h, ${wp.bearing}°</desc>
      <extensions>
        <thalassa:tws>${wp.tws.toFixed(1)}</thalassa:tws>
        <thalassa:twa>${wp.twa.toFixed(0)}</thalassa:twa>
        <thalassa:speed>${wp.speed.toFixed(1)}</thalassa:speed>
        <thalassa:bearingChange>${wp.bearingChange}</thalassa:bearingChange>
      </extensions>
    </rtept>`;
    }).join('\n');

    // ── Full track (<trk>) ──
    const trkPts = isoResult.route.map(node => {
        const eta = new Date(depTime + node.timeHours * 3600_000).toISOString();
        return `      <trkpt lat="${node.lat.toFixed(6)}" lon="${node.lon.toFixed(6)}">
        <ele>0</ele>
        <time>${eta}</time>
        <speed>${(node.speed * 0.514444).toFixed(2)}</speed>
        <course>${node.bearing.toFixed(0)}</course>
        <extensions>
          <thalassa:tws>${node.tws.toFixed(1)}</thalassa:tws>
          <thalassa:twa>${node.twa.toFixed(0)}</thalassa:twa>
        </extensions>
      </trkpt>`;
    }).join('\n');

    // ── Bounds ──
    const lats = isoResult.route.map(n => n.lat);
    const lons = isoResult.route.map(n => n.lon);

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Thalassa Marine Weather"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xmlns:thalassa="https://thalassa.app/gpx/1"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(routeName)}</name>
    <desc>Planned passage: ${isoResult.totalDistanceNM.toFixed(0)} NM, ${isoResult.totalDurationHours.toFixed(0)}h — exported from Thalassa</desc>
    <author><name>Thalassa Marine Weather</name></author>
    <time>${new Date().toISOString()}</time>
    <keywords>passage,planned,sailing,navigation</keywords>
    <bounds minlat="${Math.min(...lats).toFixed(6)}"
            minlon="${Math.min(...lons).toFixed(6)}"
            maxlat="${Math.max(...lats).toFixed(6)}"
            maxlon="${Math.max(...lons).toFixed(6)}" />
  </metadata>
  <rte>
    <name>${escapeXml(routeName)}</name>
    <desc>${isoResult.totalDistanceNM.toFixed(0)} NM | ${isoResult.totalDurationHours.toFixed(0)}h | ${waypoints.length} waypoints</desc>
    <type>planned_passage</type>
${rtePts}
  </rte>
  <trk>
    <name>${escapeXml(routeName)} (Track)</name>
    <desc>Full isochrone route: ${isoResult.routeCoordinates.length} points</desc>
    <type>planned_passage</type>
    <trkseg>
${trkPts}
    </trkseg>
  </trk>
</gpx>`;
}
