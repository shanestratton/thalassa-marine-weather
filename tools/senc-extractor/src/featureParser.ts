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
 * AREA geometry decoded into a flat list of triangles. Each triangle is three
 * [lon, lat] points. Built from the SENC triangulation primitives — sufficient
 * for point-in-polygon coverage tests on the router side; polygon-outline
 * reconstruction (via edge-vector indices) is a future enhancement.
 */
export interface AreaGeometry {
    type: 'Area';
    triangles: [[number, number], [number, number], [number, number]][];
    extent: { sLat: number; nLat: number; wLon: number; eLon: number };
}

/** LINE geometry — kept as raw edge-vector indices until the vector tables land. */
export interface LineGeometryRaw {
    type: 'LineRaw';
    extent: { sLat: number; nLat: number; wLon: number; eLon: number };
    edgeVectorCount: number;
    rawIndices: Buffer;
}

export type FeatureGeometry = PointGeometry | MultiPointGeometry | AreaGeometry | LineGeometryRaw;

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
    };
}

const ATTR_VALUE_TYPE_UINT32 = 0;
const ATTR_VALUE_TYPE_DOUBLE = 2;
const ATTR_VALUE_TYPE_STRING = 4;

// OpenGL primitive type values used in SENC triangle primitives:
const GL_TRIANGLES = 4;
const GL_TRIANGLE_STRIP = 5;
const GL_TRIANGLE_FAN = 6;

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
                current.geometry = {
                    type: 'LineRaw',
                    extent: { sLat, nLat, wLon, eLon },
                    edgeVectorCount,
                    rawIndices: Buffer.from(payload.subarray(36)),
                };
                stats.geometriesByPrimitive.line += 1;
                break;
            }

            case RecordType.FEATURE_GEOMETRY_RECORD_AREA: {
                if (!current || payload.length < 44 || !header.refMerc) break;
                const areaGeom = parseAreaGeometry(payload, header.refMerc, stats);
                if (areaGeom) {
                    current.geometry = areaGeom;
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

    return { header, features, stats };
}

function parseAreaGeometry(payload: Buffer, refMerc: MercXY, stats: ParseResult['stats']): AreaGeometry | null {
    const sLat = payload.readDoubleLE(0);
    const nLat = payload.readDoubleLE(8);
    const wLon = payload.readDoubleLE(16);
    const eLon = payload.readDoubleLE(24);
    const contourCount = payload.readUInt32LE(32);
    const triprimCount = payload.readUInt32LE(36);

    let off = 44;
    // Skip contour point counts: contourCount × uint32.
    off += contourCount * 4;

    const triangles: AreaGeometry['triangles'] = [];

    for (let i = 0; i < triprimCount; i++) {
        if (off + 1 + 4 + 32 > payload.length) return null;
        const triType = payload.readUInt8(off);
        off += 1;
        const numVerts = payload.readUInt32LE(off);
        off += 4;
        off += 32; // vert_extent (4 doubles) — unused for routing geometry
        stats.triPrimitiveTypes.set(triType, (stats.triPrimitiveTypes.get(triType) ?? 0) + 1);

        const VERT_STRIDE = 8; // float x + float y
        if (off + numVerts * VERT_STRIDE > payload.length) return null;

        const verts: [number, number][] = []; // [lon, lat]
        for (let v = 0; v < numVerts; v++) {
            const x = payload.readFloatLE(off);
            const y = payload.readFloatLE(off + 4);
            off += VERT_STRIDE;
            const ll = smVertexToLatLon(x, y, refMerc);
            verts.push([ll.lon, ll.lat]);
        }

        // Emit triangles based on primitive type. SENC uses OpenGL semantics:
        // GL_TRIANGLES=4, GL_TRIANGLE_STRIP=5, GL_TRIANGLE_FAN=6.
        if (triType === GL_TRIANGLE_FAN) {
            for (let t = 0; t < numVerts - 2; t++) {
                triangles.push([verts[0], verts[t + 1], verts[t + 2]]);
            }
        } else if (triType === GL_TRIANGLE_STRIP) {
            for (let t = 0; t < numVerts - 2; t++) {
                // Alternate winding to keep triangles co-oriented in a strip.
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
        // Unknown triType: count it (in stats.triPrimitiveTypes) and skip.
    }

    return {
        type: 'Area',
        triangles,
        extent: { sLat, nLat, wLon, eLon },
    };
}

function readNullTerminated(buf: Buffer): string {
    const nul = buf.indexOf(0);
    return buf.subarray(0, nul === -1 ? buf.length : nul).toString('utf8');
}
