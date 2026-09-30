import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface S57Class {
    code: number;
    acronym: string;
    name: string;
    primitives: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

let cache: Map<number, S57Class> | null = null;

export function loadS57Classes(csvPath?: string): Map<number, S57Class> {
    if (cache) return cache;
    const path = csvPath ?? resolve(__dirname, '../reference/s57objectclasses.csv');
    const csv = readFileSync(path, 'utf8');
    const lines = csv.split('\n').slice(1);
    const map = new Map<number, S57Class>();
    for (const line of lines) {
        if (!line.trim()) continue;
        const cols = parseCsvLine(line);
        if (cols.length < 8) continue;
        const code = Number(cols[0]);
        if (!Number.isFinite(code) || code === 0) continue;
        const name = cols[1];
        const acronym = cols[2];
        const primitives = cols[7];
        if (!acronym) continue;
        map.set(code, { code, acronym, name, primitives });
    }
    cache = map;
    return map;
}

function parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (c === ',' && !inQuotes) {
            out.push(cur);
            cur = '';
            continue;
        }
        cur += c;
    }
    out.push(cur);
    return out;
}

export function classAcronym(code: number): string {
    const klass = loadS57Classes().get(code);
    return klass ? klass.acronym : `?${code}`;
}

export function classRecord(code: number): S57Class | undefined {
    return loadS57Classes().get(code);
}

/**
 * The output schema of THIS extractor. Bump it whenever the emitted cell
 * content changes for an unchanged chart (a class added, an attribute
 * normalised): decryptBatch folds it into every input fingerprint, so the
 * Pi's --skip-existing reconcile re-extracts each chart once, and the chart
 * stores (piCacheStore here, pi-cache/src/encChartStore.ts on the Pi) let a
 * NEWER schema replace an older one at the same chart revision — and never
 * the reverse. Absent on a cell: schema 1 (everything before this field).
 *   2 — BRIDGE / PONTON / CBLOHD / PIPOHD / CONVYR, always emitted (Part B,
 *       2026-09-30; CONVYR joined in round 2 before anything deployed, so the
 *       schema stays 2).
 */
export const EXTRACTOR_SCHEMA = 2;

/**
 * Classes every cell carries even when it charts none of them — as an EMPTY
 * FeatureCollection, the "extracted, none charted" contract. The app's lead
 * review (services/routing/leadReview.ts LEAD_REQUIRED_STRUCTURE_LAYERS)
 * reads a missing key as "not extracted": no lead there is ever clear, since
 * a bridge the owner said must BLOCK when its clearance is unknown could be
 * on it. Mirrored in pi-cache/src/encLayerContract.ts for the ogr2ogr path.
 */
export const ALWAYS_EMITTED_CLASSES: ReadonlySet<string> = new Set(['BRIDGE', 'PONTON', 'CBLOHD', 'PIPOHD', 'CONVYR']);

// NOTE: pi-cache/src/routes/enc.ts duplicates this list as ENC_LAYERS for
// the ogr2ogr (.000 upload) path — pi-cache deploys standalone to the Pi so
// it can't import from here. When you change this Set, mirror it there.
export const ROUTING_CLASSES = new Set([
    'LNDARE',
    'DEPARE',
    'DEPCNT',
    'COALNE',
    'OBSTRN',
    'WRECKS',
    // UWTROC is the standard S-57 class for underwater/awash rocks. (A dead
    // 'ROCKS' entry used to sit here — not in the IHO/GDAL catalogue, never
    // matched; removed 2026-06.)
    'UWTROC',
    'DRGARE',
    'FAIRWY',
    'BOYLAT',
    'BCNLAT',
    'BOYSPP',
    'BCNSPP',
    'BOYCAR',
    'BCNCAR',
    'LIGHTS',
    // Leading lines / transits (masterplan Phase 6 — offline leads):
    // NAVLNE = navigation line (the charted lead), RECTRC = recommended
    // track. RECTRC is known-empty in the current AU SENC set
    // (PHASE_14_SPIKE) — emitted anyway for future cells.
    'NAVLNE',
    'RECTRC',
    // Survey-confidence (CATZOC) zones — consumed at IMPORT time by
    // buildCatzocZones() for each cell's catzocRange badge, NOT a visual
    // layer. Parity with the ogr2ogr path, which already emitted it; the
    // SENC path didn't, so SENC-extracted cells previously showed no CATZOC.
    'M_QUAL',
    // Spot soundings (Shane 2026-07-09 "more depth measurements in close").
    // Emitted as MultiPoint + a `depths` array (see geojsonEmitter);
    // EncHazardService explodes them into labelled points at merge time
    // and EncVectorLayer draws the numbers, so the renderer-consumes rule
    // below is satisfied.
    'SOUNDG',
    // Safe-water (RW fairway/landfall) + isolated-danger (BRB) marks —
    // two of the five IALA families, missing from the chart entirely
    // until the 2026-07-12 audit. EncVectorLayer renders all four.
    // NOTE: existing cells need RE-EXTRACTION (+ manifest bump for the
    // cloud bucket) before these actually appear.
    'BOYSAW',
    'BCNSAW',
    'BOYISD',
    'BCNISD',
    // Named sea areas — bays, channels, passages, rivers ("Mooloolah
    // River", "Pumicestone Passage"). Carried for their OBJNAM only:
    // the merge reduces each polygon to ONE label point, EncVectorLayer
    // draws the name in chart ink (Shane 2026-07-13: "put the channel
    // name in the channels"). NOTE: existing cells need RE-EXTRACTION
    // (+ bucket re-upload + manifest bump) before names appear.
    'SEAARE',
    // Caution / information AREAS (2026-07-16, the ENC-completeness audit —
    // "a best-in-class ENC router flags cable/restricted/pipeline crossings").
    // All AREA primitives, ring-assembled like DEPARE. EncVectorLayer draws
    // them as chart-furniture outlines/fills and encPopup reads their
    // category attrs. NOTE: existing cells need RE-EXTRACTION (+ bucket
    // re-upload + manifest bump) before these appear.
    'RESARE', // Restricted area (RESTRN/CATREA — no-anchor, no-entry, etc.)
    'CBLARE', // Submarine cable area (no anchoring)
    'PIPARE', // Pipeline area (no anchoring)
    'SBDARE', // Seabed area — nature of the bottom (NATSUR: sand/mud/rock; anchoring aid)
    'TSSLPT', // Traffic Separation Scheme lane part (ORIENT — keep-to-your-lane)
    // Batch 2 (2026-07-16 burn-down "missing charted-area classes"):
    'CTNARE', // Caution area — "see the chart note"
    'TSEZNE', // TSS zone (the separation zone between lanes — keep OUT)
    'ACHARE', // Anchorage area (where you're MEANT to anchor)
    'MARCUL', // Marine farm / aquaculture (nets + lines — keep clear)
    'TSELNE', // TSS separation line (audit: TSS family gaps)
    'TSSBND', // TSS boundary
    'PRCARE', // Precautionary area
    'DWRTPT', // Deep-water route part
    // Man-made allision structures (cycle-5 audit #3) — extracted for the
    // grounding/allision HAZARD MODEL (buildHazardsForCell), NOT rendered.
    // WATLEV-gated in encHazardParse (floating dropped; piles submerged-only),
    // so the memory cost is only the sparse harbour/river-mouth features.
    // NOTE: existing cells need RE-EXTRACTION (+ bucket manifest bump) before a
    // training wall charted only as SLCONS is actually avoided.
    'SLCONS', // Shoreline construction — training walls / breakwaters / groynes
    'DAMCON', // Dam
    'PILPNT', // Pile / dolphin / post
    // Bridges and overhead clearance (Part B, inshore router, 2026-09-30) —
    // extracted for ROUTING, not rendered: the router blocks a bridge or an
    // overhead cable / pipe whose clearance (VERCLR / VERCCL / VERCSA; an
    // opening bridge's CATBRG and VERCOP ride along) is below the mast's air
    // draft + margin, or unknown; the lead overlay reviews leads against them.
    // Always emitted, empty when none is charted (ALWAYS_EMITTED_CLASSES).
    // Sparse (a handful per harbour cell), so the memory cost is small.
    // Existing cells pick them up by re-extraction: EXTRACTOR_SCHEMA 2.
    'BRIDGE', // Bridge (CATBRG, VERCLR, VERCCL, VERCOP, HORCLR)
    'PONTON', // Pontoon
    'CBLOHD', // Cable, overhead (VERCLR, VERCSA)
    'PIPOHD', // Pipeline, overhead (VERCLR)
    // An overhead conveyor (a loading gantry over a wharf approach) is a
    // span a mast passes under like any bridge (round 2, 2026-09-30).
    'CONVYR', // Conveyor (VERCLR, VERCSA)
    // ── Deferred — extract cleanly but NO renderer consumes them yet, so
    // kept OUT to protect on-device memory (getMergedVectorData loads every
    // imported cell's full vector data into memory at once). Re-add here
    // the moment EncVectorLayer draws them. Next visual batch: TOPMAR/DAYMAR
    // (topmark glyphs), MORFAC/HRBFAC (harbour structures), LNDRGN/BUAARE/
    // LAKARE (named areas), ACHBRT (anchor berths), CBLSUB/PIPSOL/DMPGRD
    // (submarine cable/pipeline LINES). ──
]);
