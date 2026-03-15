/**
 * Build Channel Walls from IALA Marks
 * 
 * Takes nav_markers.geojson and creates virtual channel walls:
 * 1. Extracts port (red) and starboard (green) lateral marks
 * 2. Sorts by nearest-neighbor for clean channel lines
 * 3. Outputs thalassa_obstacles.geojson for MarinaGridRouter
 * 
 * Usage: node build_channel_walls.js [markers_file] [danger_file]
 */

import fs from 'fs';
import * as turf from '@turf/turf';

// ── Config ──────────────────────────────────────────────────────
const MARKERS_FILE = process.argv[2] || 'nav_markers.geojson';
const COASTLINE_FILE = process.argv[3] || 'final_danger_micro.geojson';
const OUTPUT_FILE = 'thalassa_obstacles.geojson';
const MAX_CHAIN_GAP_KM = 2.0;

// ── Load Data ───────────────────────────────────────────────────
console.log(`Loading markers: ${MARKERS_FILE}`);
const markersData = JSON.parse(fs.readFileSync(MARKERS_FILE, 'utf8'));
console.log(`  Total features: ${markersData.features.length}`);

// ── Separate marks by class ─────────────────────────────────────
const portBuoys = [];
const starboardBuoys = [];
const cardinalMarks = [];
const otherObstacles = [];

for (const feature of markersData.features) {
    const props = feature.properties || {};
    const geomType = feature.geometry?.type;
    const cls = props._class || '';

    if (geomType !== 'Point') {
        otherObstacles.push(feature);
        continue;
    }

    if (cls === 'port') portBuoys.push(feature);
    else if (cls === 'starboard') starboardBuoys.push(feature);
    else if (cls.startsWith('cardinal')) cardinalMarks.push(feature);
}

console.log(`  Port (red) marks:       ${portBuoys.length}`);
console.log(`  Starboard (green) marks: ${starboardBuoys.length}`);
console.log(`  Cardinal marks:         ${cardinalMarks.length}`);
console.log(`  Other features:         ${otherObstacles.length}`);

// ── Nearest-Neighbor Sorting with chain splitting ───────────────
function sortBuoysToChains(buoys, sideName) {
    if (buoys.length < 2) {
        console.log(`  ${sideName}: Not enough marks (${buoys.length}), skipping`);
        return [];
    }

    const chains = [];
    let currentChain = [buoys[0]];
    const unsorted = buoys.slice(1);

    while (unsorted.length > 0) {
        const lastPoint = currentChain[currentChain.length - 1];
        let closestIdx = 0;
        let minDistance = turf.distance(lastPoint, unsorted[0]);

        for (let i = 1; i < unsorted.length; i++) {
            const dist = turf.distance(lastPoint, unsorted[i]);
            if (dist < minDistance) {
                minDistance = dist;
                closestIdx = i;
            }
        }

        if (minDistance > MAX_CHAIN_GAP_KM) {
            if (currentChain.length >= 2) chains.push(currentChain);
            currentChain = [unsorted[closestIdx]];
        } else {
            currentChain.push(unsorted[closestIdx]);
        }

        unsorted.splice(closestIdx, 1);
    }

    if (currentChain.length >= 2) chains.push(currentChain);

    console.log(`  ${sideName}: ${chains.length} chains (${chains.map(c => c.length + ' marks').join(', ')})`);
    return chains;
}

// ── Build Virtual Walls ─────────────────────────────────────────
console.log('\nBuilding virtual channel walls...');

const portChains = sortBuoysToChains(portBuoys, 'Port');
const starboardChains = sortBuoysToChains(starboardBuoys, 'Starboard');

const allFeatures = [...otherObstacles];

for (let i = 0; i < portChains.length; i++) {
    const coords = portChains[i].map(b => b.geometry.coordinates);
    allFeatures.push(turf.lineString(coords, {
        name: `Port Wall ${i + 1}`, side: 'port',
        marks: portChains[i].length, type: 'virtual_channel_wall',
    }));
}

for (let i = 0; i < starboardChains.length; i++) {
    const coords = starboardChains[i].map(b => b.geometry.coordinates);
    allFeatures.push(turf.lineString(coords, {
        name: `Starboard Wall ${i + 1}`, side: 'starboard',
        marks: starboardChains[i].length, type: 'virtual_channel_wall',
    }));
}

// ── Load danger polygons if available ───────────────────────────
if (fs.existsSync(COASTLINE_FILE)) {
    console.log(`\nLoading danger polygons: ${COASTLINE_FILE}`);
    const dangerData = JSON.parse(fs.readFileSync(COASTLINE_FILE, 'utf8'));
    console.log(`  Danger polygons (<3m): ${dangerData.features?.length || 0}`);
    if (dangerData.features) {
        for (const f of dangerData.features) {
            f.properties = f.properties || {};
            f.properties.type = 'shallow_water';
            allFeatures.push(f);
        }
    }
}

// ── Output ──────────────────────────────────────────────────────
const output = turf.featureCollection(allFeatures);
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
const sizeMB = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1);

console.log(`\n✓ Saved: ${OUTPUT_FILE}`);
console.log(`  Features: ${allFeatures.length}`);
console.log(`  Size: ${sizeMB} MB`);
console.log(`  Port walls: ${portChains.length}`);
console.log(`  Starboard walls: ${starboardChains.length}`);
