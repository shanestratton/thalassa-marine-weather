export type DepthDisplayTone = 'danger' | 'caution' | 'safe';

export interface DepthDisplayValue {
    metres: number;
    tone: DepthDisplayTone;
    kind: 'water' | 'land';
}

/**
 * Bathymetry is stored as negative elevation below datum. Presentation and
 * human safety thresholds use a positive depth magnitude.
 */
export function waypointDepthDisplay(depthM: number | null | undefined): DepthDisplayValue | null {
    if (typeof depthM !== 'number' || !Number.isFinite(depthM)) return null;
    const kind = depthM >= 0 ? 'land' : 'water';
    const metres = Math.round(Math.abs(depthM) * 10) / 10;
    return {
        metres,
        kind,
        tone: kind === 'land' || metres < 10 ? 'danger' : metres < 30 ? 'caution' : 'safe',
    };
}
