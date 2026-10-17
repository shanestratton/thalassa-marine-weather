/** Allowlisted additional codecs share the existing release transport, never its THCU science gate. */
export interface SpecializedReleaseContract {
    readonly spec: {
        readonly id: string;
        readonly releaseTag: string;
        readonly steps: number;
        readonly cadenceHours: number;
        readonly maxAssetBytes: number;
    };
    validate(value: unknown, nowMs: number, requireCurrent: boolean): void;
    generation(dataStart: string, hashes: readonly string[]): string;
}
