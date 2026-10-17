export const GRIB_IMPORT_LIMITS = Object.freeze({
    fileBytes: 32 * 1024 * 1024,
    gridPoints: 1_000_000,
    messages: 512,
    frames: 128,
    decodedBytes: 64 * 1024 * 1024,
});
export type GribImportCode =
    | 'NOT_GRIB'
    | 'UNSUPPORTED_EDITION'
    | 'MALFORMED'
    | 'UNSUPPORTED_GRID'
    | 'UNSUPPORTED_PACKING'
    | 'UNSUPPORTED_PRODUCT'
    | 'UNSUPPORTED_BITMAP'
    | 'LIMIT'
    | 'INCOMPLETE_WIND'
    | 'MIXED_SOURCE'
    | 'DUPLICATE_WIND'
    | 'CANCELLED';
export class GribImportError extends Error {
    constructor(
        public readonly code: GribImportCode,
        message: string,
    ) {
        super(message);
        this.name = 'GribImportError';
    }
}
export interface ImportedGribGrid {
    width: number;
    height: number;
    north: number;
    south: number;
    west: number;
    east: number;
    lats: number[];
    lons: number[];
}
export interface ImportedGribSource {
    centre: number;
    subcentre: number;
    process: number;
    parameterTable: number;
}
export interface ImportedGribWind extends ImportedGribGrid {
    edition: 1 | 2;
    importedGrib?: boolean;
    u: Float32Array[];
    v: Float32Array[];
    speed: Float32Array[];
    totalHours: number;
    stepHours: number[];
    refTime: string;
    validUntil: string;
    source: ImportedGribSource;
    ignoredMessages: number;
}
export interface ImportedGribPressure extends ImportedGribGrid {
    frames: Float32Array[];
    stepHours: number[];
    refTime: string;
}
export interface ImportedGribFile {
    edition: 1 | 2;
    refTime: string;
    source: ImportedGribSource;
    wind: ImportedGribWind | null;
    pressure: ImportedGribPressure | null;
    ignoredMessages: number;
}

/** One run/grid, explicit field/time identity. The budget reserves all output fields before allocation. */
export class GribFieldCollection {
    private identity = '';
    private fields = new Map<number, { u?: Float32Array; v?: Float32Array; p?: Float32Array }>();
    private grid?: ImportedGribGrid;
    private refTime = '';
    private source?: ImportedGribSource;
    ignoredMessages = 0;
    constructor(private readonly edition: 1 | 2) {}
    add(
        component: 'u' | 'v' | 'p',
        grid: ImportedGribGrid,
        refTime: string,
        hours: number,
        source: ImportedGribSource,
        sourceKey: string,
        unpack: () => Float32Array,
    ): void {
        if (component === 'p' && grid.width * grid.height > 65536)
            throw new GribImportError('LIMIT', 'Imported pressure exceeds the 65,536-cell contour limit.');
        const signature = JSON.stringify([sourceKey, refTime, grid]);
        if (this.identity && this.identity !== signature)
            throw new GribImportError('MIXED_SOURCE', 'Imported fields do not share one model run and grid.');
        this.identity = signature;
        this.grid = grid;
        this.refTime = refTime;
        this.source = source;
        let frame = this.fields.get(hours);
        if (!frame) {
            if (
                this.fields.size >= GRIB_IMPORT_LIMITS.frames ||
                (this.fields.size + 1) * grid.width * grid.height * 16 > GRIB_IMPORT_LIMITS.decodedBytes
            )
                throw new GribImportError('LIMIT', 'Imported fields exceed the frame or memory limit.');
            this.fields.set(hours, (frame = {}));
        }
        if (frame[component])
            throw new GribImportError('DUPLICATE_WIND', 'A field is duplicated at the same forecast time.');
        frame[component] = unpack();
    }
    finish(current: () => boolean): ImportedGribFile {
        if (!this.grid || !this.source)
            throw new GribImportError(
                'INCOMPLETE_WIND',
                'No supported 10 m wind or mean sea level pressure was found.',
            );
        const ordered = [...this.fields].sort(([a], [b]) => a - b);
        const winds = ordered.filter(([, f]) => f.u || f.v),
            pressures = ordered.filter(([, f]) => f.p);
        const u: Float32Array[] = [],
            v: Float32Array[] = [],
            speed: Float32Array[] = [];
        let knownWind = 0,
            knownPressure = 0;
        for (const [, f] of winds) {
            if (!f.u || !f.v)
                throw new GribImportError('INCOMPLETE_WIND', 'A forecast time is missing its U or V wind component.');
            const magnitude = new Float32Array(f.u.length);
            for (let i = 0; i < magnitude.length; i++) {
                if (!(i & 4095) && !current()) throw new GribImportError('CANCELLED', 'GRIB decoding stopped.');
                magnitude[i] = Number.isFinite(f.u[i]) && Number.isFinite(f.v[i]) ? Math.hypot(f.u[i], f.v[i]) : NaN;
                if (Number.isFinite(magnitude[i])) knownWind++;
            }
            u.push(f.u);
            v.push(f.v);
            speed.push(magnitude);
        }
        const pressureFrames = pressures.map(([, f]) => {
            for (let i = 0; i < f.p!.length; i++) {
                if (!(i & 4095) && !current()) throw new GribImportError('CANCELLED', 'GRIB decoding stopped.');
                f.p![i] /= 100;
                if (Number.isFinite(f.p![i])) knownPressure++;
            }
            return f.p!;
        });
        if ((winds.length && !knownWind) || (pressures.length && !knownPressure))
            throw new GribImportError('INCOMPLETE_WIND', 'An imported field contains no known cells.');
        const stepHours = winds.map(([h]) => h),
            refTime = this.refTime;
        return {
            edition: this.edition,
            refTime,
            source: this.source,
            ignoredMessages: this.ignoredMessages,
            wind: winds.length
                ? {
                      ...this.grid,
                      edition: this.edition,
                      importedGrib: true,
                      u,
                      v,
                      speed,
                      totalHours: winds.length,
                      stepHours,
                      refTime,
                      validUntil: new Date(Date.parse(refTime) + stepHours.at(-1)! * 3600000).toISOString(),
                      source: this.source,
                      ignoredMessages: this.ignoredMessages,
                  }
                : null,
            pressure: pressures.length
                ? { ...this.grid, frames: pressureFrames, refTime, stepHours: pressures.map(([h]) => h) }
                : null,
        };
    }
}
