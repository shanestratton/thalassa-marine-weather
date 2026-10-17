/** User-entered boat data only. No rig defaults, polar changes or helm commands. */
export interface InventorySail {
    id: string;
    name: string;
    kind: 'main' | 'headsail' | 'mizzen' | 'spinnaker' | 'other';
    /** User's true-wind reef points, knots, in increasing order. */
    reefPointsKn: number[];
}
export interface SailCrossover {
    id: string;
    name: string;
    minTwsKn: number;
    maxTwsKn: number;
    minTwaDeg: number;
    maxTwaDeg: number;
    sails: Array<{ sailId: string; reef: number }>;
}
export interface SailInventory {
    schema: 1;
    sails: InventorySail[];
    plans: SailCrossover[];
    hysteresisKn: number;
}
export interface SailWindSample {
    twsKn: number;
    twaDeg: number;
    gustKn?: number | null;
    timeMs: number;
    sourceKey: string;
}
export interface SailRecommendation {
    planId: string;
    text: string;
    windKn: number;
    timeMs: number;
    scopeKey: string;
    sourceKey: string;
    inventoryKey: string;
    held: boolean;
    sails: Array<{ sailId: string; reef: number }>;
}

export const EMPTY_SAIL_INVENTORY: SailInventory = { schema: 1, sails: [], plans: [], hysteresisKn: 2 };
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown, low: number, high: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const name = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 60 &&
    [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);

/** Reject the whole malformed profile; never silently drop a sail from a plan. */
export function parseSailInventory(input: unknown): SailInventory | null {
    if (
        !object(input) ||
        input.schema !== 1 ||
        !Array.isArray(input.sails) ||
        input.sails.length > 24 ||
        !Array.isArray(input.plans) ||
        input.plans.length > 32 ||
        !number(input.hysteresisKn, 0, 5)
    )
        return null;
    const sails: InventorySail[] = [];
    const sailIds = new Set<string>();
    for (const raw of input.sails) {
        if (
            !object(raw) ||
            !id(raw.id) ||
            sailIds.has(raw.id) ||
            !name(raw.name) ||
            typeof raw.kind !== 'string' ||
            !['main', 'headsail', 'mizzen', 'spinnaker', 'other'].includes(raw.kind) ||
            !Array.isArray(raw.reefPointsKn) ||
            raw.reefPointsKn.length > 6 ||
            raw.reefPointsKn.some((v, i, rows) => !number(v, 0.1, 100) || (i > 0 && v <= rows[i - 1]))
        )
            return null;
        sailIds.add(raw.id);
        sails.push({
            id: raw.id,
            name: raw.name.trim(),
            kind: raw.kind as InventorySail['kind'],
            reefPointsKn: [...raw.reefPointsKn],
        });
    }
    const plans: SailCrossover[] = [];
    const planIds = new Set<string>();
    for (const raw of input.plans) {
        if (
            !object(raw) ||
            !id(raw.id) ||
            planIds.has(raw.id) ||
            !name(raw.name) ||
            !number(raw.minTwsKn, 0, 100) ||
            !number(raw.maxTwsKn, 0, 100) ||
            raw.minTwsKn >= raw.maxTwsKn ||
            !number(raw.minTwaDeg, 0, 180) ||
            !number(raw.maxTwaDeg, 0, 180) ||
            raw.minTwaDeg > raw.maxTwaDeg ||
            !Array.isArray(raw.sails) ||
            !raw.sails.length ||
            raw.sails.length > 24
        )
            return null;
        const used = new Set<string>();
        const selection: SailCrossover['sails'] = [];
        for (const item of raw.sails) {
            if (!object(item) || !id(item.sailId) || used.has(item.sailId)) return null;
            const sail = sails.find((s) => s.id === item.sailId);
            if (!sail || !number(item.reef, 0, sail.reefPointsKn.length) || !Number.isInteger(item.reef)) return null;
            used.add(item.sailId);
            selection.push({ sailId: item.sailId, reef: item.reef });
        }
        planIds.add(raw.id);
        plans.push({
            id: raw.id,
            name: raw.name.trim(),
            minTwsKn: raw.minTwsKn,
            maxTwsKn: raw.maxTwsKn,
            minTwaDeg: raw.minTwaDeg,
            maxTwaDeg: raw.maxTwaDeg,
            sails: selection,
        });
    }
    const value: SailInventory = { schema: 1, sails, plans, hysteresisKn: input.hysteresisKn };
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32_768 ? value : null;
}

/** Stronger winds take effect immediately; hysteresis only delays shaking reefs out. */
export function recommendSailPlan(input: {
    inventory: unknown;
    vesselType?: string;
    scopeKey: string;
    sample: SailWindSample | null;
    previous?: SailRecommendation | null;
}): SailRecommendation | null {
    const inventory = parseSailInventory(input.inventory),
        sample = input.sample;
    if (
        !inventory ||
        input.vesselType !== 'sail' ||
        !input.scopeKey ||
        !sample ||
        !number(sample.twsKn, 0, 100) ||
        !number(sample.twaDeg, 0, 180) ||
        !Number.isSafeInteger(sample.timeMs) ||
        sample.timeMs <= 0 ||
        typeof sample.sourceKey !== 'string' ||
        !sample.sourceKey.trim() ||
        sample.sourceKey.length > 512 ||
        (sample.gustKn != null && !number(sample.gustKn, 0, 150))
    )
        return null;
    const wind = Math.max(sample.twsKn, sample.gustKn ?? 0);
    const inventoryKey = JSON.stringify(inventory);
    const candidates = inventory.plans.filter((p) => sample.twaDeg >= p.minTwaDeg && sample.twaDeg <= p.maxTwaDeg);
    let chosen = candidates
        .filter((p) => wind >= p.minTwsKn && wind <= p.maxTwsKn)
        .sort((a, b) => b.minTwsKn - a.minTwsKn || a.maxTwsKn - b.maxTwsKn)[0];
    const previous = input.previous;
    let held = false;
    const samePrevious =
        previous &&
        previous.scopeKey === input.scopeKey &&
        previous.inventoryKey === inventoryKey &&
        previous.sourceKey === sample.sourceKey &&
        previous.timeMs <= sample.timeMs;
    if (samePrevious) {
        const old = candidates.find((p) => p.id === previous.planId);
        if (
            old &&
            wind >= old.minTwsKn - inventory.hysteresisKn &&
            wind <= old.maxTwsKn &&
            (!chosen || old.minTwsKn >= chosen.minTwsKn)
        ) {
            chosen = old;
            held = true;
        }
    }
    if (!chosen) return null;
    const selection = chosen.sails.map((item) => {
        const sail = inventory.sails.find((s) => s.id === item.sailId)!;
        let reef = Math.max(item.reef, sail.reefPointsKn.filter((threshold) => wind >= threshold).length);
        const old = samePrevious ? previous.sails.find((s) => s.sailId === item.sailId) : null;
        if (
            old &&
            old.reef > reef &&
            old.reef <= sail.reefPointsKn.length &&
            wind >= sail.reefPointsKn[old.reef - 1] - inventory.hysteresisKn
        ) {
            reef = old.reef;
            held = true;
        }
        return { sailId: item.sailId, reef };
    });
    const sails = selection.map((item) => {
        const sail = inventory.sails.find((s) => s.id === item.sailId)!;
        return `${sail.name}${item.reef ? ` reef ${item.reef}` : ' full'}`;
    });
    return {
        planId: chosen.id,
        text: `${chosen.name}: ${sails.join(' + ')}`,
        windKn: wind,
        timeMs: sample.timeMs,
        scopeKey: input.scopeKey,
        sourceKey: sample.sourceKey,
        inventoryKey,
        held,
        sails: selection,
    };
}
