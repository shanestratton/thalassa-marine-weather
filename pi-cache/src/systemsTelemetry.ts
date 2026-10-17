/** Bounded read-only selected Signal K leaves. No controls, inferred senders or parent clocks. */
type Node = Record<string, unknown>;
type Field = readonly [path: string, unit: string, low: number, high: number, scale?: number, offset?: number];
const AGE = 180_000;
const PILOT = ['auto', 'standby', 'alarm', 'noDrift', 'wind', 'depthContour', 'route', 'directControl'];
const DC: readonly Field[] = [
    ['voltage', 'V', 0, 1000],
    ['current', 'A', -10000, 10000],
];
const DEFINITIONS: readonly [string, string, readonly Field[]][] = [
    ['b', 'electrical.batteries', [...DC, ['capacity.stateOfCharge', 'ratio', 0, 1, 100]]],
    ['f', 'tanks.freshWater', [['currentLevel', 'ratio', 0, 1, 100]]],
    ['d', 'tanks.fuel', [['currentLevel', 'ratio', 0, 1, 100]]],
    ['w', 'tanks.blackWater', [['currentLevel', 'ratio', 0, 1, 100]]],
    ['g', 'tanks.wasteWater', [['currentLevel', 'ratio', 0, 1, 100]]],
    [
        's',
        'electrical.solar',
        [
            ['panelPower', 'W', 0, 1000000],
            ['panelVoltage', 'V', 0, 1000],
            ['panelCurrent', 'A', -10000, 10000],
        ],
    ],
    ['c', 'electrical.chargers', [...DC, ['temperature', 'K', 213.15, 473.15, 1, -273.15]]],
];
function object(value: unknown): Node | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Node) : null;
}
function at(value: unknown, path: string): unknown {
    let node = value;
    for (const key of path.split('.')) {
        let record = object(node);
        if (record && !(key in record)) record = object(record.value);
        node = record?.[key];
    }
    return node;
}
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,32}$/.test(value);
function packs(kind: string, id: string, node: unknown, fields: readonly Field[], now: number): string[] {
    const sources = new Map<string, ({ value: number; at: number } | null)[]>();
    fields.forEach(([path, unit, low, high, scale = 1, offset = 0], index) => {
        const leaf = object(at(node, path));
        if (!leaf || !identifier(leaf.$source)) return;
        const units = object(leaf.meta)?.units;
        const stamp = typeof leaf.timestamp === 'string' ? Date.parse(leaf.timestamp) : NaN;
        const value = kind === 'p' ? PILOT.indexOf(String(leaf.value)) : leaf.value;
        if (
            (units !== undefined && units !== unit) ||
            !Number.isSafeInteger(stamp) ||
            stamp <= 0 ||
            stamp > now + 1000 ||
            now - stamp > AGE ||
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            value < low ||
            value > high
        )
            return;
        const selected = String(leaf.$source);
        const values = sources.get(selected) ?? fields.map(() => null);
        values[index] = { value: Math.round((value * scale + offset) * 1000) / 1000, at: stamp };
        sources.set(selected, values);
    });
    const result: string[] = [];
    for (const [source, values] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
        const base = Math.max(...values.flatMap((value) => (value ? [value.at] : [])));
        const packed = JSON.stringify([
            1,
            kind,
            id,
            source,
            base,
            ...values.flatMap((value) => (value ? [value.value, base - value.at] : [null, null])),
        ]);
        if (packed.length <= 120) result.push(packed);
    }
    return result;
}
export function readSystemsExtra(doc: unknown, now: number): Record<string, string> {
    const groups: string[][] = [];
    for (const [kind, path, fields] of DEFINITIONS) {
        const collection = object(at(doc, path));
        if (!collection) continue;
        const ids = Object.keys(collection);
        if (ids.length > 64) continue;
        const group = ids
            .sort()
            .filter(identifier)
            .flatMap((id) => packs(kind, id, collection[id], fields, now))
            .slice(0, 2);
        if (group.length) groups.push(group);
    }
    const ac = object(at(doc, 'electrical.ac'));
    if (ac && Object.keys(ac).length <= 64) {
        const group: string[] = [];
        for (const id of Object.keys(ac).sort().filter(identifier))
            for (const phase of ['single', 'A', 'B', 'C']) {
                const instance = id + '/' + phase;
                if (!identifier(instance)) continue;
                group.push(
                    ...packs(
                        'a',
                        instance,
                        at(ac[id], 'phase.' + phase),
                        [
                            ['realPower', 'W', -10000000, 10000000],
                            ['lineNeutralVoltage', 'V', 0, 1000],
                            ['current', 'A', -10000, 10000],
                        ],
                        now,
                    ),
                );
            }
        if (group.length) groups.push(group.slice(0, 2));
    }
    const pilot = packs('p', 'autopilot', at(doc, 'steering.autopilot'), [['state', '', 0, 7]], now);
    if (pilot.length) groups.push(pilot.slice(0, 1));
    // One of every reported group before a second instance. Never aggregate banks or phases.
    const selected = [...groups.map((group) => group[0]), ...groups.flatMap((group) => group.slice(1))].slice(0, 8);
    return Object.fromEntries(selected.map((packed, index) => ['sys_' + index + '_v1', packed]));
}
export function appendSystemsExtra(
    critical: Record<string, number | string> | undefined,
    optional: Record<string, string> | undefined,
): Record<string, number | string> | undefined {
    if (!optional || !Object.keys(optional).length) return critical;
    const result = { ...critical };
    for (let i = 0; i < 8; i++) {
        const key = 'sys_' + i + '_v1',
            value = optional[key];
        if (typeof value !== 'string' || value.length > 120 || key in result || Object.keys(result).length >= 40)
            continue;
        const candidate = { ...result, [key]: value };
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= 4096) result[key] = value;
    }
    return result;
}
