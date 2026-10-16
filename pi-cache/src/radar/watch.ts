/** Explicit, RAM-only Pi radar controller. Reads the guarded cache; never opens a source. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RadarEncounters } from './radarEncounters.js';
import { decodeRadarOwnship, restoreRadarObservation } from './radarFeed.js';
import { gradeRadarContact, radarCollisionOwnship } from './radarCollision.js';
import {
    ownMotionState,
    sanitiseCollisionPrefs,
    type CollisionPairName,
    type CollisionPrefs,
} from '../collisionRule/collisionRule.js';
import {
    radarContextKey,
    radarRecord,
    validRadarContext,
    validRadarController,
    type RadarController,
    type RadarWatchCommand,
    type RadarWatchStatus,
    type RadarWatchAlarm,
} from './radarWatchContract.js';
import {
    radarRelayKeyCanonical,
    type RadarRelayAck,
    type RadarRelayContext,
    type RadarRelayResolved,
    type RadarRelayUpsert,
} from './radarRelayContract.js';
import type { RadarRawSnapshot } from './rawReader.js';
export interface RadarServerContext {
    ownerId: string;
    piDeviceId: string;
    pairingId: string;
    feedId: string;
    contextToken: string;
}
export type RadarWatchEvent =
    | { action: 'bind' | 'retire'; context: RadarRelayContext }
    | { action: 'ack'; context: RadarRelayContext; ack: RadarRelayAck }
    | { action: 'resolved'; context: RadarRelayContext; resolved: RadarRelayResolved };
export interface RadarWatchRelayPass {
    context: RadarRelayContext;
    evaluatedAt: number;
    upserts: RadarRelayUpsert[];
}
export interface RadarWatchDeps {
    readSnapshot: () => RadarRawSnapshot;
    currentContext: () => RadarServerContext | null;
    aisArmed: () => boolean;
    atAnchor: () => boolean;
    controllerCurrent: (controller: RadarController, context: RadarServerContext) => boolean | Promise<boolean>;
    now?: () => number;
    onEvent?: (event: RadarWatchEvent) => void;
    /** Nonblocking bounded relay receives scalar facts only, and must recheck isCurrent after awaits. */
    onPass?: (pass: RadarWatchRelayPass, isCurrent: () => boolean) => void;
    pushStatus?: () => RadarWatchStatus['push'];
}
export class RadarWatchError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
    ) {
        super(code);
    }
}
interface Active {
    context: RadarRelayContext;
    server: RadarServerContext;
    prefs: CollisionPrefs;
    model: RadarEncounters;
}
const baseKey = (c: RadarServerContext | null) =>
    c ? JSON.stringify([c.ownerId, c.piDeviceId, c.pairingId, c.feedId, c.contextToken]) : 'null';
const same = (a: RadarRelayContext | null, b: RadarRelayContext | null) => radarContextKey(a) === radarContextKey(b);
export function radarAlarmKey(
    context: RadarRelayContext,
    card: Pick<RadarWatchAlarm, 'episodeId' | 'contactKey' | 'raisedAt' | 'closeQuarters'>,
): string {
    const kind = card.closeQuarters ? 'radar-close-quarters' : 'radar-collision';
    return `${kind}:${createHash('sha256')
        .update(radarRelayKeyCanonical(context, { ...card, kind }))
        .digest('hex')
        .slice(0, 12)}:${card.raisedAt}`;
}
function readCommand(raw: unknown): RadarWatchCommand {
    if (
        !radarRecord(raw) ||
        Object.keys(raw).some((k) => !['armed', 'expected', 'prefs', 'replaceController'].includes(k)) ||
        typeof raw.armed !== 'boolean' ||
        (raw.expected !== null && !validRadarContext(raw.expected)) ||
        (raw.replaceController !== undefined && raw.replaceController !== true)
    )
        throw new RadarWatchError(400, 'radar_invalid_command');
    if (!raw.armed) {
        if (raw.prefs !== undefined || raw.replaceController !== undefined)
            throw new RadarWatchError(400, 'radar_invalid_command');
        return { armed: false, expected: raw.expected };
    }
    const prefs = sanitiseCollisionPrefs(raw.prefs);
    if (
        !radarRecord(raw.prefs) ||
        Object.keys(raw.prefs).length !== 2 ||
        !['offshore', 'inshore'].every((key) => {
            const p = (raw.prefs as Record<string, unknown>)[key],
                clean = prefs[key as keyof CollisionPrefs];
            return (
                radarRecord(p) && Object.keys(p).length === 2 && p.cpaNm === clean.cpaNm && p.tcpaMin === clean.tcpaMin
            );
        })
    )
        throw new RadarWatchError(400, 'radar_invalid_preferences');
    return {
        armed: true,
        expected: raw.expected,
        prefs,
        ...(raw.replaceController ? { replaceController: true } : {}),
    };
}
export class RadarWatch {
    private active: Active | null = null;
    private revision = 0;
    private generation = 0;
    private evaluatedAt: number | null = null;
    private phase: RadarWatchStatus['state'] = 'off';
    private pairs = new Map<string, CollisionPairName>();
    private identities = new Map<string, RadarWatchAlarm>();
    private explicitAcks = new Map<string, RadarRelayAck>();
    private tickPending = false;
    private readonly instance = randomUUID();
    constructor(private readonly deps: RadarWatchDeps) {}
    private now() {
        return (this.deps.now ?? Date.now)();
    }
    private current(active: Active): boolean {
        return (
            this.active === active &&
            baseKey(active.server) === baseKey(this.deps.currentContext()) &&
            this.deps.aisArmed()
        );
    }
    private emit(event: RadarWatchEvent) {
        this.deps.onEvent?.(structuredClone(event));
    }
    /** Must run synchronously before root changes pairing/source context or shuts down. */
    stop(): void {
        const old = this.active;
        this.generation++;
        this.active = null;
        this.revision++;
        this.phase = 'off';
        this.evaluatedAt = null;
        this.pairs.clear();
        this.identities.clear();
        this.explicitAcks.clear();
        old?.model.reset();
        if (old) this.emit({ action: 'retire', context: old.context });
    }
    private async validate(): Promise<Active | null> {
        const active = this.active;
        if (!active) return null;
        if (!this.current(active)) {
            this.stop();
            return null;
        }
        const generation = this.generation;
        let enrolled = false;
        try {
            enrolled = await this.deps.controllerCurrent(
                {
                    deviceId: active.context.binding.deviceId,
                    enrollmentRevision: active.context.binding.enrollmentRevision,
                },
                active.server,
            );
        } catch {
            this.phase = 'blind';
            this.evaluatedAt = null;
            return null;
        }
        if (generation !== this.generation || this.active !== active) return null;
        if (!enrolled || !this.current(active)) {
            this.stop();
            return null;
        }
        return active;
    }
    async command(controller: RadarController, raw: unknown): Promise<RadarWatchStatus> {
        const request = readCommand(raw),
            server = this.deps.currentContext();
        if (!validRadarController(controller) || !server || !/^[A-Za-z0-9:_-]{1,120}$/.test(server.contextToken))
            throw new RadarWatchError(403, 'radar_owner_context_required');
        const generation = this.generation;
        if (!(await this.deps.controllerCurrent(controller, server)))
            throw new RadarWatchError(403, 'radar_enrollment_required');
        if (generation !== this.generation || baseKey(server) !== baseKey(this.deps.currentContext()))
            throw new RadarWatchError(409, 'radar_context_changed');
        const active = await this.validate();
        if (!active && this.active) throw new RadarWatchError(503, 'radar_enrollment_unavailable');
        if (baseKey(server) !== baseKey(this.deps.currentContext()) || !same(active?.context ?? null, request.expected))
            throw new RadarWatchError(409, 'radar_context_conflict');
        if (!request.armed) {
            if (active && active.context.binding.deviceId !== controller.deviceId)
                throw new RadarWatchError(409, 'radar_controller_conflict');
            this.stop();
            return this.describe();
        }
        if (!this.deps.aisArmed()) throw new RadarWatchError(409, 'radar_collision_watch_required');
        const rawSnapshot = this.deps.readSnapshot();
        if (!rawSnapshot.configured) throw new RadarWatchError(503, 'radar_passthrough_unavailable');
        const sameController =
            active?.context.binding.deviceId === controller.deviceId &&
            active.context.binding.enrollmentRevision === controller.enrollmentRevision;
        const samePrefs = active && JSON.stringify(active.prefs) === JSON.stringify(request.prefs);
        if (active && sameController && samePrefs) return this.describe();
        if (active && !request.replaceController) throw new RadarWatchError(409, 'radar_controller_review_required');
        const context: RadarRelayContext = {
            binding: {
                ownerId: server.ownerId,
                piDeviceId: server.piDeviceId,
                pairingId: server.pairingId,
                feedId: server.feedId,
                ...controller,
            },
            configurationRevision: randomUUID(),
            instance: this.instance,
            watchEpoch: randomBytes(16).toString('hex'),
        };
        if (!validRadarContext(context)) throw new RadarWatchError(503, 'radar_owner_context_invalid');
        this.stop();
        this.active = {
            context,
            server: { ...server },
            prefs: request.prefs!,
            model: new RadarEncounters(context.watchEpoch),
        };
        this.phase = 'blind';
        this.emit({ action: 'bind', context });
        await this.tick();
        return this.describe();
    }
    async tick(): Promise<void> {
        if (this.tickPending) return;
        this.tickPending = true;
        try {
            const active = await this.validate();
            if (!active) return;
            const now = this.now(),
                raw = this.deps.readSnapshot();
            if (!this.current(active)) {
                this.stop();
                return;
            }
            const feed = raw.connected && raw.feedId && /^pi:[a-f0-9]{32}$/.test(raw.feedId) ? raw.feedId : null;
            const own = feed ? decodeRadarOwnship(raw.ownship, feed) : null;
            const contacts = feed
                ? raw.observations.slice(0, 400).flatMap((e) => {
                      const c = restoreRadarObservation(e, feed, now);
                      return c ? [c] : [];
                  })
                : [];
            const atAnchor = this.deps.atAnchor(),
                ownship = feed ? radarCollisionOwnship(own, feed, now, atAnchor) : null;
            const state = ownship ? ownMotionState(ownship.sogKn, ownship.cogDeg, atAnchor) : 'no-fix';
            const candidates = contacts.flatMap((c) => {
                const candidate = gradeRadarContact(c, own, now, active.prefs, atAnchor, this.pairs.get(c.contactKey));
                return candidate ? [candidate] : [];
            });
            const update = active.model.update(
                candidates,
                (c, key) =>
                    c?.contact.feedId === feed || (feed && key.startsWith(`radar:${feed}:`)) ? state : 'no-fix',
                now,
            );
            this.pairs = new Map(candidates.map((c) => [c.contactKey, c.assessment.pair]));
            for (const [key, end] of update.ended) {
                for (const [identity, card] of this.identities)
                    if (card.contactKey === key) {
                        this.emit({
                            action: 'resolved',
                            context: active.context,
                            resolved: {
                                key: identity,
                                contactKey: key,
                                episodeId: card.episodeId,
                                kind: card.closeQuarters ? 'radar-close-quarters' : 'radar-collision',
                                how: end.how,
                                endedAt: now,
                            },
                        });
                        this.identities.delete(identity);
                        this.explicitAcks.delete(identity);
                    }
            }
            for (const card of active.model.cards(now))
                if (!card.cleared) {
                    const key = radarAlarmKey(active.context, card);
                    this.identities.set(key, { ...card, key });
                }
            this.evaluatedAt = now;
            this.phase =
                !raw.connected ||
                raw.overloaded ||
                raw.lastFrameAt === null ||
                now < raw.lastFrameAt ||
                now - raw.lastFrameAt > 15000
                    ? 'blind'
                    : !ownship || state === 'unknown'
                      ? 'no-fix'
                      : 'armed';
            this.publishRelay(active, now);
        } finally {
            this.tickPending = false;
        }
    }
    async acknowledge(controller: RadarController, raw: unknown): Promise<RadarWatchStatus> {
        if (
            !validRadarController(controller) ||
            !radarRecord(raw) ||
            Object.keys(raw).length !== 2 ||
            !validRadarContext(raw.context) ||
            typeof raw.key !== 'string'
        )
            throw new RadarWatchError(400, 'radar_invalid_ack');
        const active = await this.validate();
        if (!active || !same(active.context, raw.context)) throw new RadarWatchError(409, 'radar_context_conflict');
        if (!(await this.deps.controllerCurrent(controller, active.server)))
            throw new RadarWatchError(403, 'radar_enrollment_required');
        if (!this.current(active)) throw new RadarWatchError(409, 'radar_context_changed');
        const card = active.model
            .cards(this.now())
            .find((c) => !c.cleared && radarAlarmKey(active.context, c) === raw.key);
        if (!card) {
            const prior = this.explicitAcks.get(raw.key);
            if (
                prior &&
                !active.model
                    .cards(this.now())
                    .some(
                        (c) => c.contactKey === prior.contactKey && c.episodeId === prior.episodeId && c.closeQuarters,
                    )
            )
                return this.describe();
            throw new RadarWatchError(409, 'radar_alarm_changed');
        }
        const kind = card.closeQuarters ? 'radar-close-quarters' : 'radar-collision',
            ackedAt = this.now();
        if (!active.model.acknowledge({ ...card, kind }, ackedAt))
            throw new RadarWatchError(409, 'radar_alarm_changed');
        const ack: RadarRelayAck = {
            key: raw.key,
            contactKey: card.contactKey,
            episodeId: card.episodeId,
            kind,
            ackedAt,
        };
        this.explicitAcks.set(raw.key, ack);
        this.emit({ action: 'ack', context: active.context, ack });
        return this.describe();
    }
    private publishRelay(active: Active, now: number): void {
        const upserts: RadarRelayUpsert[] = active.model
            .cards(now)
            .filter((c) => !c.cleared && now >= c.sourceAt && now - c.sourceAt <= 15000)
            .map((c) => ({
                key: radarAlarmKey(active.context, c),
                contactKey: c.contactKey,
                episodeId: c.episodeId,
                kind: c.closeQuarters ? 'radar-close-quarters' : 'radar-collision',
                raisedAt: c.raisedAt,
                sourceAt: c.sourceAt,
                reportAt: c.reportAt,
                cpaNm: c.lost ? null : c.assessment.cpaNm,
                tcpaMin: c.lost ? null : c.assessment.tcpaMin,
                rangeNm: c.assessment.rangeNm,
                bearingDeg: c.assessment.bearingDeg,
                lost: c.lost?.reason ?? null,
            }));
        this.deps.onPass?.(
            { context: structuredClone(active.context), evaluatedAt: now, upserts },
            () =>
                this.current(active) &&
                this.evaluatedAt !== null &&
                this.now() >= this.evaluatedAt &&
                this.now() - this.evaluatedAt <= 5000,
        );
    }
    statusCurrent(status: RadarWatchStatus): boolean {
        return status.context
            ? !!this.active && this.current(this.active) && same(status.context, this.active.context)
            : this.active === null;
    }
    async describe(): Promise<RadarWatchStatus> {
        const validated = await this.validate(),
            now = this.now(),
            raw = this.deps.readSnapshot();
        const active = validated && this.current(validated) ? validated : null;
        if (validated && !active) this.stop();
        const cards = active?.model.cards(now) ?? [];
        return {
            schema: 1,
            update: 7,
            capability: 1,
            servedAt: now,
            evaluatedAt: active ? this.evaluatedAt : null,
            contextRevision: this.revision,
            context: active ? structuredClone(active.context) : null,
            configured: raw.configured,
            running: !!active && this.evaluatedAt !== null && now >= this.evaluatedAt && now - this.evaluatedAt <= 5000,
            state: active ? this.phase : 'off',
            prefs: active ? structuredClone(active.prefs) : null,
            alarms: active ? cards.slice(0, 20).map((c) => ({ ...c, key: radarAlarmKey(active.context, c) })) : [],
            more: cards.length > 20,
            capacity: active?.model.capacity() ?? null,
            push: active
                ? (this.deps.pushStatus?.() ?? { state: 'unavailable', checkedAt: null })
                : { state: 'unavailable', checkedAt: null },
        };
    }
}
