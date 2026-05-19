import { BinaryReader, RECORD_HEADER_SIZE, readRecordHeader } from './binaryReader.js';
import { latLonToMerc, MercXY, smVertexToLatLon } from './mercator.js';
import { RecordType } from './recordTypes.js';
import { classRecord } from './s57Classes.js';
import { attributeAcronym } from './s57Attributes.js';

export type Primitive = 'point' | 'line' | 'area' | 'multipoint' | 'unknown';

export interface PointGeometry {
    type: 'Point';
    /** lon, lat (GeoJSON convention) */
    coordinates: [number, number];
}

export interface MultiPointGeometry {
    type: 'MultiPoint';
    /** lon, lat, depth */
    coordinates: [number, number, number][];
    extent?: { sLat: number; nLat: number; wLon: number; eLon: number };
}

/**
 * AREA geometry.
 *
 * Always populated with `triangles` — a flat list from the SENC triangulation
 * primitives. Each triangle is small, correct, self-contained, and rasterises
 * cleanly into the inshore router's land/water mask without ever bridging open
 * water. This is the safety net: even if polygon-outline reconstruction fails,
 * the router has a usable shape.
 *
 * Optionally populated with `rings` — closed polygon rings assembled by an
 * Eulerian walk of the chart's edge-vector + connected-node graph. When
 * present, GeoJSON emission prefers these (clean polygon strokes, much smaller
 * output, suitable for Mapbox `fill-outline-color`). When the walk produces
 * a degenerate result (orphan edges, odd-degree nodes, etc.) the field is
 * left undefined and the emitter falls back to triangle output for that
 * feature individually.
 */
export interface AreaGeometry {
    type: 'Area';
    triangles: [[number, number], [number, number], [number, number]][];
    rings?: [number, number][][];
    extent: { sLat: number; nLat: number; wLon: number; eLon: number };
}

/** Edge-vector index data needed to attempt polygon-outline reconstruction in pass 2. */
interface AreaEdgesRaw {
    edgeIndicesRaw: Buffer;
    edgeVectorCount: number;
    stride: 3 | 4;
}

/**
 * LINE geometry resolved into [lon, lat] coordinates.
 *
 * S-57 lines are topology-encoded: the feature's record stores indices into
 * shared edge and connected-node tables, which are decoded in a second pass
 * once those tables have been read.
 */
export interface LineGeometry {
    type: 'Line';
    coordinates: [number, number][];
    extent: { sLat: number; nLat: number; wLon: number; eLon: number };
}

/** Intermediate form retained between record-walk and table-resolve passes. */
export interface LineGeometryRaw {
    type: 'LineRaw';
    extent: { sLat: number; nLat: number; wLon: number; eLon: number };
    edgeVectorCount: number;
    rawIndices: Buffer;
    /** SENC version determines whether each edge entry has 3 or 4 int32 fields. */
    stride: 3 | 4;
}

export type FeatureGeometry = PointGeometry | MultiPointGeometry | AreaGeometry | LineGeometry | LineGeometryRaw;

interface EdgeEntry {
    /** Intermediate vertices in [lon, lat] (excludes the connected-node endpoints). */
    points: [number, number][];
}

interface ConnectedNodeEntry {
    coord: [number, number]; // [lon, lat]
}

export interface SencFeature {
    classCode: number;
    acronym: string;
    rcid: number;
    primitive: number;
    attributes: Record<string, AttributeValue>;
    geometry: FeatureGeometry | null;
}

export type AttributeValue = number | string | boolean | null;

export interface HeaderInfo {
    sencVersion?: number;
    cellName?: string;
    publishDate?: string;
    cellEdition?: number;
    updateDate?: string;
    update?: number;
    nativeScale?: number;
    sencCreateDate?: string;
    soundingDatum?: string;
    cellExtent?: { sLat: number; nLat: number; wLon: number; eLon: number };
    /** Reference point in absolute mercator metres; midpoint of cell extent. */
    refMerc?: MercXY;
}

export interface ParseOptions {
    includeOrphans?: boolean;
    limit?: number;
}

export interface ParseResult {
    header: HeaderInfo;
    features: SencFeature[];
    stats: {
        totalRecords: number;
        featuresByClass: Map<string, number>;
        geometriesByPrimitive: Record<Primitive, number>;
        triPrimitiveTypes: Map<number, number>;
        unknownAttrCodes: Set<number>;
        /** record-type code → count of records the parser had no case for */
        unknownRecordCounts: Map<number, number>;
        linesResolved?: number;
        linesUnresolvable?: number;
        areasWithRings?: number;
        areasRingFallback?: number;
    };
}

const ATTR_VALUE_TYPE_UINT32 = 0;
const ATTR_VALUE_TYPE_DOUBLE = 2;
const ATTR_VALUE_TYPE_STRING = 4;

// SENC AREA records ship pre-computed triangulation primitives for OpenGL
// rendering (GL_TRIANGLES=4, GL_TRIANGLE_STRIP=5, GL_TRIANGLE_FAN=6). We walk
// past them in the extractor — polygon-outline reconstruction via edges
// is what the router and renderer need. The triType byte is still counted
// in stats.triPrimitiveTypes for diagnostics.

export function parseSenc(buf: Buffer, opts: ParseOptions = {}): ParseResult {
    const reader = new BinaryReader(buf);
    const features: SencFeature[] = [];
    const header: HeaderInfo = {};
    const stats: ParseResult['stats'] = {
        totalRecords: 0,
        featuresByClass: new Map(),
        geometriesByPrimitive: { point: 0, line: 0, area: 0, multipoint: 0, unknown: 0 },
        triPrimitiveTypes: new Map(),
        unknownAttrCodes: new Set(),
        unknownRecordCounts: new Map(),
    };

    const edgeTable = new Map<number, EdgeEntry>();
    const connectedNodeTable = new Map<number, ConnectedNodeEntry>();
    // Side-table of AREA features → raw edge bytes. Filled during the walk,
    // drained in the post-walk Eulerian pass once the vector tables are loaded.
    const pendingAreaEdges = new Map<SencFeature, AreaEdgesRaw>();

    let current: SencFeature | null = null;

    const flush = () => {
        if (!current) return;
        if (current.geometry || opts.includeOrphans) {
            features.push(current);
            stats.featuresByClass.set(current.acronym, (stats.featuresByClass.get(current.acronym) ?? 0) + 1);
        }
        current = null;
    };

    while (reader.remaining() >= RECORD_HEADER_SIZE) {
        if (opts.limit && features.length >= opts.limit) break;

        const recHeader = readRecordHeader(reader);
        if (recHeader.recordLength < RECORD_HEADER_SIZE) break;
        const payloadLen = recHeader.recordLength - RECORD_HEADER_SIZE;
        if (payloadLen > reader.remaining()) break;
        const payload = buf.subarray(reader.position(), reader.position() + payloadLen);
        reader.skip(payloadLen);
        stats.totalRecords += 1;

        switch (recHeader.type) {
            case RecordType.HEADER_SENC_VERSION:
                if (payload.length >= 2) header.sencVersion = payload.readUInt16LE(0);
                break;
            case RecordType.HEADER_CELL_NAME:
                header.cellName = readNullTerminated(payload);
                break;
            case RecordType.HEADER_CELL_PUBLISHDATE:
                header.publishDate = readNullTerminated(payload);
                break;
            case RecordType.HEADER_CELL_EDITION:
                if (payload.length >= 2) header.cellEdition = payload.readUInt16LE(0);
                break;
            case RecordType.HEADER_CELL_UPDATEDATE:
                header.updateDate = readNullTerminated(payload);
                break;
            case RecordType.HEADER_CELL_UPDATE:
                if (payload.length >= 2) header.update = payload.readUInt16LE(0);
                break;
            case RecordType.HEADER_CELL_NATIVESCALE:
                if (payload.length >= 4) header.nativeScale = payload.readUInt32LE(0);
                break;
            case RecordType.HEADER_CELL_SENCCREATEDATE:
                header.sencCreateDate = readNullTerminated(payload);
                break;
            case RecordType.HEADER_CELL_SOUNDINGDATUM:
                header.soundingDatum = readNullTerminated(payload);
                break;

            case RecordType.CELL_EXTENT_RECORD:
                if (payload.length >= 64) {
                    // SW, NW, NE, SE corners — each as (lat, lon) double pair, 64 bytes total.
                    const swLat = payload.readDoubleLE(0);
                    const swLon = payload.readDoubleLE(8);
                    const nwLat = payload.readDoubleLE(16);
                    const neLat = payload.readDoubleLE(32);
                    const neLon = payload.readDoubleLE(40);
                    const sLat = Math.min(swLat, neLat);
                    const nLat = Math.max(nwLat, neLat);
                    const wLon = Math.min(swLon, neLon);
                    const eLon = Math.max(swLon, neLon);
                    header.cellExtent = { sLat, nLat, wLon, eLon };
                    header.refMerc = latLonToMerc((sLat + nLat) / 2, (wLon + eLon) / 2);
                }
                break;

            case RecordType.FEATURE_ID_RECORD: {
                flush();
                if (payload.length < 5) break;
                const classCode = payload.readUInt16LE(0);
                const rcid = payload.readUInt16LE(2);
                const primitive = payload.readUInt8(4);
                const acronym = classRecord(classCode)?.acronym ?? `?${classCode}`;
                current = { classCode, acronym, rcid, primitive, attributes: {}, geometry: null };
                break;
            }

            case RecordType.FEATURE_ATTRIBUTE_RECORD: {
                if (!current || payload.length < 3) break;
                const attrCode = payload.readUInt16LE(0);
                const valueType = payload.readUInt8(2);
                const acronym = attributeAcronym(attrCode);
                if (acronym.startsWith('_attr')) stats.unknownAttrCodes.add(attrCode);
                let value: AttributeValue = null;
                if (valueType === ATTR_VALUE_TYPE_UINT32 && payload.length >= 7) {
                    value = payload.readUInt32LE(3);
                } else if (valueType === ATTR_VALUE_TYPE_DOUBLE && payload.length >= 11) {
                    value = payload.readDoubleLE(3);
                } else if (valueType === ATTR_VALUE_TYPE_STRING) {
                    value = readNullTerminated(payload.subarray(3));
                }
                current.attributes[acronym] = value;
                break;
            }

            case RecordType.FEATURE_GEOMETRY_RECORD_POINT: {
                if (!current || payload.length < 16) break;
                const lat = payload.readDoubleLE(0);
                const lon = payload.readDoubleLE(8);
                current.geometry = { type: 'Point', coordinates: [lon, lat] };
                stats.geometriesByPrimitive.point += 1;
                break;
            }

            case RecordType.FEATURE_GEOMETRY_RECORD_MULTIPOINT: {
                if (!current || payload.length < 36 || !header.refMerc) break;
                const sLat = payload.readDoubleLE(0);
                const nLat = payload.readDoubleLE(8);
                const wLon = payload.readDoubleLE(16);
                const eLon = payload.readDoubleLE(24);
                const pointCount = payload.readUInt32LE(32);
                const STRIDE = 12; // x:f32 + y:f32 + depth:f32
                const coords: [number, number, number][] = [];
                if (payload.length >= 36 + pointCount * STRIDE) {
                    for (let i = 0; i < pointCount; i++) {
                        const off = 36 + i * STRIDE;
                        const x = payload.readFloatLE(off);
                        const y = payload.readFloatLE(off + 4);
                        const depth = payload.readFloatLE(off + 8);
                        const ll = smVertexToLatLon(x, y, header.refMerc);
                        coords.push([ll.lon, ll.lat, depth]);
                    }
                }
                current.geometry = {
                    type: 'MultiPoint',
                    coordinates: coords,
                    extent: { sLat, nLat, wLon, eLon },
                };
                stats.geometriesByPrimitive.multipoint += 1;
                break;
            }

            case RecordType.FEATURE_GEOMETRY_RECORD_LINE: {
                if (!current || payload.length < 36) break;
                const sLat = payload.readDoubleLE(0);
                const nLat = payload.readDoubleLE(8);
                const wLon = payload.readDoubleLE(16);
                const eLon = payload.readDoubleLE(24);
                const edgeVectorCount = payload.readUInt32LE(32);
                const indicesBuf = Buffer.from(payload.subarray(36));
                // SENC writers vary on edge-entry stride: 3 ints (idx,start,end) or
                // 4 ints (idx,start,end,fwdFlag). wellenvogel uses sencVersion > 200 as
                // the discriminator for o-charts .oesu, but OpenCPN's local SENC cache
                // ships stride=3 at the same version — auto-detect from buffer width.
                let stride: 3 | 4 = 3;
                if (edgeVectorCount > 0) {
                    const perEdge = indicesBuf.length / edgeVectorCount;
                    if (perEdge === 16) stride = 4;
                    else if (perEdge !== 12) {
                        // Unrecognised stride — keep as 3 and let resolveLineGeometry bail.
                        stride = 3;
                    }
                }
                current.geometry = {
                    type: 'LineRaw',
                    extent: { sLat, nLat, wLon, eLon },
                    edgeVectorCount,
                    rawIndices: indicesBuf,
                    stride,
                };
                stats.geometriesByPrimitive.line += 1;
                break;
            }

            case RecordType.VECTOR_EDGE_NODE_TABLE_RECORD: {
                if (!header.refMerc) break;
                parseEdgeTable(payload, header.refMerc, edgeTable, 1, 0);
                break;
            }

            case RecordType.VECTOR_CONNECTED_NODE_TABLE_RECORD: {
                if (!header.refMerc) break;
                parseConnectedNodeTable(payload, header.refMerc, connectedNodeTable, 1, 0);
                break;
            }

            case RecordType.VECTOR_EDGE_NODE_TABLE_EXT_RECORD: {
                // V3+ EXT variant: header is { scaleFactor: double, numEntries: int },
                // payload identical to type 96 but per-vertex coords scaled by
                // 1/scaleFactor. See Osenc.h:OSENC_VectorTableExtRecordPayload.
                if (!header.refMerc || payload.length < 12) break;
                const scaleFactor = payload.readDoubleLE(0);
                parseEdgeTable(payload, header.refMerc, edgeTable, scaleFactor, 8);
                break;
            }

            case RecordType.VECTOR_CONNECTED_NODE_TABLE_EXT_RECORD: {
                if (!header.refMerc || payload.length < 12) break;
                const scaleFactor = payload.readDoubleLE(0);
                parseConnectedNodeTable(payload, header.refMerc, connectedNodeTable, scaleFactor, 8);
                break;
            }

            case RecordType.FEATURE_GEOMETRY_RECORD_AREA: {
                if (!current || payload.length < 44 || !header.refMerc) break;
                const parsed = parseAreaTriangles(payload, header.refMerc, stats, 1, 44);
                if (parsed) {
                    current.geometry = parsed.geometry;
                    stats.geometriesByPrimitive.area += 1;
                    if (parsed.edges) {
                        // The feature index inside `features` becomes its own
                        // identity once flush() lands it; we use a placeholder
                        // numeric key now (current.rcid * classCode) and
                        // back-fill the real array index in the second pass.
                        pendingAreaEdges.set(current, parsed.edges);
                    }
                }
                break;
            }

            case RecordType.FEATURE_GEOMETRY_RECORD_AREA_EXT: {
                // V3+ "extended" AREA record. Same first 44 bytes as type 82
                // (extent + contour_count + triprim_count + edgeVector_count),
                // then 8 bytes of `scaleFactor: double`, then the triprim
                // payload at offset 52. Per-vertex coordinates are divided by
                // `scaleFactor` before mercator → lat/lon conversion.
                //
                // See reference Osenc.h _OSENC_AreaGeometryExt_Record_Payload
                // and OESUChart.cpp parseAreaRecord<…,true>.
                if (!current || payload.length < 52 || !header.refMerc) break;
                const scaleFactor = payload.readDoubleLE(44);
                const parsed = parseAreaTriangles(payload, header.refMerc, stats, scaleFactor, 52);
                if (parsed) {
                    current.geometry = parsed.geometry;
                    stats.geometriesByPrimitive.area += 1;
                    if (parsed.edges) {
                        pendingAreaEdges.set(current, parsed.edges);
                    }
                }
                break;
            }

            default:
                // VECTOR_EDGE_NODE_TABLE_RECORD (96), VECTOR_CONNECTED_NODE_TABLE_RECORD (97),
                // CELL_COVR_RECORD (98), CELL_NOCOVR_RECORD (99), CELL_TXTDSC_INFO_FILE_RECORD (101),
                // SERVER_STATUS_RECORD (200) — not consumed for routing extraction.
                // Count what we drop so diagnostics surface unsupported types.
                stats.unknownRecordCounts.set(recHeader.type, (stats.unknownRecordCounts.get(recHeader.type) ?? 0) + 1);
                break;
        }
    }

    flush();

    // Second pass: resolve LineRaw → Line, and attempt Eulerian polygon-outline
    // reconstruction on every AREA feature that captured edge data during the
    // walk. The chart-wide VECTOR_EDGE_NODE_TABLE + VECTOR_CONNECTED_NODE_TABLE
    // come AFTER the feature records, so both passes have to be post-walk.
    let linesResolved = 0;
    let linesUnresolvable = 0;
    let areasWithRings = 0;
    let areasRingFallback = 0;
    for (const f of features) {
        if (f.geometry?.type === 'LineRaw') {
            const resolved = resolveLineGeometry(f.geometry, edgeTable, connectedNodeTable);
            if (resolved) {
                f.geometry = resolved;
                linesResolved += 1;
            } else {
                f.geometry = null;
                linesUnresolvable += 1;
            }
        } else if (f.geometry?.type === 'Area') {
            // Linear-chain ring assembly per reference buildLineGeometries
            // (OESUChart.cpp:692). The SENC stores AREA boundary edges
            // in walk-order around the polygon — successive edges are
            // contiguous in node space (next.startNode == prev.endNode).
            // A discontinuity (next.startNode != prev.endNode) marks the
            // start of a new ring (a hole or a disjoint outer).
            //
            // The Eulerian approach the previous attempt used was wrong on
            // two counts (both fixed 2026-05-19):
            //   (a) buffer field order in LineIndex was swapped — we treated
            //       buffer[0] as the edge index when it's actually the
            //       startNode index. That made the adjacency graph see
            //       every "edge index" as a unique single-use node →
            //       all degree-1 → walker bailed.
            //   (b) direction flag (buffer[3] for V>200) was inverted —
            //       reversed edges were walked forward and vice versa,
            //       so chained rings didn't close.
            // With the field order + direction fixed, the linear-chain
            // walk works directly. No actual Euler walking needed.
            const edges = pendingAreaEdges.get(f);
            if (edges) {
                const rings = resolveAreaRings(edges, edgeTable, connectedNodeTable);
                if (rings && rings.length > 0 && validateRings(rings, f.geometry.extent)) {
                    f.geometry = { ...f.geometry, rings };
                    areasWithRings += 1;
                } else {
                    areasRingFallback += 1;
                }
            } else {
                areasRingFallback += 1;
            }
        }
    }
    stats.linesResolved = linesResolved;
    stats.linesUnresolvable = linesUnresolvable;
    stats.areasWithRings = areasWithRings;
    stats.areasRingFallback = areasRingFallback;

    return { header, features, stats };
}

/**
 * Parse a VECTOR_EDGE_NODE_TABLE record (type 96 — basic) OR its EXT
 * variant (type 85). The EXT record prepends a `scaleFactor: double`
 * to the header and per-vertex coords are divided by scaleFactor
 * before mercator → lat/lon. Pass `scaleFactor=1` for the basic record.
 *
 * Per-entry layout (same for both):
 *   int32 edgeIndex
 *   int32 pointCount
 *   pointCount × (float x, float y)
 */
function parseEdgeTable(
    payload: Buffer,
    refMerc: MercXY,
    out: Map<number, EdgeEntry>,
    scaleFactor: number,
    headerStartOffset: number,
): void {
    if (payload.length < headerStartOffset + 4) return;
    const numEntries = payload.readUInt32LE(headerStartOffset);
    const scale = scaleFactor > 0 ? scaleFactor : 1;
    let off = headerStartOffset + 4;
    for (let i = 0; i < numEntries; i++) {
        if (off + 8 > payload.length) return;
        const edgeIndex = payload.readInt32LE(off);
        const pointCount = payload.readInt32LE(off + 4);
        off += 8;
        if (off + pointCount * 8 > payload.length) return;
        const points: [number, number][] = [];
        for (let p = 0; p < pointCount; p++) {
            const x = payload.readFloatLE(off);
            const y = payload.readFloatLE(off + 4);
            off += 8;
            const ll = smVertexToLatLon(x / scale, y / scale, refMerc);
            points.push([ll.lon, ll.lat]);
        }
        out.set(edgeIndex, { points });
    }
}

/**
 * Parse a VECTOR_CONNECTED_NODE_TABLE record (type 97 — basic) OR its
 * EXT variant (type 86). Same scaleFactor treatment as parseEdgeTable.
 *
 * Per-entry layout:
 *   int32 nodeIndex
 *   float x, float y
 */
function parseConnectedNodeTable(
    payload: Buffer,
    refMerc: MercXY,
    out: Map<number, ConnectedNodeEntry>,
    scaleFactor: number,
    headerStartOffset: number,
): void {
    if (payload.length < headerStartOffset + 4) return;
    const numEntries = payload.readUInt32LE(headerStartOffset);
    const scale = scaleFactor > 0 ? scaleFactor : 1;
    let off = headerStartOffset + 4;
    for (let i = 0; i < numEntries; i++) {
        if (off + 12 > payload.length) return;
        const nodeIndex = payload.readInt32LE(off);
        const x = payload.readFloatLE(off + 4);
        const y = payload.readFloatLE(off + 8);
        off += 12;
        const ll = smVertexToLatLon(x / scale, y / scale, refMerc);
        out.set(nodeIndex, { coord: [ll.lon, ll.lat] });
    }
}

function resolveLineGeometry(
    raw: LineGeometryRaw,
    edgeTable: Map<number, EdgeEntry>,
    connectedNodeTable: Map<number, ConnectedNodeEntry>,
): LineGeometry | null {
    const coords: [number, number][] = [];
    const buf = raw.rawIndices;
    let off = 0;
    const entryBytes = raw.stride * 4;
    if (buf.length < raw.edgeVectorCount * entryBytes) return null;

    const pushCoord = (c: [number, number]) => {
        const last = coords[coords.length - 1];
        if (last && last[0] === c[0] && last[1] === c[1]) return;
        coords.push(c);
    };

    // Per reference S57Object::LineIndex (Osenc.h:185), each edge-vector
    // entry has fields in this order:
    //   buffer[0] = startNode index (into connectedNodeTable)
    //   buffer[1] = edge index (into edgeTable); SIGN bit encodes direction
    //               on V<=200 (legacy); positive on V>200.
    //   buffer[2] = endNode index (into connectedNodeTable)
    //   buffer[3] = direction flag for V>200 ONLY: 0 == forward, !=0 == reverse
    //
    // The previous implementation here had buffer[0] and buffer[1] swapped
    // (treating buffer[0] as edge index, buffer[1] as startNode) AND had
    // the direction logic inverted (treating fwdFlag===0 as reverse).
    // That produced criss-cross COALNE rendering on AU oeSENC charts and
    // made the Eulerian ring walker bail with degree-1 nodes (because
    // every edge looked like a unique "node").
    for (let i = 0; i < raw.edgeVectorCount; i++) {
        const startNode = buf.readInt32LE(off);
        const edgeIdxSigned = buf.readInt32LE(off + 4);
        const endNode = buf.readInt32LE(off + 8);
        const fwdFlag = raw.stride === 4 ? buf.readInt32LE(off + 12) : 0;
        const forward = raw.stride === 4 ? fwdFlag === 0 : edgeIdxSigned >= 0;
        const edgeIdx = edgeIdxSigned >= 0 ? edgeIdxSigned : -edgeIdxSigned;
        off += entryBytes;

        const startCoord = connectedNodeTable.get(startNode);
        const edge = edgeTable.get(edgeIdx);
        const endCoord = connectedNodeTable.get(endNode);

        if (startCoord) pushCoord(startCoord.coord);
        if (edge) {
            if (forward) {
                for (const p of edge.points) pushCoord(p);
            } else {
                for (let p = edge.points.length - 1; p >= 0; p--) pushCoord(edge.points[p]);
            }
        }
        if (endCoord) pushCoord(endCoord.coord);
    }

    if (coords.length < 2) return null;
    return {
        type: 'Line',
        coordinates: coords,
        extent: raw.extent,
    };
}

// OpenGL primitive type values for the triangle blocks shipped in AREA records.
const GL_TRIANGLES = 4;
const GL_TRIANGLE_STRIP = 5;
const GL_TRIANGLE_FAN = 6;

/** Great-circle distance in meters between two lat/lon pairs. */
function haversineLatLonM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_378_137;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Decode an AREA record's triangulation primitives into a flat list of triangles
 * in [lon, lat], AND slice out the trailing edge-vector index entries for
 * second-pass Eulerian ring assembly.
 *
 * Triangles are the safety net — every triangle is self-contained and
 * rasterises correctly for the router's land/water mask. The edge entries are
 * optional input to `resolveAreaRings` for a cleaner polygon-outline overlay;
 * if that walk fails on a feature, the triangles still cover the router.
 */
function parseAreaTriangles(
    payload: Buffer,
    refMerc: MercXY,
    stats: ParseResult['stats'],
    /**
     * For V3+ AREA_EXT (type 84) records, vertex coordinates are divided by
     * `scaleFactor` before mercator→latlon conversion (per OESUChart.cpp:151).
     * For basic AREA (type 82) records pass 1 (no scaling).
     */
    scaleFactor: number,
    /**
     * Offset where the contour-point-counts table begins. Always 44 for type
     * 82 (extent + 3×uint32). For type 84 (EXT) it's 52, because an extra
     * `scaleFactor: double` field is inserted between edgeVector_count and the
     * payload. Reference: Osenc.h _OSENC_AreaGeometryExt_Record_Payload.
     */
    payloadStartOffset: number,
): { geometry: AreaGeometry; edges?: AreaEdgesRaw } | null {
    const scale = scaleFactor > 0 ? scaleFactor : 1;
    const sLat = payload.readDoubleLE(0);
    const nLat = payload.readDoubleLE(8);
    const wLon = payload.readDoubleLE(16);
    const eLon = payload.readDoubleLE(24);
    const contourCount = payload.readUInt32LE(32);
    const triprimCount = payload.readUInt32LE(36);
    const edgeVectorCount = payload.readUInt32LE(40);

    let off = payloadStartOffset;
    off += contourCount * 4; // skip contour-point-counts

    const triangles: AreaGeometry['triangles'] = [];

    for (let i = 0; i < triprimCount; i++) {
        if (off + 1 + 4 + 32 > payload.length) return null;
        const triType = payload.readUInt8(off);
        off += 1;
        const numVerts = payload.readUInt32LE(off);
        off += 4;
        off += 32; // vert_extent — unused for routing geometry
        stats.triPrimitiveTypes.set(triType, (stats.triPrimitiveTypes.get(triType) ?? 0) + 1);

        const VERT_STRIDE = 8; // float x + float y
        if (off + numVerts * VERT_STRIDE > payload.length) return null;

        const verts: [number, number][] = []; // [lon, lat]
        for (let v = 0; v < numVerts; v++) {
            const x = payload.readFloatLE(off);
            const y = payload.readFloatLE(off + 4);
            off += VERT_STRIDE;
            const ll = smVertexToLatLon(x / scale, y / scale, refMerc);
            verts.push([ll.lon, ll.lat]);
        }

        if (triType === GL_TRIANGLE_FAN) {
            for (let t = 0; t < numVerts - 2; t++) {
                triangles.push([verts[0], verts[t + 1], verts[t + 2]]);
            }
        } else if (triType === GL_TRIANGLE_STRIP) {
            for (let t = 0; t < numVerts - 2; t++) {
                if (t % 2 === 0) {
                    triangles.push([verts[t], verts[t + 1], verts[t + 2]]);
                } else {
                    triangles.push([verts[t + 1], verts[t], verts[t + 2]]);
                }
            }
        } else if (triType === GL_TRIANGLES) {
            for (let t = 0; t + 2 < numVerts; t += 3) {
                triangles.push([verts[t], verts[t + 1], verts[t + 2]]);
            }
        }
    }

    // ── Rogue-triangle filter ───────────────────────────────────────
    // The SENC's GLU tessellator emits TRIANGLE_FAN/STRIP primitives that
    // can include slivers spanning across polygon concavities (verified on
    // Brisbane River — LNDARE rcid 3885 had 9-13 km wide fans whose outer
    // verts walked along the river bank but whose fan-center sat inland,
    // creating a triangular wedge OVER the river). Visually: the chart
    // bleeds land into water.
    //
    // Two-axis filter:
    //   - max edge > MAX_EDGE_M (geographic span of the triangle)
    //   - aspect ratio (max/min edge) > MAX_ASPECT (a sliver, not a fill triangle)
    //
    // Both must trip to drop — a large equilateral triangle on a coarse-
    // scale cell is legitimate. A long thin sliver crossing 5+ km isn't.
    // Tuned conservatively: 2000m maxEdge + aspect 15 keeps city-scale
    // LNDARE filled while dropping the long thin rays that span 5-15 km.
    // First (more aggressive) tuning at 800m/8x dropped 30% of legit
    // onshore-Savannah triangles, so dialled up to err on "keep" side.
    const MAX_EDGE_M = 2000;
    const MAX_ASPECT = 15;
    const cleaned: AreaGeometry['triangles'] = [];
    let droppedRogue = 0;
    for (const tri of triangles) {
        const e1 = haversineLatLonM(tri[0][1], tri[0][0], tri[1][1], tri[1][0]);
        const e2 = haversineLatLonM(tri[1][1], tri[1][0], tri[2][1], tri[2][0]);
        const e3 = haversineLatLonM(tri[2][1], tri[2][0], tri[0][1], tri[0][0]);
        const maxE = Math.max(e1, e2, e3);
        const minE = Math.max(1, Math.min(e1, e2, e3)); // avoid /0 on degen
        if (maxE > MAX_EDGE_M && maxE / minE > MAX_ASPECT) {
            droppedRogue += 1;
            continue;
        }
        cleaned.push(tri);
    }
    if (droppedRogue > 0) {
        stats.triPrimitiveTypes.set(-1, (stats.triPrimitiveTypes.get(-1) ?? 0) + droppedRogue);
    }

    const geometry: AreaGeometry = {
        type: 'Area',
        triangles: cleaned,
        extent: { sLat, nLat, wLon, eLon },
    };

    // Anything after the triangulation is the edge-vector index array. Same
    // stride auto-detect as LINE records — 12 bytes per edge for stride=3,
    // 16 for stride=4.
    const edgeBytes = payload.length - off;
    if (edgeVectorCount > 0 && edgeBytes > 0) {
        const perEdge = edgeBytes / edgeVectorCount;
        let stride: 3 | 4 = 3;
        if (perEdge === 16) stride = 4;
        else if (perEdge !== 12) {
            return { geometry }; // unrecognised stride — skip rings, keep triangles
        }
        return {
            geometry,
            edges: {
                edgeIndicesRaw: Buffer.from(payload.subarray(off)),
                edgeVectorCount,
                stride,
            },
        };
    }

    return { geometry };
}

/**
 * Linear-chain polygon-ring reconstruction.
 *
 * Per reference OESUChart.cpp:buildLineGeometries (around line 692): the
 * SENC ships the AREA boundary edges in walk-order around the polygon —
 * each successive edge's startNode equals the previous edge's endNode.
 * A discontinuity (next.startNode != prev.endNode) marks the start of a
 * new ring (a hole, a disjoint outer, or another polygon part).
 *
 * Per-entry layout (see LineIndex constructor at S57Object.h:185):
 *   int32 startNode   (into connectedNodeTable)
 *   int32 edgeIndex   (into edgeTable for intermediate points; sign bit
 *                      encodes direction on V<=200, unsigned on V>200)
 *   int32 endNode     (into connectedNodeTable)
 *   int32 fwdFlag     (V>200 ONLY: 0 == forward, !=0 == reverse)
 *
 * Direction handling: forward edges traverse start → intermediates →
 * end. Reverse edges traverse end → reversed-intermediates → start, but
 * we still consume them in [startCoord, …, endCoord] order — the only
 * change is which way we iterate the intermediate edgeTable points.
 *
 * The reference relies on SHARED-NODE INDEX (line.startNode == prev.endNode)
 * to detect continuity. We do the same — coord-based continuity would also
 * work but is more numerically fragile.
 *
 * Returns null if the buffer is short or any node/edge can't be resolved.
 * Caller falls back to triangle output for that feature individually.
 */
function resolveAreaRings(
    raw: AreaEdgesRaw,
    edgeTable: Map<number, EdgeEntry>,
    connectedNodeTable: Map<number, ConnectedNodeEntry>,
): [number, number][][] | null {
    const buf = raw.edgeIndicesRaw;
    const entryBytes = raw.stride * 4;
    if (buf.length < raw.edgeVectorCount * entryBytes) return null;

    const rings: [number, number][][] = [];
    let currentRing: [number, number][] | null = null;
    let currentEndNode = -1;

    for (let i = 0; i < raw.edgeVectorCount; i++) {
        const off = i * entryBytes;
        const startNode = buf.readInt32LE(off);
        const edgeIdxSigned = buf.readInt32LE(off + 4);
        const endNode = buf.readInt32LE(off + 8);
        const fwdFlag = raw.stride === 4 ? buf.readInt32LE(off + 12) : 0;
        const forward = raw.stride === 4 ? fwdFlag === 0 : edgeIdxSigned >= 0;
        const edgeIdx = edgeIdxSigned >= 0 ? edgeIdxSigned : -edgeIdxSigned;

        const startCoord = connectedNodeTable.get(startNode)?.coord;
        const endCoord = connectedNodeTable.get(endNode)?.coord;
        if (!startCoord || !endCoord) return null;

        // Build segment as [startCoord, intermediates (in walk direction), endCoord]
        const edge = edgeTable.get(edgeIdx);
        const intermediate = edge ? (forward ? edge.points : edge.points.slice().reverse()) : [];

        // Detect ring continuation vs new ring
        if (currentRing === null || startNode !== currentEndNode) {
            // Start a new ring. Close the previous one if it exists.
            if (currentRing) {
                closeRing(currentRing);
                if (currentRing.length >= 4) rings.push(currentRing);
            }
            currentRing = [startCoord];
        }
        // Append this segment to the current ring (skip duplicate start point)
        for (const p of intermediate) currentRing.push(p);
        currentRing.push(endCoord);
        currentEndNode = endNode;
    }

    if (currentRing) {
        closeRing(currentRing);
        if (currentRing.length >= 4) rings.push(currentRing);
    }

    return rings.length > 0 ? rings : null;
}

/** Ensure a ring's last point equals its first, closing it. Mutates input. */
function closeRing(ring: [number, number][]): void {
    if (ring.length < 2) return;
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
}

/**
 * Sanity check: every reconstructed ring's bbox must lie within the AREA
 * record's declared extent (with a small geographic margin). Catches the
 * pathological case where stale edge references chain a ring across half the
 * chart — what the previous polygon-outline attempt was producing.
 */
function validateRings(
    rings: [number, number][][],
    extent: { sLat: number; nLat: number; wLon: number; eLon: number },
): boolean {
    // Pad the feature's declared extent by 10% in each dimension so we don't
    // reject rings that legitimately touch the AREA boundary.
    const latSpan = extent.nLat - extent.sLat;
    const lonSpan = extent.eLon - extent.wLon;
    const margin = Math.max(latSpan, lonSpan, 0.001) * 0.1;
    const sLat = extent.sLat - margin;
    const nLat = extent.nLat + margin;
    const wLon = extent.wLon - margin;
    const eLon = extent.eLon + margin;

    for (const ring of rings) {
        for (const [lon, lat] of ring) {
            if (lat < sLat || lat > nLat || lon < wLon || lon > eLon) return false;
        }
    }
    return true;
}

function readNullTerminated(buf: Buffer): string {
    const nul = buf.indexOf(0);
    return buf.subarray(0, nul === -1 ? buf.length : nul).toString('utf8');
}
