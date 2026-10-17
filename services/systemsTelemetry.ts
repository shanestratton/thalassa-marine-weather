/** Fixed read-only units and original clocks for optional sys_*_v1 scalars. */
export interface SystemsValue {
    value: number;
    at: number;
}
export interface SystemsReading {
    kind: SystemsKind;
    instance: string;
    source: string;
    values: (SystemsValue | null)[];
}
export const SYSTEMS_FIELDS = {
    b: {
        label: 'Battery',
        fields: [
            ['Voltage', 'V', 0, 1000],
            ['Current (out +)', 'A', -10000, 10000],
            ['State of charge', '%', 0, 100],
        ],
    },
    f: { label: 'Fresh water', fields: [['Level', '%', 0, 100]] },
    d: { label: 'Fuel tank', fields: [['Level', '%', 0, 100]] },
    w: { label: 'Black water', fields: [['Level', '%', 0, 100]] },
    g: { label: 'Waste water', fields: [['Level', '%', 0, 100]] },
    s: {
        label: 'Solar',
        fields: [
            ['Panel power', 'W', 0, 1000000],
            ['Panel voltage', 'V', 0, 1000],
            ['Panel current', 'A', -10000, 10000],
        ],
    },
    c: {
        label: 'Charger',
        fields: [
            ['Voltage', 'V', 0, 1000],
            ['Current (out +)', 'A', -10000, 10000],
            ['Temperature', '\u00b0C', -60, 200],
        ],
    },
    a: {
        label: 'AC power',
        fields: [
            ['Real power', 'W', -10000000, 10000000],
            ['Voltage L-N', 'V', 0, 1000],
            ['Current', 'A', -10000, 10000],
        ],
    },
    p: { label: 'Autopilot state', fields: [['State', '', 0, 7]] },
} as const;
export type SystemsKind = keyof typeof SYSTEMS_FIELDS;
export const PILOT_STATES = [
    'Auto',
    'Standby',
    'Alarm',
    'No drift',
    'Wind',
    'Depth contour',
    'Route',
    'Direct control',
];
export const SYSTEMS_MAX_AGE_MS = 180_000;
export function systemsValueAvailable(value: SystemsValue | null | undefined, now: number): value is SystemsValue {
    return (
        !!value &&
        Number.isFinite(value.value) &&
        value.at > 0 &&
        value.at <= now + 1000 &&
        now - value.at <= SYSTEMS_MAX_AGE_MS
    );
}
export function parseSystemsTelemetry(extra: Record<string, unknown>, now: number): SystemsReading[] {
    const result: SystemsReading[] = [];
    for (let i = 0; i < 8; i++) {
        const raw = extra['sys_' + i + '_v1'];
        if (typeof raw !== 'string' || raw.length > 120) continue;
        try {
            const row: unknown = JSON.parse(raw);
            if (
                !Array.isArray(row) ||
                row[0] !== 1 ||
                typeof row[1] !== 'string' ||
                !Object.hasOwn(SYSTEMS_FIELDS, row[1]) ||
                ![row[2], row[3]].every(
                    (value) => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,32}$/.test(value),
                ) ||
                !Number.isSafeInteger(row[4]) ||
                row[4] <= 0 ||
                row[4] > now + 1000 ||
                now - row[4] > SYSTEMS_MAX_AGE_MS
            )
                continue;
            const kind = row[1] as SystemsKind,
                fields = SYSTEMS_FIELDS[kind].fields;
            if (row.length !== 5 + fields.length * 2) continue;
            const values: (SystemsValue | null)[] = [];
            let invalid = false;
            fields.forEach(([, , min, max], index) => {
                const value = row[5 + index * 2],
                    offset = row[6 + index * 2];
                if (value === null && offset === null) {
                    values.push(null);
                    return;
                }
                if (
                    typeof value !== 'number' ||
                    !Number.isFinite(value) ||
                    value < min ||
                    value > max ||
                    (kind === 'p' && !Number.isInteger(value)) ||
                    !Number.isSafeInteger(offset) ||
                    offset < 0 ||
                    offset > SYSTEMS_MAX_AGE_MS ||
                    row[4] - offset <= 0
                ) {
                    invalid = true;
                    return;
                }
                const reading = { value, at: row[4] - offset };
                values.push(systemsValueAvailable(reading, now) ? reading : null);
            });
            if (!invalid && values.some(Boolean)) result.push({ kind, instance: row[2], source: row[3], values });
        } catch {
            /* Invalid optional data cannot qualify a reading. */
        }
    }
    return result;
}
