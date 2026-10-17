/** RAM-only foreground intent. No storage, background watcher or retry queue. */
export type PresenceTier = 'off' | 'crew' | 'friends' | 'nearby';
export interface PresenceConfig {
    vesselId: string | null;
    vesselName: string | null;
    tier: PresenceTier;
    revision: string;
    sequence: number;
    readerRevision: string;
    publisherRevision: string;
    publisherActive: boolean;
    serverTime: string;
}
export interface PresencePoint {
    id: string;
    label: string;
    tier: Exclude<PresenceTier, 'off'>;
    latitude: number;
    longitude: number;
    bucketAt: string;
    validUntil: string;
}
export interface PresenceFriend {
    id: string;
    label: string;
    direction: 'sharing' | 'following';
    acceptedAt: string;
}
export interface PresenceContext {
    key: string;
    identity: string;
    userId: string | null;
    vesselId: string | null;
    allowed: boolean;
}
export interface PresenceSnapshot {
    config: PresenceConfig | null;
    viewing: boolean;
    publishing: boolean;
    foreground: boolean;
    points: readonly PresencePoint[];
    friends: readonly PresenceFriend[];
    status: string;
    busy: boolean;
}
export interface PresenceDependencies {
    context: () => PresenceContext;
    request: (action: string, input: Record<string, unknown>, context: PresenceContext) => Promise<unknown>;
    fix: () => { latitude: number; longitude: number; timestamp: number } | null;
    uuid: () => string;
    wall: () => number;
    monotonic: () => number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tiers = new Set(['off', 'crew', 'friends', 'nearby']);
const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid presence response');
    return v as Record<string, unknown>;
};
const text = (v: unknown, max = 120) => {
    if (typeof v !== 'string' || !v.length || v.length > max) throw new Error('Invalid presence response');
    return v;
};
const id = (v: unknown) => {
    const x = text(v, 36);
    if (!uuid.test(x)) throw new Error('Invalid presence revision');
    return x;
};
const time = (v: unknown) => {
    const x = text(v, 64);
    if (!Number.isFinite(Date.parse(x))) throw new Error('Invalid presence clock');
    return x;
};
export function parsePresenceConfig(value: unknown): PresenceConfig {
    const v = object(value);
    if (
        !tiers.has(String(v.tier)) ||
        typeof v.sequence !== 'number' ||
        !Number.isSafeInteger(v.sequence) ||
        v.sequence < 1 ||
        typeof v.publisherActive !== 'boolean'
    )
        throw new Error('Invalid presence controls');
    return {
        vesselId: v.vesselId === null ? null : id(v.vesselId),
        vesselName: v.vesselName === null ? null : text(v.vesselName),
        tier: v.tier as PresenceTier,
        revision: id(v.revision),
        sequence: v.sequence,
        readerRevision: id(v.readerRevision),
        publisherRevision: id(v.publisherRevision),
        publisherActive: v.publisherActive,
        serverTime: time(v.serverTime),
    };
}
export function parsePresencePoints(value: unknown): { points: PresencePoint[]; serverTime: number; until: number } {
    const v = object(value),
        serverTime = Date.parse(time(v.serverTime)),
        until = Date.parse(time(v.validUntil));
    if (!Array.isArray(v.points) || v.points.length > 100 || until < serverTime || until - serverTime > 30000)
        throw new Error('Invalid presence lease');
    const seen = new Set<string>();
    const points = v.points.map((raw) => {
        const p = object(raw),
            handle = text(p.id, 64),
            lat = p.latitude,
            lon = p.longitude;
        const bucketAt = time(p.bucketAt),
            validUntil = time(p.validUntil);
        if (
            !/^[0-9a-f]{64}$/.test(handle) ||
            seen.has(handle) ||
            !['crew', 'friends', 'nearby'].includes(String(p.tier)) ||
            typeof lat !== 'number' ||
            !Number.isFinite(lat) ||
            lat < -90 ||
            lat > 90 ||
            typeof lon !== 'number' ||
            !Number.isFinite(lon) ||
            lon < -180 ||
            lon > 180 ||
            Math.abs((lat + 89.975) * 20 - Math.round((lat + 89.975) * 20)) > 1e-7 ||
            Math.abs((lon + 179.975) * 20 - Math.round((lon + 179.975) * 20)) > 1e-7 ||
            serverTime - Date.parse(bucketAt) < 300000 ||
            serverTime - Date.parse(bucketAt) > 1200000 ||
            Date.parse(validUntil) <= serverTime ||
            Date.parse(validUntil) > until
        )
            throw new Error('Invalid rounded delayed presence');
        seen.add(handle);
        return {
            id: handle,
            label: text(p.label),
            tier: p.tier as PresencePoint['tier'],
            latitude: lat,
            longitude: lon,
            bucketAt,
            validUntil,
        };
    });
    return { points, serverTime, until };
}
interface Session {
    nonce: string;
    expected: string;
    revision: string;
    context: PresenceContext;
    until: number;
}
const initial = (): PresenceSnapshot => ({
    config: null,
    viewing: false,
    publishing: false,
    foreground: false,
    points: [],
    friends: [],
    status: 'Off',
    busy: false,
});
export class BoatPresenceController {
    private state = initial();
    private listeners = new Set<() => void>();
    private generation = 0;
    private reader: Session | null = null;
    private publisher: Session | null = null;
    private deadline = 0;
    private pointDeadlines = new Map<string, number>();
    private tickBusy = false;
    private lastFixTimestamp = 0;
    constructor(private readonly deps: PresenceDependencies) {}
    snapshot = () => this.state;
    subscribe = (fn: () => void) => {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    };
    private patch(next: Partial<PresenceSnapshot>) {
        this.state = { ...this.state, ...next };
        for (const fn of this.listeners) fn();
    }
    private current(c: PresenceContext, gen: number) {
        const n = this.deps.context();
        return (
            gen === this.generation &&
            c.key === n.key &&
            c.userId === n.userId &&
            c.vesselId === n.vesselId &&
            n.allowed
        );
    }
    private context() {
        const c = this.deps.context();
        if (!c.userId || !c.allowed) throw new Error('Sign in on a normal connection to use boat presence.');
        return c;
    }
    private async request(action: string, input: Record<string, unknown>, c = this.context(), gen = this.generation) {
        const value = await this.deps.request(action, input, c);
        if (!this.current(c, gen)) throw new Error('Presence context changed');
        return value;
    }
    private stop(session: Session | null, kind: 'reader' | 'publisher') {
        if (!session) return;
        const now = this.deps.context();
        if (!now.allowed || now.userId !== session.context.userId || now.identity !== session.context.identity) return;
        // Best effort only, with the OLD captured context. Never replay later.
        void this.deps
            .request(
                'end',
                { revision: session.revision, sessionRevision: session.expected, kind, nonce: session.nonce },
                session.context,
            )
            .catch(() => {});
    }
    /** Call synchronously BEFORE exposing any new auth/vessel/network intent. */
    retire = (reason = 'Off') => {
        const r = this.reader,
            p = this.publisher;
        this.generation++;
        this.reader = null;
        this.publisher = null;
        this.deadline = 0;
        this.pointDeadlines.clear();
        this.tickBusy = false;
        this.lastFixTimestamp = 0;
        this.patch({ ...initial(), foreground: this.state.foreground, status: reason });
        this.stop(r, 'reader');
        this.stop(p, 'publisher');
    };
    setForeground(active: boolean) {
        if (!active) this.retire('Foreground session ended');
        this.patch({ foreground: active });
    }
    async load() {
        const c = this.context(),
            gen = this.generation;
        const config = parsePresenceConfig(await this.request('state', {}, c, gen));
        if (config.vesselId !== c.vesselId)
            throw new Error('Active vessel is still syncing. Reload after it is saved.');
        this.patch({ config, status: this.state.viewing || this.state.publishing ? this.state.status : 'Off' });
        return config;
    }
    async configure(tier: PresenceTier) {
        const config = this.state.config;
        if (!config) throw new Error('Load presence controls first');
        const c = this.context();
        this.retire('Saving sharing choice');
        const gen = this.generation;
        this.patch({ busy: true });
        try {
            const next = parsePresenceConfig(
                await this.request('configure', { revision: config.revision, tier }, c, gen),
            );
            this.patch({ config: next, status: 'Choice saved; publication is off' });
        } finally {
            if (this.current(c, gen)) this.patch({ busy: false });
        }
    }
    async setSession(kind: 'reader' | 'publisher', on: boolean) {
        if (!on) {
            const session = kind === 'reader' ? this.reader : this.publisher;
            if (kind === 'reader') {
                this.reader = null;
                this.deadline = 0;
                this.pointDeadlines.clear();
                this.patch({ viewing: false, points: [], status: 'Viewing off' });
            } else {
                this.publisher = null;
                this.patch({ publishing: false, status: 'Publication off' });
            }
            this.stop(session, kind);
            return;
        }
        if (kind === 'reader' ? this.reader : this.publisher) return;
        const c = this.context(),
            gen = this.generation;
        if (!this.state.foreground || !c.vesselId) throw new Error('Open Obs with an active owned vessel first.');
        const config = this.state.config ?? (await this.load());
        if (!this.current(c, gen)) return;
        if (kind === 'publisher' && config.tier === 'off') throw new Error('Choose and save a sharing audience first.');
        const session: Session = {
            nonce: this.deps.uuid(),
            expected: kind === 'reader' ? config.readerRevision : config.publisherRevision,
            revision: config.revision,
            context: c,
            until: this.deps.monotonic() + 45000,
        };
        if (kind === 'reader') this.reader = session;
        else this.publisher = session;
        this.patch(
            kind === 'reader'
                ? { viewing: true, status: 'Starting private viewing context' }
                : { publishing: true, status: 'Starting delayed publication' },
        );
        try {
            const next = parsePresenceConfig(
                await this.request(
                    'begin',
                    { revision: config.revision, sessionRevision: session.expected, kind, nonce: session.nonce },
                    c,
                    gen,
                ),
            );
            if ((kind === 'reader' ? this.reader : this.publisher) !== session) return;
            this.patch({ config: next });
            await this.tick();
        } catch (error) {
            if (this.current(c, gen) && (kind === 'reader' ? this.reader : this.publisher) === session)
                this.retire('Session stopped; start again explicitly');
            throw error;
        }
    }
    expire = () => {
        const now = this.deps.monotonic();
        if ((this.reader && now >= this.reader.until) || (this.publisher && now >= this.publisher.until)) {
            this.retire('Foreground GPS lease expired; start again explicitly');
            return;
        }
        if (this.deadline && now >= this.deadline) {
            this.deadline = 0;
            this.pointDeadlines.clear();
            this.patch({ points: [], status: 'Snapshot expired; waiting for a fresh check' });
        } else {
            const points = this.state.points.filter((p) => now < (this.pointDeadlines.get(p.id) ?? 0));
            if (points.length !== this.state.points.length) this.patch({ points });
        }
    };
    async tick() {
        this.expire();
        if (this.tickBusy || (!this.reader && !this.publisher)) return;
        const c = this.context(),
            gen = this.generation,
            r = this.reader,
            p = this.publisher;
        if (!this.state.foreground) {
            this.retire('Foreground session ended');
            return;
        }
        const fix = this.deps.fix(),
            now = this.deps.wall();
        if (
            !fix ||
            !Number.isFinite(fix.timestamp) ||
            fix.timestamp < now - 30000 ||
            fix.timestamp > now + 5000 ||
            !Number.isFinite(fix.latitude) ||
            !Number.isFinite(fix.longitude) ||
            Math.abs(fix.latitude) > 90 ||
            Math.abs(fix.longitude) > 180
        ) {
            this.patch({ points: [], status: 'Waiting for a fresh phone GPS fix; no new position sent' });
            return;
        }
        if (fix.timestamp <= this.lastFixTimestamp) {
            this.patch({ status: 'Waiting for the next phone GPS fix' });
            return;
        }
        this.tickBusy = true;
        try {
            const config = this.state.config;
            if (!config) return;
            const fixBegan = this.deps.monotonic();
            await this.request(
                'fix',
                {
                    revision: config.revision,
                    ...(r ? { readerNonce: r.nonce } : {}),
                    ...(p ? { publisherNonce: p.nonce } : {}),
                    latitude: fix.latitude,
                    longitude: fix.longitude,
                    observedAt: new Date(fix.timestamp).toISOString(),
                },
                c,
                gen,
            );
            if (this.reader !== r || this.publisher !== p) return;
            this.lastFixTimestamp = fix.timestamp;
            if (r) r.until = fixBegan + 45000;
            if (p) p.until = fixBegan + 45000;
            if (r) {
                const began = this.deps.monotonic(),
                    raw = await this.request('nearby', { revision: config.revision, readerNonce: r.nonce }, c, gen);
                if (this.reader !== r) return;
                const parsed = parsePresencePoints(raw),
                    elapsed = this.deps.monotonic() - began;
                this.deadline =
                    this.deps.monotonic() + Math.max(0, Math.min(30000, parsed.until - parsed.serverTime) - elapsed);
                this.pointDeadlines = new Map(
                    parsed.points.map((x) => [
                        x.id,
                        this.deps.monotonic() + Math.max(0, Date.parse(x.validUntil) - parsed.serverTime - elapsed),
                    ]),
                );
                this.patch({
                    points: parsed.points.filter((x) => (this.pointDeadlines.get(x.id) ?? 0) > this.deps.monotonic()),
                });
            }
            this.patch({
                status: p
                    ? 'Publishing rounded positions with a delay of at least 5 minutes'
                    : 'Viewing only; your position is not shared',
            });
        } catch (error) {
            if (this.current(c, gen)) this.retire('Session ended; check connection and start again');
            throw error;
        } finally {
            if (this.current(c, gen)) this.tickBusy = false;
        }
    }
    async friends() {
        const v = object(await this.request('friends', {}));
        if (!Array.isArray(v.friends) || v.friends.length > 200) throw new Error('Invalid friends response');
        const friends = v.friends.map((raw) => {
            const f = object(raw);
            if (!['sharing', 'following'].includes(String(f.direction))) throw new Error('Invalid friend');
            return {
                id: id(f.id),
                label: text(f.label),
                direction: f.direction as PresenceFriend['direction'],
                acceptedAt: time(f.acceptedAt),
            };
        });
        this.patch({ friends });
    }
    async invite(label: string) {
        const config = this.state.config;
        if (!config) throw new Error('Load controls first');
        const v = object(await this.request('invite', { revision: config.revision, label }));
        const token = text(v.token, 64);
        if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid invitation');
        return { token, expiresAt: time(v.expiresAt) };
    }
    async invitation(token: string, accept = false) {
        if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Paste the complete invitation token');
        const v = object(await this.request(accept ? 'accept' : 'preview', { token }));
        if (accept && v.accepted !== true) throw new Error('Invitation not accepted');
        return { vesselName: text(v.vesselName), expiresAt: time(v.expiresAt) };
    }
    async revoke(grantId: string) {
        id(grantId);
        await this.request('revoke', { grantId });
        await this.friends();
        this.patch({ points: [] });
    }
}
