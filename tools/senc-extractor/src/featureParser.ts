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
 * AREA geometry as a list of closed rings, each [lon, lat] coordinates with
 * the first vertex repeated as the last. By S-57 convention the first ring is
 * the outer boundary; subsequent rings are holes.
 *
 * Reconstructed from the SENC edge-vector + connected-node tables (the same
 * topology LINE features use) — the triangulation primitives that ship in the
 * AREA record are skipped, since they're a renderer convenience that bloats
 * routing-relevant data by ~3×.
 */
export interface AreaGeometry {
    type: 'Area';
    rings: [number, number][][];
    extent: { sLat: number; nLat: number; wLon: number; eLon: number };
}

/** Intermediate AREA form before vector-table resolution. */
export interface AreaGeometryRaw {
    type: 'AreaRaw';
    extent: { sLat: number; nLat: number; wLon: number; eLon: number };
    /** Number of contour rings advertised in the header. */
    contourCount: number;
    /** Point-count per contour (informational; used as sanity check). */
    contourPointCounts: number[];
    /** Edge-vector index entries. Same wire format as LINE records (3 or 4 int32 per edge). */
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

export type FeatureGeometry =
    | PointGeometry
    | MultiPointGeometry
    | AreaGeometry
    | AreaGeometryRaw
    | LineGeometry
    | LineGeometryRaw;

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
        linesResolved?: number;
        linesUnresolvable?: number;
        areasResolved?: number;
        areasUnresolvable?: number;
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
    };

    const edgeTable = new Map<number, EdgeEntry>();
    const connectedNodeTable = new Map<number, ConnectedNodeEntry>();

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
                parseEdgeTable(payload, header.refMerc, edgeTable);
                break;
            }

            case RecordType.VECTOR_CONNECTED_NODE_TABLE_RECORD: {
                if (!header.refMerc) break;
                parseConnectedNodeTable(payload, header.refMerc, connectedNodeTable);
                break;
            }

            case RecordType.FEATURE_GEOMETRY_RECORD_AREA: {
                if (!current || payload.length < 44) break;
                const areaRaw = parseAreaRecordToRaw(payload, header.sencVersion ?? 0, stats);
                if (areaRaw) {
                    current.geometry = areaRaw;
                    stats.geometriesByPrimitive.area += 1;
                }
                break;
            }

            default:
                // VECTOR_EDGE_NODE_TABLE_RECORD (96), VECTOR_CONNECTED_NODE_TABLE_RECORD (97),
                // CELL_COVR_RECORD (98), CELL_NOCOVR_RECORD (99), CELL_TXTDSC_INFO_FILE_RECORD (101),
                // SERVER_STATUS_RECORD (200) — not consumed for routing extraction.
                break;
        }
    }

    flush();

    // Second pass: resolve LineRaw → Line and AreaRaw → Area using the
    // chart-wide vector tables that come after the feature records.
    let linesResolved = 0;
    let linesUnresolvable = 0;
    let areasResolved = 0;
    let areasUnresolvable = 0;
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
        } else if (f.geometry?.type === 'AreaRaw') {
            const resolved = resolveAreaGeometry(f.geometry, edgeTable, connectedNodeTable);
            if (resolved) {
                f.geometry = resolved;
                areasResolved += 1;
            } else {
                f.geometry = null;
                areasUnresolvable += 1;
            }
        }
    }
    stats.linesResolved = linesResolved;
    stats.linesUnresolvable = linesUnresolvable;
    stats.areasResolved = areasResolved;
    stats.areasUnresolvable = areasUnresolvable;

    return { header, features, stats };
}

function parseEdgeTable(payload: Buffer, refMerc: MercXY, out: Map<number, EdgeEntry>): void {
    if (payload.length < 4) return;
    const numEntries = payload.readUInt32LE(0);
    let off = 4;
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
            const ll = smVertexToLatLon(x, y, refMerc);
            points.push([ll.lon, ll.lat]);
        }
        out.set(edgeIndex, { points });
    }
}

function parseConnectedNodeTable(payload: Buffer, refMerc: MercXY, out: Map<number, ConnectedNodeEntry>): void {
    if (payload.length < 4) return;
    const numEntries = payload.readUInt32LE(0);
    let off = 4;
    for (let i = 0; i < numEntries; i++) {
        if (off + 12 > payload.length) return;
        const nodeIndex = payload.readInt32LE(off);
        const x = payload.readFloatLE(off + 4);
        const y = payload.readFloatLE(off + 8);
        off += 12;
        const ll = smVertexToLatLon(x, y, refMerc);
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

    for (let i = 0; i < raw.edgeVectorCount; i++) {
        const edgeIdx = buf.readInt32LE(off);
        const startNode = buf.readInt32LE(off + 4);
        const endNode = buf.readInt32LE(off + 8);
        const fwdFlag = raw.stride === 4 ? buf.readInt32LE(off + 12) : 1;
        off += entryBytes;

        const startCoord = connectedNodeTable.get(startNode);
        const edge = edgeTable.get(edgeIdx);
        const endCoord = connectedNodeTable.get(endNode);

        if (startCoord) pushCoord(startCoord.coord);

        if (edge) {
            if (fwdFlag === -1 || fwdFlag === 0) {
                for (let p = edge.points.length - 1; p >= 0; p--) pushCoord(edge.points[p]);
            } else {
                for (const p of edge.points) pushCoord(p);
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

/**
 * First-pass AREA record parser. Walks past the triangulation primitives (we
 * don't emit them — they're a renderer convenience that bloats routing data)
 * and slices out the edge-vector index entries so the second pass can resolve
 * them against the chart-wide edge + node tables. Stride is auto-detected
 * from the leftover buffer width, mirroring the LINE record logic.
 */
function parseAreaRecordToRaw(
    payload: Buffer,
    _sencVersion: number,
    stats: ParseResult['stats'],
): AreaGeometryRaw | null {
    const sLat = payload.readDoubleLE(0);
    const nLat = payload.readDoubleLE(8);
    const wLon = payload.readDoubleLE(16);
    const eLon = payload.readDoubleLE(24);
    const contourCount = payload.readUInt32LE(32);
    const triprimCount = payload.readUInt32LE(36);
    const edgeVectorCount = payload.readUInt32LE(40);

    let off = 44;

    // contourCount × uint32 — point count per ring.
    const contourPointCounts: number[] = [];
    if (off + contourCount * 4 > payload.length) return null;
    for (let i = 0; i < contourCount; i++) {
        contourPointCounts.push(payload.readUInt32LE(off));
        off += 4;
    }

    // Walk past triPrimitive blocks — each:
    //   uint8 triType + uint32 numVerts + 4× double vert_extent + numVerts × 2×float
    for (let i = 0; i < triprimCount; i++) {
        if (off + 1 + 4 + 32 > payload.length) return null;
        const triType = payload.readUInt8(off);
        off += 1;
        const numVerts = payload.readUInt32LE(off);
        off += 4;
        off += 32; // vert_extent
        stats.triPrimitiveTypes.set(triType, (stats.triPrimitiveTypes.get(triType) ?? 0) + 1);
        const vertBytes = numVerts * 8;
        if (off + vertBytes > payload.length) return null;
        off += vertBytes;
    }

    // Remaining buffer is edge-vector entries. Same auto-detect as LINE.
    const edgeBytes = payload.length - off;
    let stride: 3 | 4 = 3;
    if (edgeVectorCount > 0) {
        const perEdge = edgeBytes / edgeVectorCount;
        if (perEdge === 16) stride = 4;
        else if (perEdge !== 12) {
            // Buffer width doesn't divide cleanly — keep stride=3, the resolver
            // will bail if the indices don't make sense.
        }
    }

    return {
        type: 'AreaRaw',
        extent: { sLat, nLat, wLon, eLon },
        contourCount,
        contourPointCounts,
        edgeIndicesRaw: Buffer.from(payload.subarray(off)),
        edgeVectorCount,
        stride,
    };
}

/**
 * Resolve an AreaRaw into closed polygon rings using the chart's edge and node
 * tables.
 *
 * Ring grouping comes from the contour-point-counts the SENC ships in the AREA
 * record header: `contourPointCounts[i]` is the number of EDGE entries that
 * belong to ring i. This is the same partitioning OpenCPN's renderer uses, and
 * gives a deterministic split (an earlier naive "chain when consecutive nodes
 * disagree" heuristic over-split rings whenever edges referenced different
 * node-table entries that happened to have identical coordinates).
 *
 * Within each ring, consecutive edges share an endpoint node, so we add
 * `startNode + edgePoints + endNode` for the first edge and only
 * `edgePoints + endNode` for subsequent edges to avoid duplicating shared
 * vertices. Each ring is closed with its first vertex.
 *
 * If `sum(contourPointCounts) !== edgeVectorCount` we fall back to treating the
 * whole edge list as a single ring — better one slightly-wrong ring than
 * nothing.
 */
function resolveAreaGeometry(
    raw: AreaGeometryRaw,
    edgeTable: Map<number, EdgeEntry>,
    connectedNodeTable: Map<number, ConnectedNodeEntry>,
): AreaGeometry | null {
    const buf = raw.edgeIndicesRaw;
    const entryBytes = raw.stride * 4;
    if (buf.length < raw.edgeVectorCount * entryBytes) return null;

    // Sanity-check ring partitioning. If counts don't sum to the edge total,
    // collapse to one ring covering every edge.
    const partitionSum = raw.contourPointCounts.reduce((acc, n) => acc + n, 0);
    const partition = partitionSum === raw.edgeVectorCount ? raw.contourPointCounts : [raw.edgeVectorCount];

    const rings: [number, number][][] = [];
    let edgeIdxCursor = 0;

    for (const edgesInRing of partition) {
        const ring: [number, number][] = [];

        for (let i = 0; i < edgesInRing; i++) {
            const off = (edgeIdxCursor + i) * entryBytes;
            const edgeIdx = buf.readInt32LE(off);
            const startNode = buf.readInt32LE(off + 4);
            const endNode = buf.readInt32LE(off + 8);
            const fwdFlag = raw.stride === 4 ? buf.readInt32LE(off + 12) : 1;

            // First edge in the ring contributes its start node; subsequent edges
            // chain off the previous edge's end node.
            if (i === 0) {
                const sc = connectedNodeTable.get(startNode);
                if (sc) ring.push(sc.coord);
            }

            const edge = edgeTable.get(edgeIdx);
            if (edge) {
                const pts = fwdFlag === -1 || fwdFlag === 0 ? [...edge.points].reverse() : edge.points;
                for (const p of pts) ring.push(p);
            }

            const ec = connectedNodeTable.get(endNode);
            if (ec) ring.push(ec.coord);
        }

        edgeIdxCursor += edgesInRing;
        if (ring.length < 3) continue;

        // Close the ring (GeoJSON convention).
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
        rings.push(ring);
    }

    if (rings.length === 0) return null;
    return {
        type: 'Area',
        rings,
        extent: raw.extent,
    };
}

function readNullTerminated(buf: Buffer): string {
    const nul = buf.indexOf(0);
    return buf.subarray(0, nul === -1 ? buf.length : nul).toString('utf8');
}
