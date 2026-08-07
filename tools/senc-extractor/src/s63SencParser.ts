import { HeaderInfo, SencFeature, AttributeValue } from './featureParser.js';
import { latLonToMerc, MercXY, smVertexToLatLon } from './mercator.js';
import { meshToPolygons } from './meshOutline.js';
import { loadS57Classes } from './s57Classes.js';

/**
 * Parser for the SENC dialect emitted by OpenCPN's s63 plugin.
 *
 * This is NOT the binary record format `featureParser.ts` handles. The s63
 * plugin's OCPNsenc helper writes the older line-oriented SENC: an ASCII
 * skeleton (`OGRFeature(CLASS):n`, `KEY (T) = value`) with binary geometry
 * blobs spliced in at byte counts named by the preceding text line.
 *
 * Feed it plaintext from `s63Decrypt.decryptEsenc`.
 *
 * Coordinates throughout are simple-mercator metre offsets from a reference
 * point stated on each geometry line — the same convention `mercator.ts`
 * already handles for the binary format.
 *
 * Reference: bdbcat/s63_pi — `s63chart.cpp` (feature loop, `VETableStart` /
 * `VCTableStart` readers, `AssembleLineGeometry`) and `mygeom63.cpp`
 * (`PolyTessGeo63`, the triangulation layout).
 */

/** Marks the end of the triangle list; the four bytes spell "POLY" read as int32-LE. */
const POLYEND_SENTINEL = 0x594c4f50;

/** Triangle primitive types, mirroring GL_TRIANGLES / _STRIP / _FAN. */
const TRI_TYPES = new Set([4, 5, 6]);

/** Sentinel index terminating both vector tables. */
const TABLE_END = -1;

/**
 * Topology bookkeeping that shares the attribute-line syntax but is not S-57
 * attribution — dropped so `properties` carries only real chart attributes.
 */
const INTERNAL_ATTRIBUTES = new Set(['PRIM', 'NAME_RCNM', 'NAME_RCID', 'ORNT', 'USAG', 'MASK']);

const FEATURE_MARKER = Buffer.from('OGRFeature(');
const VE_TABLE_MARKER = Buffer.from('VETableStart\n');
const VC_TABLE_MARKER = Buffer.from('VCTableStart\n');

/**
 * Number pattern for geometry-line reference coordinates. The writer formats
 * them with %g, which switches to exponent notation ("5.5e-05") when a cell's
 * reference point sits within ~11 m of the equator or prime meridian — rare,
 * but a plain [\d.] pattern would silently drop every feature in such a cell.
 */
const NUM = '(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)';
const POINT_RE = new RegExp(`\\n {2}POINT ${NUM} ${NUM}\\n\\s*(\\d+)\\n`);
const MULTIPOINT_RE = new RegExp(`\\n {2}MULTIPOINT ${NUM} ${NUM}\\n\\s*(\\d+)\\n`);
const LINESTRING_RE = new RegExp(`\\n {2}LINESTRING ${NUM} ${NUM}\\n\\s*(\\d+)\\n`);
const POLYTESSGEO_RE = new RegExp(`\\n {2}POLYTESSGEO {2}(\\d+) ${NUM} ${NUM}\\n`);

/** S-57 primitive codes as written on the `PRIM` line. */
const PRIM_POINT = 1;
const PRIM_LINE = 2;
const PRIM_AREA = 3;

/** Edge geometry: interior vertices between two connected nodes, in SM metres. */
type EdgeTable = Map<number, [number, number][]>;
/** Connected-node coordinates, in SM metres. */
type NodeTable = Map<number, [number, number]>;

export interface ParsedS63Senc {
    header: HeaderInfo;
    features: SencFeature[];
    /** Feature blocks whose geometry this pass could not reconstruct, by class. */
    skippedGeometry: Record<string, number>;
    stats: {
        edgeCount: number;
        nodeCount: number;
        /** Line features whose reassembled extent matched the extent the chart recorded. */
        linesBboxVerified: number;
        /**
         * Line features whose reassembled extent did NOT match the recorded
         * one. Their geometry is withheld (counted in skippedGeometry) —
         * proven-wrong geometry never reaches the output.
         */
        linesBboxMismatch: number;
        /**
         * Line features dropped because their LSINDEXLIST referenced a node
         * or edge missing from the vector tables — damaged SENC. Withheld.
         */
        linesStructuralBreak: number;
        /**
         * Line features with legitimately disjoint parts, emitted as
         * MultiLine. Informational — these are valid chart features.
         */
        linesMultiPart: number;
        /**
         * AREA features whose triangle mesh was successfully dissolved back
         * into polygon rings (meshOutline). This is the number that should be
         * ~100% of areas; a large `areasMeshFallback` beside it means the
         * chart still renders as raw triangles.
         */
        areasWithPolygons: number;
        /**
         * AREA features whose mesh could NOT be resolved — outline withheld,
         * triangles kept. Fails closed on purpose: a wrongly-shaped depth area
         * is a grounding, not a cosmetic bug.
         */
        areasMeshFallback: number;
        /** OGRFeature blocks whose acronym is not in the S-57 catalogue. */
        unknownClasses: Record<string, number>;
    };
}

function acronymToCode(): Map<string, number> {
    const map = new Map<string, number>();
    for (const [code, klass] of loadS57Classes()) map.set(klass.acronym, code);
    return map;
}

/**
 * Parse an attribute value using the type tag OCPNsenc writes: `(I)` integer,
 * `(R)` real, `(S)` string. Multi-valued topology fields arrive as `(2:1,2)`
 * and are kept verbatim — they are filtered out before emission anyway.
 */
function parseAttributeValue(typeTag: string, raw: string): AttributeValue {
    const value = raw.trim();
    if (value.startsWith('(')) return value;
    if (typeTag === 'I' || typeTag === 'R') {
        const n = Number(value);
        return Number.isFinite(n) ? n : value;
    }
    return repairUtf8(value);
}

/**
 * Undo the latin1 carry on a string attribute.
 *
 * The feature block is decoded as latin1 ON PURPOSE — text and binary are
 * interleaved and every offset in this parser is a byte offset, which only
 * holds while one char == one byte. The side effect is that a UTF-8 name
 * arrives as its individual bytes reinterpreted as Latin-1 characters: the
 * SENC's "Îlot" (C3 8E 6C 6F 74) becomes "Ã\x8elot". Measured on FR466870,
 * 2026-08-07: 94 mangled OBJNAMs, e.g. "Ãle Ange (Ãle YagÃ©)" and
 * "Rocher Ã\xa0 la Voile".
 *
 * Reversing it is exact — re-encode as latin1 to recover the original bytes,
 * then decode them as UTF-8. The guards make it safe on charts that really do
 * carry Latin-1:
 *   • pure ASCII is returned untouched;
 *   • anything above U+00FF cannot have come from a latin1 decode, so it is
 *     already correct and is left alone;
 *   • `fatal: true` means a byte sequence that is NOT valid UTF-8 throws
 *     rather than producing U+FFFD, and we keep the original. A genuine
 *     Latin-1 "Café" (…66 E9) is invalid UTF-8 and so survives unchanged.
 */
function repairUtf8(value: string): string {
    if (!/[\u0080-\u00FF]/.test(value)) return value;
    for (const ch of value) {
        if ((ch.codePointAt(0) ?? 0) > 0xff) return value;
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'latin1'));
    } catch {
        return value;
    }
}

function parseHeader(buf: Buffer, end: number): HeaderInfo {
    const header: HeaderInfo = {};
    for (const line of buf.subarray(0, end).toString('latin1').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) {
            const key = line.slice(0, eq).trim();
            const value = line.slice(eq + 1).trim();
            switch (key) {
                case 'SENC Version':
                    header.sencVersion = Number(value);
                    break;
                case 'NAME':
                    header.cellName = value;
                    break;
                case 'DATE000':
                    header.publishDate = value;
                    break;
                case 'EDTN000':
                    header.cellEdition = Number(value);
                    break;
                case 'DATEUPD':
                    header.updateDate = value;
                    break;
                case 'UPDT':
                    header.update = Number(value);
                    break;
                case 'SCALE':
                    header.nativeScale = Number(value);
                    break;
            }
            continue;
        }
        if (line.startsWith('Chart Extents:')) {
            // "Chart Extents: <eLon> <wLon> <nLat> <sLat>" — east before west,
            // north before south, matching OCPNsenc's write order. Min/max
            // rather than positional so a writer that swaps them still works.
            const [a, b, c, d] = line.slice(14).trim().split(/\s+/).map(Number);
            if ([a, b, c, d].every(Number.isFinite)) {
                header.cellExtent = {
                    eLon: Math.max(a, b),
                    wLon: Math.min(a, b),
                    nLat: Math.max(c, d),
                    sLat: Math.min(c, d),
                };
                header.refMerc = latLonToMerc(
                    (header.cellExtent.nLat + header.cellExtent.sLat) / 2,
                    (header.cellExtent.eLon + header.cellExtent.wLon) / 2,
                );
            }
        }
    }
    return header;
}

/**
 * Read the shared edge table.
 *
 * Layout after `VETableStart\n`, repeating until an index of -1:
 *   int32 edgeIndex, int32 pointCount, pointCount × (double x, double y)
 *
 * Note the doubles: unlike the binary SENC format's float32 edge vertices,
 * this dialect stores full precision here.
 */
function parseEdgeTable(buf: Buffer, start: number): EdgeTable {
    const table: EdgeTable = new Map();
    let off = start;
    while (off + 8 <= buf.length) {
        const index = buf.readInt32LE(off);
        if (index === TABLE_END) break;
        const count = buf.readInt32LE(off + 4);
        off += 8;
        if (count < 0 || off + count * 16 > buf.length) break;
        const points: [number, number][] = [];
        for (let p = 0; p < count; p += 1) {
            points.push([buf.readDoubleLE(off + p * 16), buf.readDoubleLE(off + p * 16 + 8)]);
        }
        off += count * 16;
        table.set(index, points);
    }
    return table;
}

/**
 * Read the shared connected-node table.
 *
 * Layout after `VCTableStart\n`, repeating until an index of -1:
 *   int32 nodeIndex, double x, double y
 */
function parseNodeTable(buf: Buffer, start: number): NodeTable {
    const table: NodeTable = new Map();
    let off = start;
    while (off + 4 <= buf.length) {
        const index = buf.readInt32LE(off);
        if (index === TABLE_END) break;
        off += 4;
        if (off + 16 > buf.length) break;
        table.set(index, [buf.readDoubleLE(off), buf.readDoubleLE(off + 8)]);
        off += 16;
    }
    return table;
}

/**
 * Decode the triangle primitives inside one PolyTessGeo block.
 *
 * Layout after the `POLYTESSGEO` line, all within `nrecl` bytes:
 *   "  POLYTESSGEOPROP xmin ymin xmax ymax\n"
 *   "Contours/nWKB <nContours> <contourBytes>\n"
 *   "Contour nV <v1> <v2> ...\n"
 *   <contourBytes + 1 bytes of contour geometry — unused here>
 *   repeated: int32 type, int32 nVert, nVert*2 float32 SM pairs, 4 doubles bbox
 *   terminated by an int32 reading as "POLY"
 *
 * The contour block is skipped deliberately: in simple-mercator SENC it is a
 * 16-byte stub, and the triangles carry the actual shape.
 */
function parseTriangles(block: Buffer, refMerc: MercXY): [[number, number], [number, number], [number, number]][] {
    // Header lines are located on the raw buffer, not through a fixed-size
    // text window: the "Contour nV" line grows by one token per contour, so
    // on a many-holed polygon it can run to kilobytes and any cap silently
    // discards the whole feature.
    const contoursLine = block.indexOf('Contours/nWKB');
    if (contoursLine < 0) return [];
    const contoursEnd = block.indexOf(0x0a, contoursLine);
    if (contoursEnd < 0) return [];
    const contourBytes = Number(block.subarray(contoursLine, contoursEnd).toString('latin1').trim().split(/\s+/)[2]);
    if (!Number.isFinite(contourBytes)) return [];

    const nvLine = block.indexOf('Contour nV', contoursEnd);
    if (nvLine < 0) return [];
    const nvEnd = block.indexOf(0x0a, nvLine);
    if (nvEnd < 0) return [];

    let offset = nvEnd + 1 + contourBytes + 1;
    const triangles: [[number, number], [number, number], [number, number]][] = [];

    while (offset + 8 <= block.length) {
        const triType = block.readInt32LE(offset);
        if (triType === POLYEND_SENTINEL) break;
        const nVert = block.readInt32LE(offset + 4);
        if (!TRI_TYPES.has(triType) || nVert < 3) break;

        offset += 8;
        const vertexBytes = nVert * 2 * 4;
        if (offset + vertexBytes + 32 > block.length) break;

        const pts: [number, number][] = [];
        for (let v = 0; v < nVert; v += 1) {
            const smX = block.readFloatLE(offset + v * 8);
            const smY = block.readFloatLE(offset + v * 8 + 4);
            const { lat, lon } = smVertexToLatLon(smX, smY, refMerc);
            pts.push([lon, lat]);
        }
        offset += vertexBytes + 32; // vertices, then the per-primitive lat/lon bbox

        // Fan out strips and fans into discrete triangles so downstream code
        // never has to know which primitive mode produced them. Strip
        // expansion alternates vertex order per GL semantics (matching
        // featureParser.parseAreaTriangles) so winding stays consistent.
        if (triType === 4) {
            for (let i = 0; i + 2 < nVert; i += 3) triangles.push([pts[i], pts[i + 1], pts[i + 2]]);
        } else if (triType === 5) {
            for (let i = 0; i + 2 < nVert; i += 1) {
                if (i % 2 === 0) triangles.push([pts[i], pts[i + 1], pts[i + 2]]);
                else triangles.push([pts[i + 1], pts[i], pts[i + 2]]);
            }
        } else {
            for (let i = 1; i + 1 < nVert; i += 1) triangles.push([pts[0], pts[i], pts[i + 1]]);
        }
    }
    return triangles;
}

/**
 * Rebuild a line feature's vertices from the shared vector tables.
 *
 * The `LINESTRING` blob that precedes `LSINDEXLIST` looks like WKB and states
 * a vertex count, but its coordinate array is uninitialised heap memory in
 * OCPNsenc's output — measured here as high-entropy bytes that decode to
 * values like 4.8e34 while the trailing bounding box in the same blob decodes
 * correctly. The plugin never reads that array either (`AssembleLineGeometry`
 * walks the tables instead), so we ignore it and use only the recorded extent,
 * which is real and serves as a per-feature correctness check.
 *
 * Each `LSINDEXLIST` entry is four int32s: start node, edge, end node,
 * direction (reference convention: 1 == forward, anything else == reverse —
 * s63chart.cpp TYPE_CE/TYPE_EC both test `dir == 1`).
 *
 * S-57 chain-node topology makes consecutive entries share a node — entry
 * i's end node index is entry i+1's start node index — but a feature may
 * legitimately map DISJOINT edge runs (measured: 70 of 1158 line features on
 * FR466870). OpenCPN renders every segment independently so it never bridges
 * such a gap; concatenating across one would draw a chord through water (or
 * land) the chart never asserted. A continuity break therefore starts a new
 * part, and the caller emits multi-part results as MultiLineString.
 *
 * Corruption is different from discontinuity: a nonzero node/edge index
 * missing from its table means the SENC is damaged (the reference nulls those
 * out and draws nothing), so the whole feature is unusable — return null and
 * let the caller count it. Wrong geometry is worse than no geometry in a
 * navigation pipeline.
 *
 * Edge orientation is decided by both endpoints when both nodes resolve
 * (whichever orientation minimises the summed head/tail mismatch), by the
 * start node alone when only it exists, and by the direction flag last
 * (reference convention: 1 == forward). The geometric test is
 * self-validating where the flag is only a convention.
 */
function assembleLine(
    entries: Buffer,
    segmentCount: number,
    edges: EdgeTable,
    nodes: NodeTable,
    refMerc: MercXY,
): [number, number][][] | null {
    const parts: [number, number][][] = [];
    let coords: [number, number][] = [];
    const push = (sm: [number, number]) => {
        const { lat, lon } = smVertexToLatLon(sm[0], sm[1], refMerc);
        const last = coords[coords.length - 1];
        if (last && last[0] === lon && last[1] === lat) return;
        coords.push([lon, lat]);
    };
    const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

    let previousEndIndex: number | null = null;

    for (let i = 0; i < segmentCount; i += 1) {
        const off = i * 16;
        if (off + 16 > entries.length) return null;
        const startIndex = entries.readInt32LE(off);
        const edgeIndex = Math.abs(entries.readInt32LE(off + 4));
        const endIndex = entries.readInt32LE(off + 8);
        const direction = entries.readInt32LE(off + 12);

        // Continuity break → close the current part, start the next. Index 0
        // is the writer's "no node" sentinel and cannot vouch for continuity.
        if (i > 0 && (previousEndIndex === null || startIndex === 0 || startIndex !== previousEndIndex)) {
            if (coords.length >= 2) parts.push(coords);
            coords = [];
        }
        previousEndIndex = endIndex !== 0 ? endIndex : null;

        const startNode = startIndex !== 0 ? nodes.get(startIndex) : undefined;
        const endNode = endIndex !== 0 ? nodes.get(endIndex) : undefined;
        const edge = edgeIndex !== 0 ? edges.get(edgeIndex) : undefined;
        // A nonzero index that fails to resolve is corruption, not absence.
        if ((startIndex !== 0 && !startNode) || (endIndex !== 0 && !endNode) || (edgeIndex !== 0 && !edge)) {
            return null;
        }

        if (startNode) push(startNode);
        if (edge && edge.length > 0) {
            const head = edge[0];
            const tail = edge[edge.length - 1];
            let forward: boolean;
            if (startNode && endNode) {
                forward = dist(head, startNode) + dist(tail, endNode) <= dist(tail, startNode) + dist(head, endNode);
            } else if (startNode) {
                forward = dist(head, startNode) <= dist(tail, startNode);
            } else if (endNode) {
                forward = dist(tail, endNode) <= dist(head, endNode);
            } else {
                forward = direction === 1;
            }
            if (forward) {
                for (const p of edge) push(p);
            } else {
                for (let p = edge.length - 1; p >= 0; p -= 1) push(edge[p]);
            }
        }
        if (endNode) push(endNode);
    }
    if (coords.length >= 2) parts.push(coords);
    return parts;
}

function extentOf(pts: [number, number][]): { sLat: number; nLat: number; wLon: number; eLon: number } {
    let sLat = Infinity,
        nLat = -Infinity,
        wLon = Infinity,
        eLon = -Infinity;
    for (const [lon, lat] of pts) {
        if (lat < sLat) sLat = lat;
        if (lat > nLat) nLat = lat;
        if (lon < wLon) wLon = lon;
        if (lon > eLon) eLon = lon;
    }
    return { sLat, nLat, wLon, eLon };
}

/**
 * Tolerance for accepting a rebuilt line against the extent the chart
 * recorded. The recorded box is float32 lat/lon; 2e-4° (~20 m) sits well
 * above that rounding and well below any real assembly error, which shows up
 * as whole segments in the wrong place.
 */
const BBOX_TOLERANCE_DEG = 2e-4;

function extentMatches(
    actual: { sLat: number; nLat: number; wLon: number; eLon: number },
    recorded: { sLat: number; nLat: number; wLon: number; eLon: number },
): boolean {
    return (
        Math.abs(actual.eLon - recorded.eLon) < BBOX_TOLERANCE_DEG &&
        Math.abs(actual.wLon - recorded.wLon) < BBOX_TOLERANCE_DEG &&
        Math.abs(actual.nLat - recorded.nLat) < BBOX_TOLERANCE_DEG &&
        Math.abs(actual.sLat - recorded.sLat) < BBOX_TOLERANCE_DEG
    );
}

interface FeatureContext {
    codes: Map<string, number>;
    edges: EdgeTable;
    nodes: NodeTable;
    skipped: Record<string, number>;
    stats: ParsedS63Senc['stats'];
}

/** Parse one `OGRFeature(...)` block. Returns null if the class is unknown. */
function parseFeatureBlock(block: Buffer, index: number, ctx: FeatureContext): SencFeature | null {
    // Text and binary are interleaved, so decode as latin1 (byte-preserving)
    // and index by byte offset throughout.
    const text = block.toString('latin1');

    const nameEnd = text.indexOf(')');
    const acronym = text.slice(FEATURE_MARKER.length, nameEnd);
    const classCode = ctx.codes.get(acronym);
    if (classCode === undefined) {
        ctx.stats.unknownClasses[acronym] = (ctx.stats.unknownClasses[acronym] ?? 0) + 1;
        return null;
    }

    // The header states the writer's own feature index ("OGRFeature(X):NNNN")
    // — keep it so a feature can be traced back to the SENC and stays stable
    // if a block ever fails to parse. The scan ordinal is only a fallback.
    const headerRcid = /^:(\d+)/.exec(text.slice(nameEnd + 1));
    const rcid = headerRcid ? Number(headerRcid[1]) : index;

    const attributes: Record<string, AttributeValue> = {};
    let primitive = 0;

    const attrRe = /\n {2}([A-Z0-9_]+) \(([IRS])\) = (.*)/g;
    attrRe.lastIndex = nameEnd;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(text)) !== null) {
        const [, key, typeTag, raw] = m;
        if (key === 'PRIM') primitive = Number(raw.trim());
        if (INTERNAL_ATTRIBUTES.has(key)) continue;
        attributes[key] = parseAttributeValue(typeTag, raw);
    }

    const feature: SencFeature = { classCode, acronym, rcid, primitive, attributes, geometry: null };

    if (primitive === PRIM_POINT) {
        // Soundings are the one class carrying many points per feature; both
        // forms name their reference point the same way.
        const mp = MULTIPOINT_RE.exec(text);
        if (mp) {
            const refMerc = latLonToMerc(Number(mp[1]), Number(mp[2]));
            const start = mp.index + mp[0].length;
            // byte order (1) + WKB type (4) + point count (4), then each point
            // as float32 x, y, depth. Trailing float32 bbox is ignored.
            if (start + 9 <= block.length) {
                const count = block.readInt32LE(start + 5);
                const coords: [number, number, number][] = [];
                let off = start + 9;
                for (let p = 0; p < count && off + 12 <= block.length; p += 1, off += 12) {
                    const { lat, lon } = smVertexToLatLon(block.readFloatLE(off), block.readFloatLE(off + 4), refMerc);
                    coords.push([lon, lat, block.readFloatLE(off + 8)]);
                }
                if (coords.length > 0) {
                    feature.geometry = {
                        type: 'MultiPoint',
                        coordinates: coords,
                        extent: extentOf(coords.map(([lon, lat]) => [lon, lat])),
                    };
                }
            }
        } else {
            // "  POINT <refLat> <refLon>\n  <wkbLen>\n" then a WKB point whose
            // coordinates are SM metre offsets from that reference point.
            const pm = POINT_RE.exec(text);
            if (pm) {
                const refMerc = latLonToMerc(Number(pm[1]), Number(pm[2]));
                const wkbStart = pm.index + pm[0].length;
                if (wkbStart + 21 <= block.length) {
                    const { lat, lon } = smVertexToLatLon(
                        block.readDoubleLE(wkbStart + 5),
                        block.readDoubleLE(wkbStart + 13),
                        refMerc,
                    );
                    feature.geometry = { type: 'Point', coordinates: [lon, lat] };
                }
            }
        }
    } else if (primitive === PRIM_LINE) {
        const lm = LINESTRING_RE.exec(text);
        const sm = /LSINDEXLIST (\d+)\n/.exec(text);
        if (lm && sm) {
            const refMerc = latLonToMerc(Number(lm[1]), Number(lm[2]));
            const blobEnd = lm.index + lm[0].length + Number(lm[3]);
            const segmentCount = Number(sm[1]);
            const entriesStart = sm.index + sm[0].length;
            const chains = assembleLine(
                block.subarray(entriesStart, entriesStart + segmentCount * 16),
                segmentCount,
                ctx.edges,
                ctx.nodes,
                refMerc,
            );
            if (chains === null) {
                ctx.stats.linesStructuralBreak += 1;
            } else if (chains.length > 0) {
                const extent = extentOf(chains.flat());
                // The blob's trailing 4 float32s are xmax, xmin, ymax, ymin —
                // the chart's own statement of where this line lies. A rebuilt
                // line that contradicts it is proven wrong, and wrong geometry
                // must never reach a navigation consumer: withhold it and let
                // the caller's mismatch count flag the cell for investigation.
                let verified = true;
                if (blobEnd <= block.length && blobEnd >= 16) {
                    const recorded = {
                        eLon: block.readFloatLE(blobEnd - 16),
                        wLon: block.readFloatLE(blobEnd - 12),
                        nLat: block.readFloatLE(blobEnd - 8),
                        sLat: block.readFloatLE(blobEnd - 4),
                    };
                    verified = extentMatches(extent, recorded);
                    if (verified) ctx.stats.linesBboxVerified += 1;
                    else ctx.stats.linesBboxMismatch += 1;
                }
                if (verified) {
                    if (chains.length === 1) {
                        feature.geometry = { type: 'Line', coordinates: chains[0], extent };
                    } else {
                        ctx.stats.linesMultiPart += 1;
                        feature.geometry = { type: 'MultiLine', parts: chains, extent };
                    }
                }
            }
        }
    } else if (primitive === PRIM_AREA) {
        // "  POLYTESSGEO  <nrecl> <refLat> <refLon>\n" then nrecl bytes.
        const gm = POLYTESSGEO_RE.exec(text);
        if (gm) {
            const nrecl = Number(gm[1]);
            const refMerc = latLonToMerc(Number(gm[2]), Number(gm[3]));
            const start = gm.index + gm[0].length;
            const triangles = parseTriangles(block.subarray(start, start + nrecl), refMerc);
            if (triangles.length > 0) {
                // Recover the outline from the mesh. A SENC has no edge-vector
                // index for us to walk (the oeSENC path in featureParser uses
                // one; S-63 ships none), so the triangles are all we have —
                // but they are enough: cancelling interior edges leaves
                // exactly the boundary. Without this, every area feature
                // reaches the app as raw triangles (FR466870: 101,033 of them
                // for DEPARE alone) and renders as shattered, streaky water.
                //
                // meshToPolygons fails CLOSED — null keeps the triangles, so a
                // mesh it cannot resolve degrades to today's behaviour rather
                // than to a wrongly-shaped depth area.
                const polygons = meshToPolygons(triangles) ?? undefined;
                if (polygons) ctx.stats.areasWithPolygons++;
                else ctx.stats.areasMeshFallback++;
                feature.geometry = {
                    type: 'Area',
                    triangles,
                    polygons,
                    extent: extentOf(triangles.flat()),
                };
            }
        }
    }

    if (!feature.geometry && primitive > 0) {
        ctx.skipped[acronym] = (ctx.skipped[acronym] ?? 0) + 1;
    }
    return feature;
}

export function parseS63Senc(buf: Buffer): ParsedS63Senc {
    const stats: ParsedS63Senc['stats'] = {
        edgeCount: 0,
        nodeCount: 0,
        linesBboxVerified: 0,
        linesBboxMismatch: 0,
        linesStructuralBreak: 0,
        linesMultiPart: 0,
        areasWithPolygons: 0,
        areasMeshFallback: 0,
        unknownClasses: {},
    };
    const skippedGeometry: Record<string, number> = {};

    // Both vector tables sit after the last feature. Read them first — line
    // features are meaningless without them.
    const veStart = buf.indexOf(VE_TABLE_MARKER);
    const vcStart = buf.indexOf(VC_TABLE_MARKER);
    const edges = veStart === -1 ? new Map() : parseEdgeTable(buf, veStart + VE_TABLE_MARKER.length);
    const nodes = vcStart === -1 ? new Map() : parseNodeTable(buf, vcStart + VC_TABLE_MARKER.length);
    stats.edgeCount = edges.size;
    stats.nodeCount = nodes.size;

    // Feature blocks are delimited by the marker itself. Scanning for it
    // rather than walking every record keeps a feature whose geometry we
    // can't decode from desynchronising everything after it. Bound the search
    // at the vector tables so their binary can't be mistaken for a feature.
    const featureRegionEnd = veStart === -1 ? buf.length : veStart;
    const starts: number[] = [];
    for (
        let at = buf.indexOf(FEATURE_MARKER);
        at !== -1 && at < featureRegionEnd;
        at = buf.indexOf(FEATURE_MARKER, at + 1)
    ) {
        starts.push(at);
    }
    if (starts.length === 0) {
        return { header: parseHeader(buf, featureRegionEnd), features: [], skippedGeometry, stats };
    }

    const ctx: FeatureContext = { codes: acronymToCode(), edges, nodes, skipped: skippedGeometry, stats };
    const header = parseHeader(buf, starts[0]);
    const features: SencFeature[] = [];
    for (let i = 0; i < starts.length; i += 1) {
        const end = i + 1 < starts.length ? starts[i + 1] : featureRegionEnd;
        const feature = parseFeatureBlock(buf.subarray(starts[i], end), i, ctx);
        if (feature) features.push(feature);
    }
    return { header, features, skippedGeometry, stats };
}
