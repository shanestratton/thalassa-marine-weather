/** An optional equipment record, never evidence of scanner connectivity. */
export type MarineRadarMake = 'raymarine' | 'garmin' | 'simrad' | 'furuno' | 'other' | 'unknown';
export interface MarineRadarEquipment {
    schema: 1;
    make: MarineRadarMake;
    modelId: string | null;
    /** Plain manual identification when the model is not in the catalogue. */
    detail: string | null;
}
