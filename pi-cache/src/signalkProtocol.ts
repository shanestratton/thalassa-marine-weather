/** Portable read-only Signal K subset. No network, credentials or receipt-clock substitution. */
export const SIGNALK_READ_PATHS = [
    'navigation.position',
    'navigation.speedOverGround',
    'navigation.courseOverGroundTrue',
    'navigation.speedThroughWater',
    'navigation.headingTrue',
    'navigation.headingMagnetic',
    'navigation.magneticVariation',
    'navigation.leewayAngle',
    'navigation.attitude',
    'environment.wind.speedTrue',
    'environment.wind.angleTrueWater',
    'environment.wind.directionTrue',
    'environment.wind.speedApparent',
    'environment.wind.angleApparent',
    'environment.depth.belowKeel',
    'environment.depth.belowTransducer',
    'environment.depth.belowSurface',
    'environment.depth.transducerToKeel',
    'environment.water.temperature',
    'environment.outside.pressure',
    'steering.rudderAngle',
] as const;
export interface SignalKLeaf {
    value: unknown;
    timestamp: string;
    $source: string;
    meta?: { units: string };
}
export interface SignalKNotice {
    path: string;
    source: string;
    at: number;
    receivedAt: number;
    message: string;
    state: 'normal' | 'alert' | 'warn' | 'alarm' | 'emergency';
    soundRequested: boolean;
}
export interface SignalKNoticeEvent {
    notice: SignalKNotice;
    /** Only new, source-dated events; UI still requires opt-in. */ fresh: boolean;
}
const staticPaths = new Set<string>(SIGNALK_READ_PATHS);
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
export const signalkRecord = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const finite = (v: unknown, low: number, high: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high;
export function validSignalKSelf(value: unknown): value is string {
    return typeof value === 'string' && /^urn:[A-Za-z0-9][A-Za-z0-9:._-]{2,180}$/.test(value);
}
export function signalKReadPath(path: string): boolean {
    return (
        !path.split('.').some((key) => BAD_KEYS.has(key)) &&
        (staticPaths.has(path) ||
            /^propulsion\.[A-Za-z0-9_-]{1,40}\.(revolutions|runTime|coolantTemperature|oilPressure)$/.test(path))
    );
}
function validValue(path: string, value: unknown): boolean {
    if (value === null) return true;
    if (path === 'navigation.position') {
        const p = signalkRecord(value);
        return !!p && finite(p.latitude, -90, 90) && finite(p.longitude, -180, 180);
    }
    if (path === 'navigation.attitude') {
        const p = signalkRecord(value);
        return (
            !!p &&
            Object.keys(p).length <= 3 &&
            Object.entries(p).every(([k, v]) => ['roll', 'pitch', 'yaw'].includes(k) && finite(v, -Math.PI, Math.PI))
        );
    }
    if (path.endsWith('revolutions')) return finite(value, 0, 250);
    if (path.endsWith('runTime')) return finite(value, 0, 3_153_600_000);
    if (path.endsWith('coolantTemperature')) return finite(value, 213.15, 473.15);
    if (path.endsWith('oilPressure')) return finite(value, 0, 5_000_000);
    if (path.endsWith('temperature')) return finite(value, 213.15, 333.15);
    if (path.endsWith('.pressure')) return finite(value, 80_000, 110_000);
    if (path.includes('depth.')) return finite(value, path.endsWith('belowKeel') ? -20 : 0, 12_000);
    if (path.includes('speed')) return finite(value, 0, 150);
    if (path === 'navigation.leewayAngle') return finite(value, -Math.PI / 9, Math.PI / 9);
    return finite(value, -2 * Math.PI, 2 * Math.PI);
}
function expectedUnit(path: string): string {
    if (path === 'navigation.position') return 'position';
    if (path.endsWith('revolutions')) return 'Hz';
    if (path.endsWith('runTime')) return 's';
    if (path.endsWith('Pressure') || path.endsWith('.pressure')) return 'Pa';
    if (path.endsWith('Temperature') || path.endsWith('.temperature')) return 'K';
    if (path.includes('depth.')) return 'm';
    if (path.includes('speed')) return 'm/s';
    return 'rad';
}
function timestamp(raw: unknown, now: number): number | null {
    if (typeof raw !== 'string' || raw.length > 40 || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return null;
    const at = Date.parse(raw);
    return Number.isSafeInteger(at) && at > 0 && at <= now + 1_000 ? at : null;
}
function sourceId(update: Record<string, unknown>): string | null {
    if (typeof update.$source === 'string' && /^[A-Za-z0-9:._/-]{1,120}$/.test(update.$source)) return update.$source;
    const src = signalkRecord(update.source);
    if (!src || typeof src.label !== 'string' || !/^[A-Za-z0-9:._/-]{1,80}$/.test(src.label)) return null;
    const suffix = typeof src.src === 'string' || typeof src.src === 'number' ? String(src.src) : '';
    return /^[A-Za-z0-9:._/-]{0,20}$/.test(suffix) ? `${src.label}${suffix ? ':' + suffix : ''}` : null;
}
function cloneValue(value: unknown): unknown {
    const record = signalkRecord(value);
    if (!record) return value;
    return Object.fromEntries(Object.entries(record).filter(([k]) => !BAD_KEYS.has(k)));
}

/** A bounded self-vessel cache. A sibling/GPS/HTTP timestamp never dates another leaf. */
export class SignalKReadState {
    private leaves = new Map<string, SignalKLeaf>();
    private notices = new Map<string, SignalKNotice>();
    private noticeClocks = new Map<string, number>();
    private engines = new Set<string>();
    constructor(public readonly selfUrn: string) {
        if (!validSignalKSelf(selfUrn)) throw new Error('Signal K self identity unavailable');
    }
    clear(): void {
        this.leaves.clear();
        this.notices.clear();
        this.noticeClocks.clear();
        this.engines.clear();
    }
    /** REST bootstrap only: require this vessel identity, exact leaf envelopes and source times. */
    ingestSelfDocument(doc: unknown, now = Date.now()): boolean {
        const root = signalkRecord(doc);
        if (!root || root.uuid !== this.selfUrn) return false;
        const paths = [...SIGNALK_READ_PATHS];
        const propulsion = signalkRecord(root.propulsion);
        const all: string[] = [...paths];
        for (const id of Object.keys(propulsion ?? {}).slice(0, 9)) {
            for (const leaf of ['revolutions', 'runTime', 'coolantTemperature', 'oilPressure'])
                all.push(`propulsion.${id}.${leaf}`);
        }
        let changed = false;
        for (const path of all) {
            let item: unknown = root;
            for (const key of path.split('.')) item = signalkRecord(item)?.[key];
            const leaf = signalkRecord(item);
            if (leaf) changed = this.put(path, leaf.value, leaf.timestamp, leaf.$source, leaf.meta, now) || changed;
        }
        return changed;
    }
    private put(path: string, value: unknown, stamp: unknown, source: unknown, meta: unknown, now: number): boolean {
        if (!signalKReadPath(path) || !validValue(path, value)) return false;
        const at = timestamp(stamp, now);
        if (
            at === null ||
            now - at > 72 * 3600_000 ||
            typeof source !== 'string' ||
            !/^[A-Za-z0-9:._/-]{1,120}$/.test(source)
        )
            return false;
        const units = signalkRecord(meta)?.units;
        if (units !== undefined && units !== expectedUnit(path)) return false;
        if (path.startsWith('propulsion.')) {
            const id = path.split('.')[1];
            if (!this.engines.has(id) && this.engines.size >= 8) return false;
            this.engines.add(id);
        }
        const old = this.leaves.get(path);
        if (old && Date.parse(old.timestamp) >= at) return false;
        this.leaves.set(path, {
            value: cloneValue(value),
            timestamp: new Date(at).toISOString(),
            $source: source,
            ...(typeof units === 'string' ? { meta: { units } } : {}),
        });
        return true;
    }
    ingestDelta(value: unknown, now = Date.now()): { changed: boolean; notices: SignalKNoticeEvent[] } {
        const row = signalkRecord(value);
        const result: { changed: boolean; notices: SignalKNoticeEvent[] } = { changed: false, notices: [] };
        if (!row || row.context !== `vessels.${this.selfUrn}` || !Array.isArray(row.updates) || row.updates.length > 64)
            return result;
        for (const raw of row.updates) {
            const update = signalkRecord(raw);
            if (!update || !Array.isArray(update.values) || update.values.length > 128) continue;
            const source = sourceId(update),
                at = timestamp(update.timestamp, now);
            if (!source || at === null || now - at > 72 * 3600_000) continue;
            for (const entry of update.values) {
                const v = signalkRecord(entry);
                if (!v || typeof v.path !== 'string' || v.path.length > 160) continue;
                if (v.path.startsWith('notifications.')) {
                    const event = this.putNotice(v.path, v.value, source, at, now);
                    if (event) result.notices.push(event);
                } else
                    result.changed =
                        this.put(v.path, v.value, update.timestamp, source, undefined, now) || result.changed;
            }
        }
        return result;
    }
    private putNotice(
        path: string,
        value: unknown,
        source: string,
        at: number,
        now: number,
    ): SignalKNoticeEvent | null {
        if (
            !/^notifications\.[A-Za-z0-9_-]{1,40}(?:\.[A-Za-z0-9_-]{1,40}){0,3}$/.test(path) ||
            path.split('.').some((k) => BAD_KEYS.has(k))
        )
            return null;
        const key = `${source}|${path}`,
            previous = this.noticeClocks.get(key);
        if (previous !== undefined && at <= previous) return null;
        if (previous === undefined && this.noticeClocks.size >= 64) return null;
        if (value === null) {
            this.noticeClocks.set(key, at);
            this.notices.delete(key);
            return null;
        }
        const v = signalkRecord(value);
        if (
            !v ||
            typeof v.message !== 'string' ||
            v.message.length > 320 ||
            !['normal', 'alert', 'warn', 'alarm', 'emergency'].includes(String(v.state))
        )
            return null;
        const notice: SignalKNotice = {
            path,
            source,
            at,
            receivedAt: now,
            message: v.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160),
            state: v.state as SignalKNotice['state'],
            soundRequested: Array.isArray(v.method) && v.method.length <= 4 && v.method.includes('sound'),
        };
        this.noticeClocks.set(key, at);
        this.notices.set(key, notice);
        return { notice: { ...notice }, fresh: now - at >= 0 && now - at <= 10_000 && previous !== undefined };
    }
    notifications(now = Date.now()): SignalKNotice[] {
        return [...this.notices.values()].filter((n) => now - n.at <= 72 * 3600_000).map((n) => ({ ...n }));
    }
    document(): Record<string, unknown> {
        const root: Record<string, unknown> = { uuid: this.selfUrn };
        for (const [path, leaf] of this.leaves) {
            const parts = path.split('.');
            let node = root;
            for (const key of parts.slice(0, -1)) {
                node[key] ??= {};
                node = node[key] as Record<string, unknown>;
            }
            node[parts.at(-1)!] = {
                ...leaf,
                value: cloneValue(leaf.value),
                ...(leaf.meta ? { meta: { ...leaf.meta } } : {}),
            };
        }
        return root;
    }
}
