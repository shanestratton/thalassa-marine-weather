/** Pi-kept route watch. The alarm process sees the route and generic vault
 * state; no licensed chart geometry enters it or the cloud relay. */
import fs from 'node:fs';
import path from 'node:path';
import { buildRouteIndex, type RoutePoint } from './lookaheadShared/services/routeProgress.js';
import {
    XTE_START,
    measureXteOnIndex,
    nextXteState,
    xteLimitNm,
    sanitiseUnderwayPrefs,
    type XteState,
    type UnderwayPrefs,
} from './lookaheadShared/services/underway/underwayRule.js';
import { collisionOwnStill } from './collisionRule/collisionRule.js';
import { readTrackFix, timestampAt } from './trackSignalk.js';
import type { VaultClient } from './vaultClient.js';
import type { PiUnderwayAlarm, PiUnderwayPass, PiUnderwayPushStatus } from './piUnderwayAlarmRelay.js';

export interface UnderwayConfiguration {
    key: string;
    route: RoutePoint[];
    draftM: number;
    ukcM: number;
    prefs: UnderwayPrefs;
}
export function validUnderwayConfiguration(raw: unknown): UnderwayConfiguration | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const q = raw as UnderwayConfiguration;
    if (
        typeof q.key !== 'string' ||
        q.key.length < 1 ||
        q.key.length > 256 ||
        !Array.isArray(q.route) ||
        q.route.length < 2 ||
        q.route.length > 1000 ||
        !q.route.every(
            (p) =>
                p &&
                Number.isFinite(p.lat) &&
                Math.abs(p.lat) <= 85 &&
                Number.isFinite(p.lon) &&
                Math.abs(p.lon) <= 180,
        ) ||
        !Number.isFinite(q.draftM) ||
        q.draftM <= 0 ||
        q.draftM > 20 ||
        !Number.isFinite(q.ukcM) ||
        q.ukcM < 0.5 ||
        q.ukcM > 3 ||
        !buildRouteIndex(q.route)
    )
        return null;
    return {
        key: q.key,
        route: q.route.map((p) => ({ lat: p.lat, lon: p.lon })),
        draftM: q.draftM,
        ukcM: q.ukcM,
        prefs: sanitiseUnderwayPrefs(q.prefs),
    };
}
export interface UnderwayWatchDependencies {
    self: () => Promise<unknown>;
    atAnchor: () => boolean;
    vault: Pick<VaultClient, 'lookahead'>;
    file?: string;
    now?: () => number;
    onPass?: (state: PiUnderwayPass) => void;
    pushStatus?: () => PiUnderwayPushStatus;
}
export class PiUnderwayWatch {
    private configuration: UnderwayConfiguration | null = null;
    private xte: XteState = XTE_START;
    private along: number | undefined;
    private chartDanger = false;
    private coverage = 'unavailable';
    private generation = 0;
    private busy = false;
    private alarms = new Map<PiUnderwayAlarm['kind'], PiUnderwayAlarm>();
    private timer: ReturnType<typeof setInterval> | undefined;
    private lastRaised = 0;
    constructor(private readonly deps: UnderwayWatchDependencies) {}
    private now() {
        return (this.deps.now ?? Date.now)();
    }
    private save(latched = this.xte.latched, leftEnd = this.xte.leftEnd): void {
        if (!this.deps.file) return;
        const temp = this.deps.file + '.tmp';
        fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
        fs.writeFileSync(temp, JSON.stringify({ schema: 1, configuration: this.configuration, latched, leftEnd }), {
            mode: 0o600,
        });
        fs.renameSync(temp, this.deps.file);
    }
    restore(): void {
        try {
            if (this.deps.file && fs.statSync(this.deps.file).size <= 64 * 1024) {
                const saved = JSON.parse(fs.readFileSync(this.deps.file, 'utf8'));
                this.configuration = validUnderwayConfiguration(saved?.schema === 1 ? saved.configuration : saved);
                if (this.configuration && saved?.schema === 1)
                    this.xte = { ...XTE_START, latched: saved.latched === true, leftEnd: saved.leftEnd === true };
            }
        } catch {
            /* No previous route: wait for an enrolled phone. */
        }
        this.start();
    }
    configure(raw: unknown): boolean {
        const next = validUnderwayConfiguration(raw);
        if (!next) return false;
        if (JSON.stringify(next) === JSON.stringify(this.configuration)) return true;
        const previous = this.configuration;
        this.configuration = next;
        try {
            this.save(false, false);
        } catch {
            this.configuration = previous;
            return false;
        }
        this.reset();
        this.start();
        return true;
    }
    private reset(): void {
        this.generation++;
        this.xte = XTE_START;
        this.along = undefined;
        this.chartDanger = false;
        this.coverage = 'unavailable';
        this.alarms.clear();
        this.publish();
    }
    standDown(): boolean {
        const previous = this.configuration;
        this.configuration = null;
        try {
            this.save(false, false);
        } catch {
            this.configuration = previous;
            return false;
        }
        this.reset();
        return true;
    }
    start(): void {
        if (!this.timer) {
            this.timer = setInterval(() => void this.pass(), 5000);
            this.timer.unref();
        }
    }
    close(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.generation++;
    }
    acknowledge(key: string): boolean {
        for (const alarm of this.alarms.values())
            if (alarm.key === key) {
                alarm.ackedAt = this.now();
                this.publish();
                return true;
            }
        return false;
    }
    private encounter(kind: PiUnderwayAlarm['kind'], active: boolean): void {
        if (!active) {
            this.alarms.delete(kind);
            return;
        }
        if (this.alarms.has(kind)) return;
        const at = Math.max(Math.floor(this.now()), this.lastRaised + 1);
        this.lastRaised = at;
        this.alarms.set(kind, { kind, key: `${kind}::${at}`, raisedAt: at, ackedAt: null });
    }
    describe() {
        return {
            v: 1,
            armed: this.configuration !== null,
            routeKey: this.configuration?.key ?? null,
            xte: this.xte.status,
            coverage: this.coverage,
            alarms: [...this.alarms.values()].map((a) => ({ ...a })),
            push: this.deps.pushStatus?.() ?? null,
        };
    }
    private publish(): void {
        this.deps.onPass?.({
            armed: this.configuration !== null,
            alarms: [...this.alarms.values()].map((a) => ({ ...a })),
        });
    }
    async pass(): Promise<void> {
        if (this.busy || !this.configuration) return;
        this.busy = true;
        const generation = this.generation;
        const q = this.configuration;
        try {
            const doc = await this.deps.self();
            if (generation !== this.generation) return;
            const fix = readTrackFix(doc);
            const now = this.now();
            const at = timestampAt(doc, 'navigation.position', false);
            const fresh = at !== null && now - at <= 30000 && at - now <= 5000;
            // Each motion value needs its own fresh report. Signal K holds a
            // disconnected sensor's value forever, so receipt time is no proof.
            const freshMotion = (p: string) => {
                const t = timestampAt(doc, p, false);
                return t !== null && now - t <= 30000 && t - now <= 5000;
            };
            const sog = freshMotion('navigation.speedOverGround') ? (fix?.sogKts ?? null) : null;
            const cog = freshMotion('navigation.courseOverGroundTrue') ? (fix?.cogDeg ?? null) : null;
            const still = this.deps.atAnchor() || sog === null || collisionOwnStill(sog, false);
            const measure =
                fresh && fix
                    ? measureXteOnIndex(buildRouteIndex(q.route), fix, {
                          alongNm: this.along,
                          headingDeg: cog ?? undefined,
                      })
                    : null;
            if (measure) this.along = measure.alongNm;
            const limit = xteLimitNm(null, measure?.leg ?? null, q.prefs.offRoute);
            const priorXte = this.xte;
            this.xte = nextXteState(this.xte, {
                fixAt: fresh ? at : null,
                offTrackNm: measure?.offTrackNm ?? null,
                limitNm: limit.limitNm,
                offshore: limit.offshore,
                still,
                remainingNm: measure?.remainingNm,
                endNm: measure?.endNm,
            });
            if (this.xte.latched !== priorXte.latched || this.xte.leftEnd !== priorXte.leftEnd) {
                try {
                    this.save();
                } catch {
                    /* The live watch continues; no persistence claim is returned. */
                }
            }
            const muted = this.alarms.get('off-route');
            if (muted?.ackedAt !== null && muted?.ackedAt !== undefined && now - muted.ackedAt >= 30 * 60000)
                this.alarms.delete('off-route');
            this.encounter('off-route', q.prefs.offRoute.enabled && this.xte.sounding);
            if (this.xte.arrived || this.deps.atAnchor()) {
                this.chartDanger = false;
                this.coverage = this.xte.arrived ? 'arrived' : 'at-anchor';
            } else if (fresh && fix && sog !== null && sog > 0.5 && cog !== null && this.deps.vault.lookahead) {
                const answer = await this.deps.vault.lookahead({
                    fix: { lat: fix.lat, lon: fix.lon, at: at!, sogKn: sog, cogDeg: cog },
                    draftM: q.draftM,
                    ukcM: q.ukcM,
                    windowMin: 10,
                    onLine: (measure?.offTrackNm ?? Infinity) <= 0.02,
                });
                if (generation !== this.generation) return;
                if (this.deps.atAnchor()) {
                    this.chartDanger = false;
                    this.coverage = 'at-anchor';
                } else if (this.now() - at! > 30_000) {
                    this.coverage = 'unavailable';
                } else {
                    this.coverage = answer.coverage;
                    if (answer.danger) this.chartDanger = true;
                    else if (answer.coverage === 'charted') this.chartDanger = false;
                }
            } else this.coverage = 'unavailable';
            this.encounter('chart-ahead', this.chartDanger);
            this.publish();
        } catch {
            if (generation === this.generation) {
                this.coverage = 'unavailable';
                this.publish();
            }
        } finally {
            this.busy = false;
        }
    }
}
