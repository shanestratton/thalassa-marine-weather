/**
 * encPopup — the PURE half of the ENC tap-the-water popup: HTML
 * escaping, depth formatters, S-57 code→label tables and
 * buildFeaturePopupHtml. Extracted from EncVectorLayer (2026-07-12
 * audit: the renderer had swallowed a ~540-line popup subsystem).
 * Everything here is a pure function of (layerId, props, extras) —
 * the stateful wiring (click handlers, suppression, the async tide
 * window) stays in EncVectorLayer.
 */

import { LITCHR_LABELS } from '../../services/enc/types';
import { ENC_HAZARD_MAGENTA } from './encDepthStyle';
import { ENC_VEC_LAYERS } from './encLayerIds';

/**
 * Escape HTML special chars so feature properties (e.g. `OBJNAM`
 * containing apostrophes) can't break the popup HTML.
 */
function esc(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function fmtDepth(v: unknown, suffix = ' m'): string {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return '—';
    return `${n.toFixed(1)}${suffix}`;
}

/** Depth row for VALSOU-carrying hazards. Negative VALSOU = a drying
 *  height (the feature stands PROUD of the water at datum) — render it
 *  the way the sounding layer does ("Dries 0.3 m"), never as a signed
 *  negative depth ("Depth -0.3 m" reads as a 0.3 m-DEEP rock — the
 *  anti-conservative misread, 2026-07-12 audit). */
function valsouRow(depth: unknown): string {
    const n = typeof depth === 'number' ? depth : Number(depth);
    if (!Number.isFinite(n)) return '';
    if (n < 0) {
        return `<div class="enc-popup-row"><span>Dries</span><b>${esc(`${Math.abs(n).toFixed(1)} m at low tide`)}</b></div>`;
    }
    return `<div class="enc-popup-row"><span>Depth</span><b>${esc(fmtDepth(n))}</b></div>`;
}

function fmtRange(min: unknown, max: unknown): string | null {
    const a = typeof min === 'number' ? min : Number(min);
    const b = typeof max === 'number' ? max : Number(max);
    if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
    if (Number.isFinite(a) && Number.isFinite(b)) return `${a.toFixed(1)}–${b.toFixed(1)} m`;
    if (Number.isFinite(a)) return `${a.toFixed(1)} m+`;
    return `≤${b.toFixed(1)} m`;
}

/**
 * S-57 attribute lookups for the popup. Wreck and obstruction
 * categories are coded ints in the source — we map the most-common
 * ones; unknown codes fall back to the raw value.
 */
const CATWRK_LABELS: Record<string, string> = {
    '1': 'Non-dangerous wreck',
    '2': 'Dangerous wreck',
    '3': 'Distributed remains',
    '4': 'Wreck showing mast/funnel',
    '5': 'Wreck showing hull',
};

const CATOBS_LABELS: Record<string, string> = {
    '1': 'Snag/Stump',
    '2': 'Wellhead',
    '3': 'Diffuser',
    '4': 'Crib',
    '5': 'Fish haven',
    '6': 'Foul area',
    '7': 'Foul ground',
    '8': 'Ice boom',
    '9': 'Ground tackle',
    '10': 'Boom',
};

const WATLEV_LABELS: Record<string, string> = {
    '1': 'Partly submerged at high water',
    '2': 'Always dry',
    '3': 'Always submerged',
    '4': 'Covers and uncovers',
    '5': 'Awash',
    '6': 'Subject to inundation/flooding',
    '7': 'Floating',
};

/** S-57 COLOUR codes → names. "Colour code 3" told the punter nothing
 *  (Shane 2026-07-15 screenshot) — say "red". Comma lists decode
 *  per-code ("3,1" → "red · white"); unknown codes pass through raw. */
const S57_COLOUR_NAMES: Record<string, string> = {
    '1': 'white',
    '2': 'black',
    '3': 'red',
    '4': 'green',
    '5': 'blue',
    '6': 'yellow',
    '7': 'grey',
    '8': 'brown',
    '9': 'amber',
    '10': 'violet',
    '11': 'orange',
    '12': 'magenta',
    '13': 'pink',
};

function colourNames(colour: unknown): string {
    return String(colour)
        .split(',')
        .map((c) => S57_COLOUR_NAMES[c.trim()] ?? c.trim())
        .join(' · ');
}

/** S-57 NATSUR (nature of surface) codes → names — the anchoring read
 *  ("Sand / Mud" holds, "Rock" doesn't). Shared by the caution-area popup
 *  and the DEPARE popup's seabed enrichment (extras.seabed). */
const NATSUR_LABELS: Record<string, string> = {
    '1': 'Mud',
    '2': 'Clay',
    '3': 'Silt',
    '4': 'Sand',
    '5': 'Stone',
    '6': 'Gravel',
    '7': 'Pebbles',
    '8': 'Cobbles',
    '9': 'Rock',
    '11': 'Coral',
    '14': 'Shells',
};

function natsurNames(natsur: unknown): string {
    return String(natsur ?? '')
        .split(',')
        .map((n) => NATSUR_LABELS[n.trim()])
        .filter(Boolean)
        .join(' / ');
}

/** Caution-area class → plain-language label. Shared by the standalone
 *  caution popup and the DEPARE popup's caution fold-in (extras.caution). */
const CAUTION_LABELS: Record<string, string> = {
    RESARE: 'Restricted area',
    CBLARE: 'Submarine cable area',
    PIPARE: 'Pipeline area',
    SBDARE: 'Seabed (nature of bottom)',
    TSSLPT: 'Traffic separation lane',
};

/** S-57 RESTRN (restriction) codes — the values a skipper actually meets. */
const RESTRN_LABELS: Record<string, string> = {
    '1': 'Anchoring prohibited',
    '2': 'Anchoring restricted',
    '3': 'Fishing prohibited',
    '4': 'Fishing restricted',
    '5': 'Trawling prohibited',
    '6': 'Trawling restricted',
    '7': 'Entry prohibited',
    '8': 'Entry restricted',
    '14': 'No wake',
    '27': 'No anchoring / no fishing (cable/pipeline)',
};

function restrnNames(restrn: unknown): string {
    return (
        String(restrn ?? '')
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean)
            // Unmapped codes surface as their raw S-57 code instead of silently
            // vanishing — still look-up-able on a paper chart (burn-down).
            .map((r) => RESTRN_LABELS[r] ?? `restriction code ${r}`)
            .join(' · ')
    );
}

/** The light attribute rows (character / period / height / range /
 *  colour) — shared between the standalone Light popup and the
 *  "Light" section folded into a lit mark's popup. The mark's name
 *  is NOT repeated here; the caller owns name rows. */
function lightRows(props: Record<string, unknown>): string {
    let out = '';
    // Character row: prefer the merge-time pre-baked full description
    // ("Fl(2)G 5s 12m 8M" from buildLightCharacterLabel); else decode
    // the raw LITCHR code through LITCHR_LABELS ('Fl' → 'Flashing');
    // else show the raw code the user can cross-reference on a chart.
    const lightLabel = props._lightLabel;
    const litchr = props.LITCHR ?? props.litchr;
    const sigper = props.SIGPER ?? props.sigper;
    const valnmr = props.VALNMR ?? props.valnmr;
    const height = props.HEIGHT ?? props.height;
    const colour = props.COLOUR ?? props.colour;
    if (typeof lightLabel === 'string' && lightLabel) {
        out += `<div class="enc-popup-row"><span>Character</span><b>${esc(lightLabel)}</b></div>`;
    } else if (litchr) {
        const decoded = LITCHR_LABELS[String(litchr)] ?? String(litchr);
        out += `<div class="enc-popup-row"><span>Character</span><b>${esc(decoded)}</b></div>`;
    }
    if (sigper) out += `<div class="enc-popup-row"><span>Period</span><b>${esc(sigper)} s</b></div>`;
    if (height) out += `<div class="enc-popup-row"><span>Height</span><b>${esc(fmtDepth(height))}</b></div>`;
    if (valnmr) out += `<div class="enc-popup-row"><span>Range</span><b>${esc(valnmr)} NM</b></div>`;
    if (colour) out += `<div class="enc-popup-row"><span>Colour</span><b>${esc(colourNames(colour))}</b></div>`;
    return out;
}

/**
 * Build the popup HTML for a feature. The layer ID determines
 * which fields we surface — DEPARE shows depth range, WRECKS
 * shows category + depth, etc.
 *
 * Style: dark glassmorphic to match the rest of the app's chart
 * UI. Mapbox's default popup CSS gives us a white background; we
 * override per-class in the class names.
 */
export interface PopupExtras {
    /** Vessel keel floor (draft + tide margin, metres) from depthStyleState. */
    safetyDepthM?: number;
    /** Tide offset in force on the chart (metres above LAT), null = datum. */
    tideOffsetM?: number | null;
    /** Non-null when the offset is a SCRUBBED instant, not live "now". */
    tideOffsetAtMs?: number | null;
    /** Keel floor came from the 2.5 m fallback draft — caveat required. */
    draftAssumed?: boolean;
    /** Props of a LIGHTS feature co-located with the tapped mark —
     *  folded into the mark popup as a "Light" section. Without this a
     *  lit mark answered as its light ONLY: the LIGHTS point rides the
     *  same coordinate and renders on top, so nearest-wins hid the mark
     *  info entirely (Shane 2026-07-15: "all markers that have lights
     *  are just showing the light information"). */
    light?: Record<string, unknown>;
    /** Props of an SBDARE (seabed nature) polygon under a DEPARE tap —
     *  folded into the depth popup as a "Seabed" row. The SBDARE wash is
     *  non-clickable by design (it stole the depth popup — audit); this is
     *  how its NATSUR anchoring read reaches the user. */
    seabed?: Record<string, unknown>;
    /** Props of a caution AREA (restricted/cable/pipeline/TSS) under a water
     *  tap — folded into the depth popup as a "⚠ Restricted area…" row, so
     *  the caution wash never REPLACES the depth/keel read (audit). */
    caution?: Record<string, unknown>;
}

const fmtHm = (ms: number): string =>
    new Date(ms).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

export function buildFeaturePopupHtml(
    layerId: string,
    props: Record<string, unknown>,
    extras: PopupExtras = {},
): string {
    const cellId = props._cellId as string | undefined;
    const sourceHO = props._sourceHO as string | undefined;
    const provenance = cellId
        ? `<div class="enc-popup-cell">${esc(cellId)}${sourceHO ? ` · ${esc(sourceHO)}` : ''}</div>`
        : '';

    let title = 'Feature';
    let body = '';
    let accent = '#0ea5e9'; // sky-500 default

    if (layerId === ENC_VEC_LAYERS.DEPARE) {
        // Tap-the-water (2026-07-11 #1): the punter taps any patch of
        // water and gets the ANSWER — charted band, live water, and the
        // keel verdict — instead of chart-speak. The tide window for
        // needs-tide reads fills in async (see fillDepareTideWindow).
        title = 'Water';
        accent = '#3a8dbf';
        const d1raw = Number(props.DRVAL1 ?? props.drval1);
        const d2raw = Number(props.DRVAL2 ?? props.drval2);
        const d1 = Number.isFinite(d1raw) ? d1raw : null;
        const d2 = Number.isFinite(d2raw) ? d2raw : null;
        if (d1 !== null) {
            const charted =
                d1 < 0 && d2 !== null && d2 > 0
                    ? // Straddles the drying line: part sand at low tide,
                      // part water — say BOTH (review minor: "dries up to
                      // X" alone hid the water).
                      `dries up to ${Math.abs(d1).toFixed(1)} m / up to ${d2.toFixed(1)} m of water`
                    : d1 < 0
                      ? `dries up to ${Math.abs(d1).toFixed(1)} m`
                      : d2 !== null
                        ? `${d1.toFixed(d1 < 10 ? 1 : 0)}–${d2.toFixed(d2 < 10 ? 1 : 0)} m of water`
                        : `at least ${d1.toFixed(1)} m`;
            body += `<div class="enc-popup-row"><span>At low tide</span><b>${esc(charted)}</b></div>`;
            const h = extras.tideOffsetM;
            // Scrub honesty (review CRITICAL): a scrubbed offset must never
            // wear "right now" — every tide-derived row is labelled with
            // the instant it describes, in the scrubber's violet.
            const scrubbedAt = extras.tideOffsetAtMs ?? null;
            const whenLabel = scrubbedAt !== null ? `At ${fmtHm(scrubbedAt)}` : 'Right now';
            const tideColor = scrubbedAt !== null ? '#c4b5fd' : '#5eead4';
            if (h != null) {
                const lo = d1 + h;
                const hi = d2 !== null ? d2 + h : null;
                const reads =
                    lo <= 0 && hi !== null && hi <= 0
                        ? 'still dry'
                        : `≈ ${Math.max(0, lo).toFixed(1)}${hi !== null ? `–${Math.max(0, hi).toFixed(1)}` : ''} m`;
                body += `<div class="enc-popup-row"><span>${esc(whenLabel)}</span><b style="color:${tideColor}">${esc(reads)} (tide ${h >= 0 ? '+' : ''}${h.toFixed(1)} m)</b></div>`;
            }
            const S = extras.safetyDepthM;
            if (S != null && S > 0) {
                if (d1 >= S) {
                    body += `<div class="enc-popup-row"><span>Your keel</span><b style="color:#4ade80">✓ deep enough at any tide</b></div>`;
                } else if (h != null && d1 + h >= S) {
                    body +=
                        scrubbedAt !== null
                            ? `<div class="enc-popup-row"><span>Your keel</span><b style="color:${tideColor}">✓ enough water at ${esc(fmtHm(scrubbedAt))} — NOT necessarily now</b></div>`
                            : `<div class="enc-popup-row"><span>Your keel</span><b style="color:${tideColor}">✓ enough water right now — the tide is in</b></div>`;
                } else {
                    body += `<div class="enc-popup-row"><span>Your keel</span><b style="color:#fbbf24">needs +${(S - d1).toFixed(1)} m of tide</b></div>`;
                    body += `<div class="enc-popup-row"><span>Window</span><b class="enc-popup-tidewin" style="color:#fbbf24">checking tides…</b></div>`;
                }
                // Draft honesty (mirrors the tracer): a verdict against the
                // fallback draft always says so.
                if (extras.draftAssumed) {
                    body += `<div class="enc-popup-row"><span></span><b style="color:#fbbf24">checked against a default 2.5 m draft — set your vessel</b></div>`;
                }
            }
        } else {
            body += `<div class="enc-popup-row"><span>Type</span><b>Charted depth area</b></div>`;
        }
        // Seabed nature under the tap (co-located SBDARE) — the anchoring
        // read, in the popup a punter actually opens ("Seabed: Sand / Mud").
        if (extras.seabed) {
            const sb = natsurNames(extras.seabed.NATSUR ?? extras.seabed.natsur);
            if (sb) body += `<div class="enc-popup-row"><span>Seabed</span><b>${esc(sb)}</b></div>`;
        }
        // Caution area under the tap — the depth/keel read stays the star,
        // the restriction rides along ("⚠ Restricted area — entry prohibited").
        if (extras.caution) {
            const cls = String(extras.caution._caution ?? '');
            const label = CAUTION_LABELS[cls] ?? 'Charted area';
            const restrn = restrnNames(extras.caution.RESTRN ?? extras.caution.restrn);
            const detail = restrn || (cls === 'CBLARE' || cls === 'PIPARE' ? 'No anchoring' : '');
            body += `<div class="enc-popup-row"><span>⚠</span><b style="color:#e879f9">${esc(label)}${detail ? ` — ${esc(detail)}` : ''}</b></div>`;
        }
    } else if (layerId === ENC_VEC_LAYERS.LNDARE) {
        title = 'Land';
        accent = '#a8956a';
        body += `<div class="enc-popup-row"><span>Type</span><b>Charted land area</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.COALNE) {
        title = 'Coastline';
        accent = '#ffffff';
        body += `<div class="enc-popup-row"><span>Type</span><b>Charted coastline</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.OBSTRN) {
        title = 'Obstruction';
        accent = ENC_HAZARD_MAGENTA;
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
        const cat = String(props.CATOBS ?? props.catobs ?? '');
        if (cat && CATOBS_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Category</span><b>${esc(CATOBS_LABELS[cat])}</b></div>`;
        }
        body += valsouRow(props.VALSOU ?? props.valsou);
        const watlev = String(props.WATLEV ?? props.watlev ?? '');
        if (watlev && WATLEV_LABELS[watlev]) {
            body += `<div class="enc-popup-row"><span>Water level</span><b>${esc(WATLEV_LABELS[watlev])}</b></div>`;
        }
    } else if (layerId === ENC_VEC_LAYERS.WRECKS) {
        title = 'Wreck';
        accent = ENC_HAZARD_MAGENTA;
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
        const cat = String(props.CATWRK ?? props.catwrk ?? '');
        if (cat && CATWRK_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Category</span><b>${esc(CATWRK_LABELS[cat])}</b></div>`;
        }
        body += valsouRow(props.VALSOU ?? props.valsou);
    } else if (layerId === ENC_VEC_LAYERS.UWTROC) {
        title = 'Underwater rock';
        accent = ENC_HAZARD_MAGENTA;
        body += valsouRow(props.VALSOU ?? props.valsou);
        const watlev = String(props.WATLEV ?? props.watlev ?? '');
        if (watlev && WATLEV_LABELS[watlev]) {
            body += `<div class="enc-popup-row"><span>Water level</span><b>${esc(WATLEV_LABELS[watlev])}</b></div>`;
        }
    } else if (layerId === ENC_VEC_LAYERS.LIGHTS) {
        title = 'Light';
        accent = '#fde047';
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
        body += lightRows(props);
    } else if (layerId === ENC_VEC_LAYERS.LIGHTSEC_ARC) {
        // Tap-to-read for a sectored light (#3a): "am I in the red, the white,
        // or the green?" — the night-approach question the LIGHTSEC layer
        // exists to answer. A tap here used to fall through to the DEPARE water
        // popup, so the layer's most safety-critical element was mute.
        title = 'Light sector';
        // _secColor is from our controlled lightColourHex palette; validate as
        // a hex before inlining it into a style attribute all the same.
        const secColor =
            typeof props._secColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(props._secColor)
                ? props._secColor
                : '#fde047';
        accent = secColor;
        const colourName = props.COLOUR != null && String(props.COLOUR) !== '' ? colourNames(props.COLOUR) : null;
        if (colourName) {
            body += `<div class="enc-popup-row"><span>Sector</span><b style="color:${secColor};text-transform:capitalize">${esc(
                colourName,
            )}</b></div>`;
        }
        const s1 = Number(props.SECTR1 ?? props.sectr1);
        const s2 = Number(props.SECTR2 ?? props.sectr2);
        if (Number.isFinite(s1) && Number.isFinite(s2)) {
            // Raw from-seaward limits — the bearings read off the water ("you
            // see this colour when the light bears between…"), NOT the +180
            // reciprocal the arc is drawn on.
            body += `<div class="enc-popup-row"><span>Limits</span><b>${s1.toFixed(0)}°–${s2.toFixed(
                0,
            )}° from seaward</b></div>`;
        }
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Light</span><b>${esc(name)}</b></div>`;
        const lightLabel = props._lightLabel;
        if (typeof lightLabel === 'string' && lightLabel)
            body += `<div class="enc-popup-row"><span>Character</span><b>${esc(lightLabel)}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.BOYLAT || layerId === ENC_VEC_LAYERS.BCNLAT) {
        const isBeacon = layerId === ENC_VEC_LAYERS.BCNLAT;
        title = isBeacon ? 'Lateral beacon' : 'Lateral buoy';
        accent = '#facc15';
        const CATLAM_LABELS: Record<string, string> = {
            '1': 'Port-hand mark',
            '2': 'Starboard-hand mark',
            '3': 'Preferred channel — port',
            '4': 'Preferred channel — starboard',
            '5': 'Channel marker',
            '6': 'Bifurcation',
            '7': 'Junction',
            '8': 'Wreck mark',
        };
        const cat = String(props.CATLAM ?? props.catlam ?? '');
        if (cat && CATLAM_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Mark</span><b>${esc(CATLAM_LABELS[cat])}</b></div>`;
        }
        // Passing rule, spelled out to match the cardinal treatment (audit:
        // laterals got only a category label). The leave-side is fixed by
        // CATLAM and is region-INDEPENDENT — region A/B only swaps the
        // COLOUR, not the hand — so this holds for both IALA regions.
        const LEAVE_SIDE: Record<string, string> = {
            '1': 'Leave to PORT',
            '2': 'Leave to STARBOARD',
        };
        if (LEAVE_SIDE[cat]) {
            body += `<div class="enc-popup-row"><span>Pass</span><b style="color:#4ade80">${LEAVE_SIDE[cat]}</b> <span style="opacity:0.7">with the buoyage direction</span></div>`;
        }
        const region = props._ialaRegion;
        if (region === 'A' || region === 'B') {
            body += `<div class="enc-popup-row"><span>Region</span><b>IALA-${esc(region)}</b></div>`;
        }
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.BOYCAR || layerId === ENC_VEC_LAYERS.BCNCAR) {
        const isBeacon = layerId === ENC_VEC_LAYERS.BCNCAR;
        title = isBeacon ? 'Cardinal beacon' : 'Cardinal buoy';
        accent = '#facc15';
        const CATCAM_LABELS: Record<string, string> = {
            '1': 'North',
            '2': 'East',
            '3': 'South',
            '4': 'West',
        };
        const cat = String(props.CATCAM ?? props.catcam ?? '');
        if (cat && CATCAM_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Quadrant</span><b>${esc(CATCAM_LABELS[cat])}</b></div>`;
            // The rule, spelled out — a cardinal is passed on the side it
            // NAMES. Shane 2026-07-11: "I need to pass on the correct side
            // of cardinals but I do not know which side is which."
            body += `<div class="enc-popup-row"><span>Pass</span><b style="color:#4ade80">${esc(
                CATCAM_LABELS[cat].toUpperCase(),
            )} of this mark</b></div>`;
        }
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.BOYSAW || layerId === ENC_VEC_LAYERS.BCNSAW) {
        title = layerId === ENC_VEC_LAYERS.BCNSAW ? 'Safe-water beacon' : 'Safe-water buoy';
        accent = '#f87171';
        body += `<div class="enc-popup-row"><span>Meaning</span><b>Safe water all round — fairway / landfall mark</b></div>`;
        const sawName = props.OBJNAM ?? props.objnam;
        if (typeof sawName === 'string' && sawName)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(sawName)}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.BOYISD || layerId === ENC_VEC_LAYERS.BCNISD) {
        title = layerId === ENC_VEC_LAYERS.BCNISD ? 'Isolated-danger beacon' : 'Isolated-danger buoy';
        accent = '#f87171';
        body += `<div class="enc-popup-row"><span>Meaning</span><b style="color:#fbbf24">Danger below — navigable water AROUND it, keep clear of the mark</b></div>`;
        const isdName = props.OBJNAM ?? props.objnam;
        if (typeof isdName === 'string' && isdName)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(isdName)}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.BOYSPP || layerId === ENC_VEC_LAYERS.BCNSPP) {
        const isBeacon = layerId === ENC_VEC_LAYERS.BCNSPP;
        title = isBeacon ? 'Special-purpose beacon' : 'Special-purpose buoy';
        accent = '#facc15';
        // S-57 CATSPM (category of special-purpose mark) — the values a
        // skipper actually meets; anything else falls through to the name.
        const CATSPM_LABELS: Record<string, string> = {
            '1': 'Firing-danger area',
            '6': 'Cable mark',
            '7': 'Spoil-ground mark',
            '8': 'Outfall mark',
            '9': 'ODAS (data buoy)',
            '14': 'Mooring',
            '15': 'LANBY',
            '16': 'Leading mark',
            '18': 'Notice mark',
            '20': 'Anchorage mark',
            '22': 'Pipeline mark',
            '25': 'Control mark',
            '26': 'Diving mark',
            '28': 'Foul-ground mark',
            '39': 'Marine-farm mark',
            '44': 'Wreck mark',
        };
        const cat = String(props.CATSPM ?? props.catspm ?? '').trim();
        if (cat && CATSPM_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Purpose</span><b>${esc(CATSPM_LABELS[cat])}</b></div>`;
        } else if (cat && cat !== 'undefined') {
            // Charted category with no friendly label yet — show the raw S-57
            // code so it can be looked up, rather than leaving the popup blank.
            body += `<div class="enc-popup-row"><span>Purpose</span><b>Special mark (S-57 cat ${esc(cat)})</b></div>`;
        }
        // Free-text the chart may carry even without a CATSPM category — often
        // the most useful line ("Cable crossing", "No anchoring", "Ski area").
        const informRaw = props.INFORM ?? props.inform ?? props.NINFOM ?? props.ninfom;
        const inform = typeof informRaw === 'string' ? informRaw.trim() : '';
        if (inform) body += `<div class="enc-popup-row"><span>Note</span><b>${esc(inform)}</b></div>`;
        const name = props.OBJNAM ?? props.objnam;
        const hasName = typeof name === 'string' && name.trim() !== '';
        if (hasName) body += `<div class="enc-popup-row"><span>Name</span><b>${esc(String(name))}</b></div>`;
        // Nothing charted beyond "it's a yellow special mark" → say so plainly
        // rather than show an identity-less popup (Shane 2026-07-16: "can we get
        // more info on what each one is for?"). Honest about the data limit.
        if (!(cat && cat !== 'undefined') && !inform && !hasName)
            body += `<div class="enc-popup-row"><span>Purpose</span><b>General special mark — the chart carries no category. Check the paper chart / Notices to Mariners.</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.CAUTION_AREA_FILL) {
        // Caution / info AREA (restricted / cable / pipeline / seabed / TSS).
        // Reached when there is NO charted water under the tap — over water
        // the caution folds into the DEPARE popup instead (extras.caution).
        const cls = String(props._caution ?? '');
        title = CAUTION_LABELS[cls] ?? 'Charted area';
        // Accent matches the per-class render colours (restricted magenta,
        // cable/pipeline violet, TSS amber, seabed olive).
        accent =
            cls === 'SBDARE'
                ? '#8a8a5a'
                : cls === 'CBLARE'
                  ? '#8b5cf6'
                  : cls === 'PIPARE'
                    ? '#7c3aed'
                    : cls === 'TSSLPT'
                      ? '#f59e0b'
                      : '#d43fc0';
        // RESTRN (restriction) — the values a skipper meets most.
        const restrn = restrnNames(props.RESTRN ?? props.restrn);
        if (restrn) body += `<div class="enc-popup-row"><span>Restriction</span><b>${esc(restrn)}</b></div>`;
        else if (cls === 'CBLARE' || cls === 'PIPARE')
            body += `<div class="enc-popup-row"><span>Note</span><b>No anchoring</b></div>`;
        // NATSUR (nature of surface) for seabed areas — the anchoring read.
        const natsur = natsurNames(props.NATSUR ?? props.natsur);
        if (natsur) body += `<div class="enc-popup-row"><span>Seabed</span><b>${esc(natsur)}</b></div>`;
        const informRaw = props.INFORM ?? props.inform ?? props.NINFOM ?? props.ninfom;
        const inform = typeof informRaw === 'string' ? informRaw.trim() : '';
        if (inform) body += `<div class="enc-popup-row"><span>Note</span><b>${esc(inform)}</b></div>`;
        const cname = props.OBJNAM ?? props.objnam;
        if (typeof cname === 'string' && cname.trim())
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(cname)}</b></div>`;
    }

    // A lit mark carries its light's details BELOW the mark rows — the
    // mark identity (Pass NORTH of this mark, port-hand, name…) leads,
    // the light character follows. Never on the standalone Light popup.
    if (extras.light && layerId !== ENC_VEC_LAYERS.LIGHTS) {
        const rows = lightRows(extras.light);
        if (rows) body += `<div class="enc-popup-sub" style="color:#fde047">Light</div>${rows}`;
    }

    if (!body) body = `<div class="enc-popup-row"><span>Feature</span><b>${esc(title)}</b></div>`;

    return `
        <div class="enc-popup">
            <button class="enc-popup-close" aria-label="Close">×</button>
            <div class="enc-popup-title" style="color:${accent}">${esc(title)}</div>
            <div class="enc-popup-body">${body}</div>
            ${provenance}
        </div>
        <style>
            .enc-popup {
                position: relative;
                font-family: system-ui, -apple-system, sans-serif;
                color: rgb(229, 231, 235);
                background: rgba(15, 23, 42, 0.92);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 10px;
                padding: 10px 12px;
                font-size: 12px;
                line-height: 1.5;
                min-width: 180px;
                max-width: 280px;
            }
            .enc-popup-close {
                position: absolute;
                top: 2px;
                right: 2px;
                background: rgba(15, 23, 42, 0.85);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: rgb(209, 213, 219);
                border-radius: 999px;
                /* 32 px box (was 22) — gloved-hand target on a moving
                   deck; half of Apple's 44 pt floor was fat-finger
                   hostile (2026-07-12 audit). */
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                font-size: 18px;
                line-height: 1;
                font-weight: bold;
                padding: 0;
            }
            .enc-popup-close:hover {
                background: rgba(220, 38, 38, 0.85);
                color: white;
            }
            .enc-popup-title {
                font-size: 13px;
                font-weight: 700;
                margin-bottom: 6px;
                padding-right: 32px;
            }
            .enc-popup-body { display: flex; flex-direction: column; gap: 2px; }
            .enc-popup-sub {
                margin-top: 6px;
                padding-top: 6px;
                border-top: 1px solid rgba(255, 255, 255, 0.08);
                font-size: 11px;
                font-weight: 700;
            }
            .enc-popup-row { display: flex; justify-content: space-between; gap: 12px; }
            .enc-popup-row span { color: rgba(229, 231, 235, 0.55); }
            .enc-popup-row b { font-weight: 600; color: rgb(229, 231, 235); }
            .enc-popup-cell {
                margin-top: 6px;
                padding-top: 6px;
                border-top: 1px solid rgba(255, 255, 255, 0.08);
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size: 10px;
                color: rgba(229, 231, 235, 0.55);
            }
            .mapboxgl-popup-content { background: transparent !important; padding: 0 !important; box-shadow: none !important; }
            .mapboxgl-popup-tip { display: none !important; }
        </style>
    `;
}
