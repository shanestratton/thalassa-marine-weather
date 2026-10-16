/** Fixed engine_metrics_v1 units: seconds, Celsius and kPa; clocks are original sensor times. */
export interface EngineMetric {
    value: number;
    at: number;
}
export interface EngineTelemetry {
    engineId: string;
    vesselKey?: string;
    runTime?: EngineMetric;
    coolant?: EngineMetric;
    oilPressure?: EngineMetric;
}
export function parseEngineTelemetry(raw: unknown, now: number): EngineTelemetry | undefined {
    if (typeof raw !== 'string' || raw.length > 120) return undefined;
    try {
        const row: unknown = JSON.parse(raw);
        if (
            !Array.isArray(row) ||
            !(
                (row.length === 9 && row[0] === 1) ||
                (row.length === 10 && row[0] === 2 && typeof row[9] === 'string' && /^[a-f0-9]{24}$/.test(row[9]))
            ) ||
            typeof row[1] !== 'string' ||
            !/^[A-Za-z0-9_.-]{1,64}$/.test(row[1]) ||
            !Number.isSafeInteger(row[2]) ||
            row[2] <= 0 ||
            row[2] > now + 1000
        )
            return undefined;
        const result: EngineTelemetry = { engineId: row[1] };
        if (row[0] === 2) result.vesselKey = row[9];
        const fields = [
            ['runTime', 0, 3_153_600_000],
            ['coolant', -60, 200],
            ['oilPressure', 0, 5000],
        ] as const;
        for (let i = 0; i < fields.length; i++) {
            const [key, low, high] = fields[i],
                value: unknown = row[3 + i * 2],
                offset: unknown = row[4 + i * 2];
            if (value === null && offset === null) continue;
            if (
                typeof value !== 'number' ||
                !Number.isFinite(value) ||
                value < low ||
                value > high ||
                typeof offset !== 'number' ||
                !Number.isSafeInteger(offset) ||
                offset < 0 ||
                offset > 13_000
            )
                return undefined;
            const at = row[2] - offset;
            if (at <= 0) return undefined;
            result[key] = { value, at };
        }
        return fields.some(([key]) => result[key] !== undefined) ? result : undefined;
    } catch {
        return undefined;
    }
}
