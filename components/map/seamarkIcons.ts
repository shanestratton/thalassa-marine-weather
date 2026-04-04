/**
 * seamarkIcons.ts — IALA Maritime Buoyage System icon definitions.
 *
 * Generates SVG icon images for Mapbox GL JS `map.addImage()`.
 * Region A (IALA A): Port = Red (Can), Starboard = Green (Cone)
 * Used in Australia, NZ, Europe, Africa, most of Asia.
 */
import mapboxgl from 'mapbox-gl';

// ── Colour palette ───────────────────────────────────────────────────────────

const COLOURS = {
    red: '#E53E3E',
    green: '#38A169',
    yellow: '#ECC94B',
    black: '#1A202C',
    white: '#F7FAFC',
    orange: '#ED8936',
    blue: '#3182CE',
    magenta: '#D53F8C',
    teal: '#319795',
    grey: '#718096',
    amber: '#D69E2E',
} as const;

// ── SVG builders ─────────────────────────────────────────────────────────────

function svgToImage(svgString: string, size: number): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image(size, size);
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
    });
}

/** Lateral buoy — Can (flat top) for port, Conical (pointed) for starboard */
function lateralBuoySvg(colour: string, shape: 'can' | 'cone'): string {
    const top =
        shape === 'can'
            ? '<rect x="12" y="8" width="24" height="4" rx="1" fill="currentColor"/>'
            : '<polygon points="24,6 12,12 36,12" fill="currentColor"/>';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <g filter="url(#s)" fill="${colour}" stroke="${COLOURS.white}" stroke-width="1.5">
            ${top}
            <rect x="14" y="12" width="20" height="22" rx="3"/>
            <line x1="24" y1="34" x2="24" y2="42" stroke="${colour}" stroke-width="3"/>
        </g>
    </svg>`;
}

/** Cardinal buoy — Yellow/Black horizontal bands with cone topmarks */
function cardinalBuoySvg(direction: 'north' | 'south' | 'east' | 'west'): string {
    // Band patterns: N=BY, S=YB, E=BYB, W=YBY (top to bottom)
    const patterns: Record<string, [string, string, string]> = {
        north: [COLOURS.black, COLOURS.yellow, COLOURS.yellow],
        south: [COLOURS.yellow, COLOURS.black, COLOURS.black],
        east: [COLOURS.black, COLOURS.yellow, COLOURS.black],
        west: [COLOURS.yellow, COLOURS.black, COLOURS.yellow],
    };
    // Topmarks: N=▲▲, S=▼▼, E=▲▼, W=▼▲
    const topmarks: Record<string, string> = {
        north: `<polygon points="20,3 24,0 28,3" fill="${COLOURS.black}"/><polygon points="20,7 24,4 28,7" fill="${COLOURS.black}"/>`,
        south: `<polygon points="20,0 24,3 28,0" fill="${COLOURS.black}"/><polygon points="20,4 24,7 28,4" fill="${COLOURS.black}"/>`,
        east: `<polygon points="20,3 24,0 28,3" fill="${COLOURS.black}"/><polygon points="20,4 24,7 28,4" fill="${COLOURS.black}"/>`,
        west: `<polygon points="20,0 24,3 28,0" fill="${COLOURS.black}"/><polygon points="20,7 24,4 28,7" fill="${COLOURS.black}"/>`,
    };
    const [c1, c2, c3] = patterns[direction];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <g filter="url(#s)">
            ${topmarks[direction]}
            <rect x="14" y="10" width="20" height="8" rx="1" fill="${c1}" stroke="${COLOURS.white}" stroke-width="1"/>
            <rect x="14" y="18" width="20" height="8" rx="0" fill="${c2}" stroke="${COLOURS.white}" stroke-width="1"/>
            <rect x="14" y="26" width="20" height="8" rx="1" fill="${c3}" stroke="${COLOURS.white}" stroke-width="1"/>
            <line x1="24" y1="34" x2="24" y2="42" stroke="${COLOURS.black}" stroke-width="3"/>
        </g>
    </svg>`;
}

/** Safe water mark — Red/White vertical stripes + red sphere */
function safeWaterSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs>
            <filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter>
            <pattern id="vstripes" width="6" height="1" patternUnits="userSpaceOnUse">
                <rect width="3" height="1" fill="${COLOURS.red}"/><rect x="3" width="3" height="1" fill="${COLOURS.white}"/>
            </pattern>
        </defs>
        <g filter="url(#s)">
            <circle cx="24" cy="8" r="4" fill="${COLOURS.red}" stroke="${COLOURS.white}" stroke-width="1"/>
            <rect x="14" y="12" width="20" height="22" rx="10" fill="url(#vstripes)" stroke="${COLOURS.white}" stroke-width="1.5"/>
            <line x1="24" y1="34" x2="24" y2="42" stroke="${COLOURS.red}" stroke-width="3"/>
        </g>
    </svg>`;
}

/** Isolated danger — Black with red band + 2 spheres */
function isolatedDangerSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <g filter="url(#s)">
            <circle cx="21" cy="6" r="3" fill="${COLOURS.black}" stroke="${COLOURS.white}" stroke-width="1"/>
            <circle cx="27" cy="6" r="3" fill="${COLOURS.black}" stroke="${COLOURS.white}" stroke-width="1"/>
            <rect x="14" y="10" width="20" height="8" rx="1" fill="${COLOURS.black}" stroke="${COLOURS.white}" stroke-width="1"/>
            <rect x="14" y="18" width="20" height="8" rx="0" fill="${COLOURS.red}" stroke="${COLOURS.white}" stroke-width="1"/>
            <rect x="14" y="26" width="20" height="8" rx="1" fill="${COLOURS.black}" stroke="${COLOURS.white}" stroke-width="1"/>
            <line x1="24" y1="34" x2="24" y2="42" stroke="${COLOURS.black}" stroke-width="3"/>
        </g>
    </svg>`;
}

/** Special mark — Yellow with X topmark */
function specialMarkSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <g filter="url(#s)">
            <line x1="19" y1="3" x2="29" y2="9" stroke="${COLOURS.yellow}" stroke-width="2.5"/>
            <line x1="29" y1="3" x2="19" y2="9" stroke="${COLOURS.yellow}" stroke-width="2.5"/>
            <rect x="14" y="12" width="20" height="22" rx="3" fill="${COLOURS.yellow}" stroke="${COLOURS.white}" stroke-width="1.5"/>
            <line x1="24" y1="34" x2="24" y2="42" stroke="${COLOURS.yellow}" stroke-width="3"/>
        </g>
    </svg>`;
}

/** Light — Star/burst symbol */
function lightSvg(colour: string, major: boolean): string {
    const size = major ? 20 : 14;
    const cx = 24,
        cy = 24;
    const rays = major ? 8 : 6;
    let pathD = '';
    for (let i = 0; i < rays; i++) {
        const angle = (i * 360) / rays - 90;
        const outerR = size / 2;
        const innerR = size / 4;
        const a1 = (angle * Math.PI) / 180;
        const a2 = ((angle + 360 / rays / 2) * Math.PI) / 180;
        pathD += `${i === 0 ? 'M' : 'L'}${cx + Math.cos(a1) * outerR},${cy + Math.sin(a1) * outerR}`;
        pathD += `L${cx + Math.cos(a2) * innerR},${cy + Math.sin(a2) * innerR}`;
    }
    pathD += 'Z';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="g"><feGaussianBlur stdDeviation="2"/></filter>
        <filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <circle cx="${cx}" cy="${cy}" r="${size / 2 + 4}" fill="${colour}" opacity="0.25" filter="url(#g)"/>
        <path d="${pathD}" fill="${colour}" stroke="${COLOURS.white}" stroke-width="1" filter="url(#s)"/>
        <circle cx="${cx}" cy="${cy}" r="${major ? 4 : 3}" fill="${COLOURS.white}"/>
    </svg>`;
}

/** Beacon — Fixed marker (triangle on a stick) */
function beaconSvg(colour: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <g filter="url(#s)">
            <polygon points="24,8 14,28 34,28" fill="${colour}" stroke="${COLOURS.white}" stroke-width="1.5"/>
            <line x1="24" y1="28" x2="24" y2="42" stroke="${COLOURS.grey}" stroke-width="3"/>
        </g>
    </svg>`;
}

/** Anchorage — Anchor symbol */
function anchorageSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <g filter="url(#s)" fill="none" stroke="${COLOURS.blue}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="24" cy="12" r="4"/>
            <line x1="24" y1="16" x2="24" y2="38"/>
            <path d="M14,34 C14,28 24,24 24,38 C24,24 34,28 34,34"/>
            <line x1="16" y1="22" x2="32" y2="22"/>
        </g>
    </svg>`;
}

/** Generic/unknown seamark — Simple circle marker */
function genericSvg(colour: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <circle cx="24" cy="24" r="10" fill="${colour}" stroke="${COLOURS.white}" stroke-width="2" filter="url(#s)" opacity="0.9"/>
    </svg>`;
}

// ── Icon registry ────────────────────────────────────────────────────────────

export interface SeamarkIconDef {
    id: string;
    svg: string;
    size: number;
}

/** All icon definitions, keyed by seamark:type value */
export function getSeamarkIconDefs(): SeamarkIconDef[] {
    return [
        // Lateral buoys (Region A — IALA A)
        { id: 'sm-buoy-port', svg: lateralBuoySvg(COLOURS.red, 'can'), size: 48 },
        { id: 'sm-buoy-starboard', svg: lateralBuoySvg(COLOURS.green, 'cone'), size: 48 },
        { id: 'sm-buoy-lateral', svg: lateralBuoySvg(COLOURS.red, 'can'), size: 48 }, // default

        // Cardinal buoys
        { id: 'sm-cardinal-north', svg: cardinalBuoySvg('north'), size: 48 },
        { id: 'sm-cardinal-south', svg: cardinalBuoySvg('south'), size: 48 },
        { id: 'sm-cardinal-east', svg: cardinalBuoySvg('east'), size: 48 },
        { id: 'sm-cardinal-west', svg: cardinalBuoySvg('west'), size: 48 },

        // Special marks
        { id: 'sm-safe-water', svg: safeWaterSvg(), size: 48 },
        { id: 'sm-isolated-danger', svg: isolatedDangerSvg(), size: 48 },
        { id: 'sm-special', svg: specialMarkSvg(), size: 48 },

        // Lights
        { id: 'sm-light-major', svg: lightSvg(COLOURS.yellow, true), size: 48 },
        { id: 'sm-light-minor', svg: lightSvg(COLOURS.amber, false), size: 48 },
        { id: 'sm-light-red', svg: lightSvg(COLOURS.red, false), size: 48 },
        { id: 'sm-light-green', svg: lightSvg(COLOURS.green, false), size: 48 },
        { id: 'sm-light-white', svg: lightSvg(COLOURS.white, false), size: 48 },

        // Beacons
        { id: 'sm-beacon-red', svg: beaconSvg(COLOURS.red), size: 48 },
        { id: 'sm-beacon-green', svg: beaconSvg(COLOURS.green), size: 48 },
        { id: 'sm-beacon-yellow', svg: beaconSvg(COLOURS.yellow), size: 48 },

        // Infrastructure
        { id: 'sm-anchorage', svg: anchorageSvg(), size: 48 },

        // Generic/fallback
        { id: 'sm-harbour', svg: genericSvg(COLOURS.blue), size: 48 },
        { id: 'sm-mooring', svg: genericSvg(COLOURS.teal), size: 48 },
        { id: 'sm-restricted', svg: genericSvg(COLOURS.red), size: 48 },
        { id: 'sm-cable', svg: genericSvg(COLOURS.magenta), size: 48 },
        { id: 'sm-pipeline', svg: genericSvg(COLOURS.orange), size: 48 },
        { id: 'sm-fairway', svg: genericSvg(COLOURS.green), size: 48 },
        { id: 'sm-pilot', svg: genericSvg(COLOURS.blue), size: 48 },
        { id: 'sm-signal', svg: genericSvg(COLOURS.orange), size: 48 },
        { id: 'sm-coastguard', svg: genericSvg(COLOURS.blue), size: 48 },
        { id: 'sm-rescue', svg: genericSvg(COLOURS.red), size: 48 },
        { id: 'sm-generic', svg: genericSvg(COLOURS.grey), size: 48 },
    ];
}

/** Register all seamark icons on a Mapbox GL map instance */
export async function registerSeamarkIcons(map: mapboxgl.Map): Promise<void> {
    const defs = getSeamarkIconDefs();

    for (const def of defs) {
        if (map.hasImage(def.id)) continue;
        try {
            const img = await svgToImage(def.svg, def.size);
            map.addImage(def.id, img, { sdf: false });
        } catch (err) {
            console.warn(`Failed to register seamark icon ${def.id}:`, err);
        }
    }
}

/** Resolve a seamark feature to its icon ID */
export function resolveSeamarkIcon(seamarkType: string, tags: Record<string, string>): string {
    // Lateral buoys — determine port/starboard from category
    if (seamarkType === 'buoy_lateral') {
        const cat = tags['buoy_lateral:category'] || '';
        if (cat === 'starboard') return 'sm-buoy-starboard';
        if (cat === 'port') return 'sm-buoy-port';
        // Fallback: check colour
        const colour = tags['buoy_lateral:colour'] || '';
        if (colour.includes('green')) return 'sm-buoy-starboard';
        if (colour.includes('red')) return 'sm-buoy-port';
        return 'sm-buoy-lateral';
    }

    // Cardinal buoys
    if (seamarkType === 'buoy_cardinal') {
        const cat = tags['buoy_cardinal:category'] || '';
        if (cat === 'north') return 'sm-cardinal-north';
        if (cat === 'south') return 'sm-cardinal-south';
        if (cat === 'east') return 'sm-cardinal-east';
        if (cat === 'west') return 'sm-cardinal-west';
        return 'sm-cardinal-north'; // fallback
    }

    // Other buoy types
    if (seamarkType === 'buoy_safe_water') return 'sm-safe-water';
    if (seamarkType === 'buoy_isolated_danger') return 'sm-isolated-danger';
    if (seamarkType === 'buoy_special_purpose' || seamarkType === 'buoy_installation') return 'sm-special';

    // Beacons
    if (seamarkType.startsWith('beacon_')) {
        const colour = tags[`${seamarkType}:colour`] || '';
        if (colour.includes('red')) return 'sm-beacon-red';
        if (colour.includes('green')) return 'sm-beacon-green';
        if (colour.includes('yellow')) return 'sm-beacon-yellow';
        return 'sm-beacon-red'; // fallback
    }

    // Lights
    if (seamarkType === 'light_major') return 'sm-light-major';
    if (seamarkType === 'light_minor' || seamarkType === 'light') {
        const col = tags['light:colour'] || tags['light:1:colour'] || '';
        if (col.includes('red')) return 'sm-light-red';
        if (col.includes('green')) return 'sm-light-green';
        if (col.includes('white')) return 'sm-light-white';
        return 'sm-light-minor';
    }
    if (seamarkType === 'light_vessel' || seamarkType === 'light_float') return 'sm-light-major';

    // Infrastructure
    if (seamarkType === 'anchorage' || seamarkType === 'anchor_berth') return 'sm-anchorage';
    if (seamarkType === 'harbour') return 'sm-harbour';
    if (seamarkType === 'mooring') return 'sm-mooring';
    if (seamarkType === 'restricted_area') return 'sm-restricted';
    if (seamarkType === 'cable_submarine') return 'sm-cable';
    if (seamarkType === 'pipeline_submarine') return 'sm-pipeline';
    if (seamarkType === 'fairway' || seamarkType === 'recommended_track') return 'sm-fairway';
    if (seamarkType === 'pilot_boarding') return 'sm-pilot';
    if (seamarkType.includes('signal_station')) return 'sm-signal';
    if (seamarkType === 'coastguard_station') return 'sm-coastguard';
    if (seamarkType === 'rescue_station') return 'sm-rescue';

    return 'sm-generic';
}
