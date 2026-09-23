/** Receiver-reported diagnostics, never accuracy inferred from HDOP. */
export interface GnssDiagnosticSample {
    value: number;
    sampleAt: number;
}

export interface GnssDiagnostics {
    /** Exact receiver source shared with this snapshot's position. */
    source: string;
    satellites?: GnssDiagnosticSample;
    hdop?: GnssDiagnosticSample;
    fixQuality?: GnssDiagnosticSample;
    accuracyM?: GnssDiagnosticSample;
}

export function validGnssValue(field: Exclude<keyof GnssDiagnostics, 'source'>, value: unknown): value is number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    switch (field) {
        case 'satellites':
            return Number.isInteger(value) && value >= 0 && value <= 256;
        case 'fixQuality':
            return Number.isInteger(value) && value >= 0 && value <= 8;
        case 'hdop':
            return value >= 0 && value <= 100;
        case 'accuracyM':
            return value >= 0 && value <= 100_000;
    }
}

export function readGnssDiagnostics(extra: Record<string, unknown>): GnssDiagnostics | undefined {
    const source = extra.gnss_source;
    if (typeof source !== 'string' || !source.trim() || source.length > 120 || /\p{Cc}/u.test(source)) return undefined;
    const result: GnssDiagnostics = { source: source.trim() };
    const fields = {
        satellites: 'gnss_satellites',
        hdop: 'gnss_hdop',
        fixQuality: 'gnss_fix_quality',
        accuracyM: 'gnss_accuracy_m',
    } as const;
    for (const [field, key] of Object.entries(fields) as Array<[keyof typeof fields, string]>) {
        const value = extra[key];
        const sampleAt = extra[`${key}_at_ms`];
        if (validGnssValue(field, value) && typeof sampleAt === 'number' && Number.isFinite(sampleAt) && sampleAt > 0)
            result[field] = { value, sampleAt };
    }
    return Object.keys(result).length > 1 ? result : undefined;
}
