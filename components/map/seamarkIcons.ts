/**
 * seamarkIcons.ts — IALA Maritime Buoyage System icon definitions.
 *
 * Generates SVG icon images for Mapbox GL JS `map.addImage()`.
 * Region A (IALA A): Port = Red (Can), Starboard = Green (Cone)
 * Used in Australia, NZ, Europe, Africa, most of Asia.
 */
import mapboxgl from 'mapbox-gl';

import { ENC_HAZARD_MAGENTA } from './encDepthStyle';

// ── Colour palette ───────────────────────────────────────────────────────────

const COLOURS = {
    red: '#E53E3E',
    green: '#38A169',
    yellow: '#ECC94B',
    black: '#1A202C',
    white: '#F7FAFC',
    orange: '#ED8936',
    blue: '#3182CE',
    // IHO hazard magenta — the ONE source of truth for hazard-symbol fill AND
    // popup/legend accents. Was a local #D53F8C literal while popups used
    // ENC_HAZARD_MAGENTA #d837a9, so the on-chart glyph and its popup drew two
    // different magentas — the exact drift the single-source constant claims to
    // have closed (closing audit 2026-07-18). Now they are one value.
    magenta: ENC_HAZARD_MAGENTA,
    teal: '#319795',
    grey: '#718096',
    amber: '#D69E2E',
} as const;

/** S-52 day-mode hue for a WHITE light flare — a warm yellow-white, NOT
 *  COLOURS.white: a true-white star vanishes over the pale deep-water band
 *  (DEPARE b20to50 #ecf4fa / b50plus #ffffff). Matches the exact hex
 *  LIGHT_COLOUR_HEX['1'] bakes into `_lightColor` in services/enc/types.ts,
 *  so the icon's colour IS its semantic colour (closing audit 2026-07-18:
 *  the white light rendered near-white and washed out in daylight). */
const LIGHT_WHITE_FLARE = '#f0e030';

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
    // Topmark takes the buoy colour explicitly. `currentColor` resolves to
    // the CSS `color` cascade — which is ABSENT when the SVG is rasterised
    // through a detached data-URI <img>, so it fell back to initial BLACK on
    // the most common navaid (mission audit fix: bake the resolved fill in).
    const top =
        shape === 'can'
            ? `<rect x="12" y="8" width="24" height="4" rx="1" fill="${colour}"/>`
            : `<polygon points="24,6 12,12 36,12" fill="${colour}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <g filter="url(#s)" fill="${colour}" stroke="${COLOURS.white}" stroke-width="1.5">
            ${top}
            <rect x="14" y="12" width="20" height="22" rx="3"/>
            <line x1="24" y1="34" x2="24" y2="42" stroke="${colour}" stroke-width="3"/>
        </g>
    </svg>`;
}

/** Preferred-channel lateral (CATLAM 3/4): main colour with a single
 *  contrasting band — the banding IS the "junction here" signal the audit
 *  said we dropped. Same topmark/hull grammar as lateralBuoySvg. */
function preferredChannelBuoySvg(main: string, band: string, shape: 'can' | 'cone'): string {
    const top =
        shape === 'can'
            ? `<rect x="12" y="8" width="24" height="4" rx="1" fill="${main}"/>`
            : `<polygon points="24,6 12,12 36,12" fill="${main}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <g filter="url(#s)" stroke="${COLOURS.white}" stroke-width="1.5">
            ${top}
            <rect x="14" y="12" width="20" height="22" rx="3" fill="${main}"/>
            <rect x="14" y="19" width="20" height="8" fill="${band}" stroke="none"/>
            <rect x="14" y="12" width="20" height="22" rx="3" fill="none"/>
            <line x1="24" y1="34" x2="24" y2="42" stroke="${main}" stroke-width="3"/>
        </g>
    </svg>`;
}

/** Preferred-channel BEACON (CATLAM 3/4): banded post + topmark (audit:
 *  the buoys got banding, beacons silently kept the plain hand glyph). */
function preferredChannelBeaconSvg(main: string, band: string, shape: 'can' | 'cone'): string {
    const top =
        shape === 'can'
            ? `<rect x="16" y="6" width="16" height="5" rx="1" fill="${main}"/>`
            : `<polygon points="24,4 16,11 32,11" fill="${main}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <g filter="url(#s)" stroke="${COLOURS.white}" stroke-width="1.5">
            ${top}
            <rect x="20" y="12" width="8" height="26" rx="1.5" fill="${main}"/>
            <rect x="20" y="20" width="8" height="9" fill="${band}" stroke="none"/>
            <rect x="20" y="12" width="8" height="26" rx="1.5" fill="none"/>
            <rect x="14" y="38" width="20" height="4" rx="1" fill="${main}"/>
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
            <!-- INT1: TWO BLACK SPHERES, VERTICAL (audit: side-by-side read
                 as a different topmark at a glance) -->
            <circle cx="24" cy="4" r="2.6" fill="${COLOURS.black}" stroke="${COLOURS.white}" stroke-width="1"/>
            <circle cx="24" cy="10" r="2.6" fill="${COLOURS.black}" stroke="${COLOURS.white}" stroke-width="1"/>
            <rect x="14" y="14" width="20" height="7" rx="1" fill="${COLOURS.black}" stroke="${COLOURS.white}" stroke-width="1"/>
            <rect x="14" y="21" width="20" height="7" rx="0" fill="${COLOURS.red}" stroke="${COLOURS.white}" stroke-width="1"/>
            <rect x="14" y="28" width="20" height="7" rx="1" fill="${COLOURS.black}" stroke="${COLOURS.white}" stroke-width="1"/>
            <line x1="24" y1="35" x2="24" y2="43" stroke="${COLOURS.black}" stroke-width="3"/>
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

/** Beacon — Fixed marker (triangle/cone on a stick). IALA shape
 *  convention: the CONE is the STARBOARD-hand topmark. */
function beaconSvg(colour: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <g filter="url(#s)">
            <polygon points="24,8 14,28 34,28" fill="${colour}" stroke="${COLOURS.white}" stroke-width="1.5"/>
            <line x1="24" y1="28" x2="24" y2="42" stroke="${COLOURS.grey}" stroke-width="3"/>
        </g>
    </svg>`;
}

/** Port-hand beacon — CAN (square) topmark on a stick. The shape
 *  channel is the redundancy colour-blind mariners rely on; drawing
 *  the starboard triangle on BOTH hands contradicted the colours
 *  (2026-07-12 audit — a red-green colour-blind user saw identical
 *  triangles both sides of the channel). */
function beaconCanSvg(colour: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <g filter="url(#s)">
            <rect x="15" y="10" width="18" height="18" rx="1" fill="${colour}" stroke="${COLOURS.white}" stroke-width="1.5"/>
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
/** CATWRK 4 — wreck showing mast/funnel: dangerous hull + mast stroke. */
function wreckMastSvg(): string {
    return hazardDiscSvg(`<g stroke="${COLOURS.magenta}" stroke-width="2.5" stroke-linecap="round">
        <path d="M14 30 L34 30 L31 24 L17 24 Z" fill="${COLOURS.magenta}"/>
        <line x1="24" y1="24" x2="24" y2="13"/><line x1="21" y1="16" x2="27" y2="16"/></g>`);
}

/** CATWRK 5 — wreck showing hull: hull outline awash. */
function wreckHullSvg(): string {
    return hazardDiscSvg(`<g stroke="${COLOURS.magenta}" stroke-width="2.5" stroke-linecap="round" fill="none">
        <path d="M13 28 L35 28 L31 21 L17 21 Z"/>
        <line x1="11" y1="31" x2="37" y2="31" stroke-dasharray="3 2.5"/></g>`);
}

/** Unknown-attribute mark (audit #8): a mark whose CATLAM/CATCAM is
 *  missing must assert PRESENCE, never a specific passing rule — the old
 *  fallbacks painted a north cardinal ("pass north" the data never said)
 *  or a port-hand can. Grey disc + ? = "there is a mark here, identify
 *  it visually". */
function unknownMarkSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>
        <circle cx="24" cy="24" r="11" fill="${COLOURS.grey}" stroke="${COLOURS.white}" stroke-width="2" filter="url(#s)"/>
        <text x="24" y="30" text-anchor="middle" font-family="system-ui" font-size="17" font-weight="700" fill="${COLOURS.white}">?</text>
    </svg>`;
}

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
// ── INT1 hazard glyphs (K-section) ──────────────────────────────────────────
// Wreck / rock / obstruction drawn as the paper-chart symbols a mariner
// already reads, magenta like all IHO danger symbology, on a soft white disc
// so they hold up on chart white AND satellite imagery (burn-down: hazard
// points rendered as generic circles with no CATWRK/WATLEV differentiation).

function hazardDiscSvg(inner: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="16" fill="#ffffff" fill-opacity="0.75"/>
        ${inner}
    </svg>`;
}

/** INT1 K13 — submerged rock: the + cross. */
function rockSubmergedSvg(): string {
    return hazardDiscSvg(`<g stroke="${COLOURS.magenta}" stroke-width="3.5" stroke-linecap="round">
        <line x1="24" y1="12" x2="24" y2="36"/><line x1="12" y1="24" x2="36" y2="24"/></g>`);
}

/** INT1 K11 — rock which covers and uncovers (drying rock, WATLEV 4): the
 *  `*` asterisk. Renamed from the misleading "-awash" (awash is WATLEV 5, the
 *  dotted cross below) so the id can't read as a transpose (cycle-5 audit #7). */
function rockDryingSvg(): string {
    return hazardDiscSvg(`<g stroke="${COLOURS.magenta}" stroke-width="3" stroke-linecap="round">
        <line x1="24" y1="11" x2="24" y2="37"/><line x1="11" y1="24" x2="37" y2="24"/>
        <line x1="15" y1="15" x2="33" y2="33"/><line x1="33" y1="15" x2="15" y2="33"/></g>`);
}

/** INT1 K12 — rock AWASH at chart datum (WATLEV 5): the + cross with a dot in
 *  each quadrant, distinct from the K11 covers-and-uncovers asterisk above. */
function rockAwashCdSvg(): string {
    return hazardDiscSvg(`<g stroke="${COLOURS.magenta}" stroke-width="3.5" stroke-linecap="round">
        <line x1="24" y1="11" x2="24" y2="37"/><line x1="11" y1="24" x2="37" y2="24"/></g>
        <g fill="${COLOURS.magenta}">
        <circle cx="17" cy="17" r="2"/><circle cx="31" cy="17" r="2"/>
        <circle cx="17" cy="31" r="2"/><circle cx="31" cy="31" r="2"/></g>`);
}

/** INT1 K31-style foul ground (CATOBS 7): hash — not dangerous to
 *  surface navigation but foul for anchoring/fishing gear. */
function foulGroundSvg(): string {
    return hazardDiscSvg(`<g stroke="${COLOURS.magenta}" stroke-width="2.5" stroke-linecap="round">
        <line x1="19" y1="12" x2="15" y2="36"/><line x1="33" y1="12" x2="29" y2="36"/>
        <line x1="12" y1="19" x2="36" y2="19"/><line x1="12" y1="29" x2="36" y2="29"/></g>`);
}

/** INT1 K28/K29-style wreck: hull + masts. Dangerous = FILLED hull;
 *  non-dangerous (CATWRK 1) = outline only. */
function wreckSvg(dangerous: boolean): string {
    const fill = dangerous ? COLOURS.magenta : 'none';
    return hazardDiscSvg(`<g stroke="${COLOURS.magenta}" stroke-width="2.5" fill="${fill}" stroke-linecap="round">
        <path d="M12 28 Q24 36 36 28 L33 24 L15 24 Z"/>
        <line x1="18" y1="24" x2="18" y2="15"/><line x1="24" y1="24" x2="24" y2="12"/><line x1="30" y1="24" x2="30" y2="15"/></g>`);
}

/** Obstruction / foul ground: dashed circle + centre dot. */
function obstructionSvg(): string {
    return hazardDiscSvg(`<circle cx="24" cy="24" r="11" fill="none" stroke="${COLOURS.magenta}" stroke-width="2.5" stroke-dasharray="4 3"/>
        <circle cx="24" cy="24" r="2.5" fill="${COLOURS.magenta}"/>`);
}

export function getSeamarkIconDefs(): SeamarkIconDef[] {
    return [
        // Lateral buoys (Region A — IALA A)
        { id: 'sm-buoy-port', svg: lateralBuoySvg(COLOURS.red, 'can'), size: 48 },
        { id: 'sm-buoy-starboard', svg: lateralBuoySvg(COLOURS.green, 'cone'), size: 48 },
        { id: 'sm-buoy-lateral', svg: lateralBuoySvg(COLOURS.red, 'can'), size: 48 }, // default

        // Lateral buoys (Region B — colours swap, hull shapes stay:
        // port keeps the can, starboard keeps the cone). Used by the
        // ENC vector layer's `_icon` pre-bake for IALA-B cells.
        { id: 'sm-buoy-port-b', svg: lateralBuoySvg(COLOURS.green, 'can'), size: 48 },
        { id: 'sm-buoy-starboard-b', svg: lateralBuoySvg(COLOURS.red, 'cone'), size: 48 },

        // Preferred-channel laterals (CATLAM 3/4) — region A: 3 = red
        // w/ green band (pass as port-hand for the preferred channel),
        // 4 = green w/ red band; region B swaps the colours.
        { id: 'sm-buoy-prefchan-stbd', svg: preferredChannelBuoySvg(COLOURS.red, COLOURS.green, 'can'), size: 48 },
        { id: 'sm-buoy-prefchan-port', svg: preferredChannelBuoySvg(COLOURS.green, COLOURS.red, 'cone'), size: 48 },
        { id: 'sm-buoy-prefchan-stbd-b', svg: preferredChannelBuoySvg(COLOURS.green, COLOURS.red, 'can'), size: 48 },
        { id: 'sm-buoy-prefchan-port-b', svg: preferredChannelBuoySvg(COLOURS.red, COLOURS.green, 'cone'), size: 48 },
        { id: 'sm-beacon-prefchan-stbd', svg: preferredChannelBeaconSvg(COLOURS.red, COLOURS.green, 'can'), size: 48 },
        { id: 'sm-beacon-prefchan-port', svg: preferredChannelBeaconSvg(COLOURS.green, COLOURS.red, 'cone'), size: 48 },
        {
            id: 'sm-beacon-prefchan-stbd-b',
            svg: preferredChannelBeaconSvg(COLOURS.green, COLOURS.red, 'can'),
            size: 48,
        },
        {
            id: 'sm-beacon-prefchan-port-b',
            svg: preferredChannelBeaconSvg(COLOURS.red, COLOURS.green, 'cone'),
            size: 48,
        },

        // Cardinal buoys
        { id: 'sm-cardinal-north', svg: cardinalBuoySvg('north'), size: 48 },
        { id: 'sm-cardinal-south', svg: cardinalBuoySvg('south'), size: 48 },
        { id: 'sm-cardinal-east', svg: cardinalBuoySvg('east'), size: 48 },
        { id: 'sm-cardinal-west', svg: cardinalBuoySvg('west'), size: 48 },

        // Special marks
        { id: 'sm-safe-water', svg: safeWaterSvg(), size: 48 },
        { id: 'sm-isolated-danger', svg: isolatedDangerSvg(), size: 48 },
        { id: 'sm-special', svg: specialMarkSvg(), size: 48 },

        // INT1 hazard glyphs (K-section) — see hazardDiscSvg block above.
        { id: 'sm-hazard-rock', svg: rockSubmergedSvg(), size: 48 },
        { id: 'sm-hazard-rock-drying', svg: rockDryingSvg(), size: 48 },
        { id: 'sm-hazard-rock-awash-cd', svg: rockAwashCdSvg(), size: 48 },
        { id: 'sm-hazard-foul', svg: foulGroundSvg(), size: 48 },
        { id: 'sm-hazard-wreck-dangerous', svg: wreckSvg(true), size: 48 },
        { id: 'sm-hazard-wreck', svg: wreckSvg(false), size: 48 },
        { id: 'sm-hazard-wreck-mast', svg: wreckMastSvg(), size: 48 },
        { id: 'sm-hazard-wreck-hull', svg: wreckHullSvg(), size: 48 },
        { id: 'sm-hazard-obstruction', svg: obstructionSvg(), size: 48 },

        // Lights
        { id: 'sm-light-major', svg: lightSvg(COLOURS.yellow, true), size: 48 },
        { id: 'sm-light-minor', svg: lightSvg(COLOURS.amber, false), size: 48 },
        { id: 'sm-light-red', svg: lightSvg(COLOURS.red, false), size: 48 },
        { id: 'sm-light-green', svg: lightSvg(COLOURS.green, false), size: 48 },
        { id: 'sm-light-white', svg: lightSvg(LIGHT_WHITE_FLARE, false), size: 48 },

        // Beacons — cone (triangle) = starboard-hand topmark, can
        // (square) = port-hand topmark. Colour swaps by IALA region;
        // the SHAPE always disambiguates the hand.
        { id: 'sm-beacon-red', svg: beaconSvg(COLOURS.red), size: 48 },
        { id: 'sm-beacon-green', svg: beaconSvg(COLOURS.green), size: 48 },
        { id: 'sm-beacon-yellow', svg: beaconSvg(COLOURS.yellow), size: 48 },
        { id: 'sm-beacon-can-red', svg: beaconCanSvg(COLOURS.red), size: 48 },
        { id: 'sm-beacon-can-green', svg: beaconCanSvg(COLOURS.green), size: 48 },

        // Infrastructure
        { id: 'sm-anchorage', svg: anchorageSvg(), size: 48 },

        // Generic/fallback
        { id: 'sm-mark-unknown', svg: unknownMarkSvg(), size: 48 },
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

/**
 * Rasterise an SVG icon at the device pixel ratio. Feeding the raw
 * 48-px <img> to addImage stored a @1x bitmap that the GPU upscaled
 * ~2-3× on retina — visibly soft cone/can edges next to Mapbox's
 * crisp basemap glyphs, the single most "non-chartplotter" tell on
 * the mark layer (2026-07-12 audit). SVG is vector: drawing it onto
 * a dpr-sized canvas rasterises at full destination resolution.
 */
async function svgToImageData(svgString: string, size: number, pixelRatio: number): Promise<ImageData> {
    const img = await svgToImage(svgString, size);
    const px = Math.round(size * pixelRatio);
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    ctx.drawImage(img, 0, 0, px, px);
    return ctx.getImageData(0, 0, px, px);
}

/** Register all seamark icons on a Mapbox GL map instance */
export async function registerSeamarkIcons(map: mapboxgl.Map): Promise<void> {
    const defs = getSeamarkIconDefs();
    const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);

    for (const def of defs) {
        if (map.hasImage(def.id)) continue;
        try {
            const data = await svgToImageData(def.svg, def.size, ratio);
            map.addImage(def.id, data, { sdf: false, pixelRatio: ratio });
        } catch (err) {
            console.warn(`Failed to register seamark icon ${def.id}:`, err);
        }
    }
}

/** UWTROC WATLEV → rock glyph, INT1 K-section — the single source of truth for
 *  the hazard layer's icon match (cycle-5 audit #7 re-flagged a transpose that
 *  wasn't there; locking the mapping in one tested place stops the re-flag).
 *  WATLEV 4 = covers & uncovers (drying rock, K11 asterisk); 5 = awash at chart
 *  datum (K12 dotted cross); anything else / submerged = K13 plain cross. */
export const UWTROC_ROCK_GLYPH: ReadonlyArray<readonly [watlev: string, iconId: string]> = [
    ['4', 'sm-hazard-rock-drying'],
    ['5', 'sm-hazard-rock-awash-cd'],
];
export const UWTROC_ROCK_GLYPH_DEFAULT = 'sm-hazard-rock';

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
        return 'sm-mark-unknown';
    }

    // Cardinal buoys
    if (seamarkType === 'buoy_cardinal') {
        const cat = tags['buoy_cardinal:category'] || '';
        if (cat === 'north') return 'sm-cardinal-north';
        if (cat === 'south') return 'sm-cardinal-south';
        if (cat === 'east') return 'sm-cardinal-east';
        if (cat === 'west') return 'sm-cardinal-west';
        return 'sm-mark-unknown'; // unknown quadrant — never assert one
    }

    // Other buoy types
    if (seamarkType === 'buoy_safe_water') return 'sm-safe-water';
    if (seamarkType === 'buoy_isolated_danger') return 'sm-isolated-danger';
    if (seamarkType === 'buoy_special_purpose' || seamarkType === 'buoy_installation') return 'sm-special';

    // Lateral beacons — the HAND (port = can topmark, starboard = cone topmark)
    // is the primary channel, not colour (cycle-5 audit #6: the old colour-only
    // branch drew every port-hand beacon as a starboard cone, contradicting the
    // shape). Mirrors the buoy_lateral branch; colour picks the correct can/cone
    // so both IALA regions work without a region argument (the OSM :colour is the
    // painted colour). NOTE: the primary ENC navaid path (encNavaidIconId) is
    // already correct — this only fixes the OSM free-basemap overlay fallback.
    if (seamarkType === 'beacon_lateral') {
        const cat = tags['beacon_lateral:category'] || '';
        const colour = tags['beacon_lateral:colour'] || '';
        if (cat === 'port') return colour.includes('green') ? 'sm-beacon-can-green' : 'sm-beacon-can-red';
        if (cat === 'starboard') return colour.includes('red') ? 'sm-beacon-red' : 'sm-beacon-green';
        if (cat === 'preferred_channel_port') return 'sm-beacon-prefchan-port';
        if (cat === 'preferred_channel_starboard') return 'sm-beacon-prefchan-stbd';
        // No category — fall back to colour → can for red, cone for green
        // (IALA-A default); an unknown colour never asserts a hand.
        if (colour.includes('red')) return 'sm-beacon-can-red';
        if (colour.includes('green')) return 'sm-beacon-green';
        return 'sm-mark-unknown';
    }

    // Other beacons (cardinal / safe-water / isolated-danger / special) — the
    // cone glyph is not a lateral-hand assertion here, so colour/type routing is
    // adequate.
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
