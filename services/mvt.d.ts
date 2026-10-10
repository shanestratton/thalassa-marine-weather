// Minimal ambient types for the untyped MVT decoders (@mapbox/vector-tile v2,
// pbf v4 — both ESM, no bundled .d.ts). Only the surface mapboxWater.ts uses,
// plus pbf's writers for the test-side tile encoder (tests/helpers/handMvt.ts).
declare module '@mapbox/vector-tile' {
    export interface VectorTileFeature {
        /** GeoJSON geometry type: 1=Point, 2=LineString, 3=Polygon. */
        readonly type: number;
        readonly properties: Record<string, string | number | boolean>;
        toGeoJSON(x: number, y: number, z: number): import('geojson').Feature;
    }
    export interface VectorTileLayer {
        readonly length: number;
        feature(i: number): VectorTileFeature;
    }
    export class VectorTile {
        constructor(pbf: unknown);
        readonly layers: Record<string, VectorTileLayer>;
    }
}

declare module 'pbf' {
    export default class Pbf {
        constructor(buf?: Uint8Array | ArrayBuffer);
        writeMessage<T>(tag: number, fn: (obj: T, pbf: Pbf) => void, obj: T): void;
        writePackedVarint(tag: number, arr: number[]): void;
        writeVarintField(tag: number, val: number): void;
        writeStringField(tag: number, str: string): void;
        writeDoubleField(tag: number, val: number): void;
        writeBooleanField(tag: number, val: boolean): void;
        finish(): Uint8Array;
    }
}
