/** Types for fakeOexserverd.mjs (the chart vault's fictional test daemon). */
export interface FixtureCell {
    /** The .oesu file name without its extension, e.g. 'OC-99-ZZ0001'. */
    file: string;
    sourceCellId?: string;
    edition?: number;
    update?: number;
    /** YYYYMMDD */
    issued?: string;
    scale?: number;
    extent: { s: number; w: number; n: number; e: number };
    /** The lateral buoy's OBJNAM. */
    objnam: string;
    /** The sounding's depth in metres (float32, one decimal survives the emitter). */
    depth: number;
}

export const FIXTURE_CODES: { BOYLAT: number; SOUNDG: number; OBJNAM: number };
export function buildSenc(spec: FixtureCell): Buffer;
export function sealFixture(spec: FixtureCell, keyHex: string): Buffer;
export function openFixture(bytes: Buffer, keyHex: string): FixtureCell | null;
export function writeFixtureSet(
    dir: string,
    options: { cells: FixtureCell[]; keyHex?: string; keyFiles?: number; unkeyed?: string[] },
): string;
export function writeFixtureCatalogue(dir: string): string;
export function serve(pipe?: string): void;
