/** A coarse wx row is not evidence of the requested coastal cell or model.
 * The publisher may opt in only after its deployed implementation writes
 * this explicit, versioned contract from the actual upstream request. */
export function isSeaCellForecast(payload: unknown, model: string, lat: number, lon: number): boolean {
    const p = (
        payload as {
            thalassa_provenance?: {
                version?: number;
                model?: string;
                cell_selection?: string;
                latitude?: number;
                longitude?: number;
            };
        } | null
    )?.thalassa_provenance;
    return (
        p?.version === 1 &&
        p.model === model &&
        p.cell_selection === 'sea' &&
        typeof p.latitude === 'number' &&
        Number.isFinite(p.latitude) &&
        Math.abs(p.latitude - lat) <= 0.0001 &&
        typeof p.longitude === 'number' &&
        Number.isFinite(p.longitude) &&
        Math.abs(p.longitude - lon) <= 0.0001
    );
}
