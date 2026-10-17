import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
    OWN_BOAT_SKILL as LIMIT,
    OWN_BOAT_MODELS,
    ownBoatBindingKey,
    ownBoatClock,
    ownBoatExact,
    ownBoatHex,
    ownBoatRecord,
    ownBoatUuid,
    parseOwnBoatBinding,
    type OwnBoatBinding,
    type OwnBoatProposal,
    type OwnBoatCapability,
} from '../ownBoatSkillWire.js';
import { ownSkillScope, type OwnBoatSkillStore, type SkillControl } from './store.js';
import type { SkillOwnerVerifier, VerifiedSkillOwner } from './owner.js';
import type { OwnPublishedWindReader } from './published.js';
import type { OwnInstrumentSource } from './source.js';
import { scoreOwnWind } from './score.js';
type PiIdentity = Pick<
    OwnBoatBinding,
    'ownerId' | 'piDeviceId' | 'controllerId' | 'pairingRevision' | 'enrollmentRevision'
>;
export interface OwnSkillContext {
    identity: PiIdentity;
    source: OwnInstrumentSource | null;
    allowInternet: boolean;
    current(): boolean;
}
export interface OwnSkillDeps {
    store: Pick<
        OwnBoatSkillStore,
        'control' | 'install' | 'off' | 'touch' | 'enable' | 'sample' | 'capture' | 'evidence' | 'claimCaptureHour'
    >;
    owner: Pick<SkillOwnerVerifier, 'verify'>;
    forecasts: Pick<OwnPublishedWindReader, 'read'>;
    context(controllerId: string): Promise<OwnSkillContext | null>;
    enabled: boolean;
    now?: () => number;
    monotonic?: () => number;
}
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const identityKey = (v: PiIdentity) =>
    JSON.stringify([v.ownerId, v.piDeviceId, v.controllerId, v.pairingRevision, v.enrollmentRevision]);
const fromConsent = (v: OwnBoatBinding): PiIdentity => ({
    ownerId: v.ownerId,
    piDeviceId: v.piDeviceId,
    controllerId: v.controllerId,
    pairingRevision: v.pairingRevision,
    enrollmentRevision: v.enrollmentRevision,
});
function bind(owner: VerifiedSkillOwner, context: OwnSkillContext): OwnBoatBinding {
    if (!context.source || context.identity.ownerId !== owner.ownerId)
        throw Error('Confirm the actual instrument association');
    const binding = parseOwnBoatBinding({
        ...context.identity,
        vesselId: owner.vesselId,
        vesselRevision: owner.vesselRevision,
        selfKey: context.source.selfKey,
        windSourceKey: context.source.windSourceKey,
        positionSourceKey: context.source.positionSourceKey,
    });
    if (!binding) throw Error('Private instrument binding unavailable');
    return binding;
}
/** Default OFF, independent owner capability, bounded private evidence; never forwards instruments. */
export class OwnBoatSkillKeeper {
    private epoch = 0;
    private pending: { proposal: OwnBoatProposal; generation: string; at: number; mono: number } | null = null;
    private reading: {
        id: string;
        generation: string;
        cap: string;
        expiresAt: number;
        at: number;
        mono: number;
    } | null = null;
    private runtime: { revision: string; wall: number; mono: number; remaining: number } | null = null;
    private request: AbortController | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private started = false;
    private closed = false;
    private busy = false;
    private poisoned = false;
    private phase = 'Logging is off.';
    private readonly now: () => number;
    private readonly mono: () => number;
    constructor(private readonly deps: OwnSkillDeps) {
        this.now = deps.now ?? Date.now;
        this.mono = deps.monotonic ?? (() => performance.now());
    }
    capability() {
        return { schema: 1, version: 1, installed: this.deps.enabled, maximumConsentDays: 14, maximumReadMinutes: 15 };
    }
    private retire(clear = false): void {
        this.epoch++;
        this.pending = null;
        this.reading = null;
        this.runtime = null;
        this.request?.abort();
        this.phase = 'Logging is off.';
        try {
            this.deps.store.off(this.now(), clear);
            this.poisoned = false;
        } catch (error) {
            this.poisoned = true;
            throw error;
        }
    }
    relayChanged(
        before: { ownerId: string; relayId: string; token: string } | null,
        after: { ownerId: string; relayId: string; token: string } | null,
    ): void {
        if (before?.ownerId !== after?.ownerId || before?.relayId !== after?.relayId || before?.token !== after?.token)
            this.retire();
        else this.request?.abort();
    }
    controllerRetired(id: string, enrollmentRevision: string): void {
        const c = this.deps.store.control(),
            binding = c.active?.consent.binding;
        if (binding?.controllerId === id && binding.enrollmentRevision === enrollmentRevision) this.retire();
        else if (
            this.pending?.proposal.binding.controllerId === id &&
            this.pending.proposal.binding.enrollmentRevision === enrollmentRevision
        ) {
            this.pending = null;
            this.epoch++;
            this.request?.abort();
        }
    }
    private live(control: SkillControl): boolean {
        const now = this.now(),
            active = control.active;
        if (
            !this.deps.enabled ||
            this.closed ||
            this.poisoned ||
            !active ||
            !ownBoatClock(now) ||
            now < control.highWater - 1000 ||
            now < active.consent.issuedAt - 1000 ||
            now >= active.consent.expiresAt
        )
            return false;
        if (this.runtime?.revision !== active.consent.revision)
            this.runtime = {
                revision: active.consent.revision,
                wall: now,
                mono: this.mono(),
                remaining: active.consent.expiresAt - now,
            };
        if (
            now < this.runtime.wall - 1000 ||
            this.mono() - this.runtime.mono >= this.runtime.remaining ||
            this.mono() < this.runtime.mono
        )
            return false;
        this.runtime.wall = Math.max(this.runtime.wall, now);
        return true;
    }
    private access(capability: unknown, controllerId: string): SkillControl {
        if (this.closed) throw Error('Private scorecard is closing');
        const c = this.deps.store.control();
        if (
            !ownBoatHex(capability) ||
            !this.live(c) ||
            c.active!.consent.binding.controllerId !== controllerId ||
            !timingSafeEqual(Buffer.from(hash(capability), 'hex'), Buffer.from(c.active!.capabilityHash, 'hex'))
        )
            throw Error('Private scorecard access expired; review again');
        return c;
    }
    private async currentContext(control: SkillControl): Promise<OwnSkillContext> {
        const epoch = this.epoch;
        const binding = control.active!.consent.binding,
            context = await this.deps.context(binding.controllerId);
        if (epoch !== this.epoch || this.deps.store.control().generation !== control.generation)
            throw Error('Prior private context retired');
        if (!context || identityKey(context.identity) !== identityKey(fromConsent(binding))) {
            this.retire();
            throw Error('Private Pi/account/controller changed');
        }
        if (!context.current()) throw Error('Private instrument context changed');
        if (
            context.source &&
            (context.source.selfKey !== binding.selfKey ||
                context.source.windSourceKey !== binding.windSourceKey ||
                context.source.positionSourceKey !== binding.positionSourceKey)
        ) {
            this.retire();
            throw Error('Private instrument source changed; review again');
        }
        return context;
    }
    async prepare(raw: unknown, controllerId: string, token: unknown): Promise<OwnBoatProposal> {
        const started = this.mono();
        if (
            !this.deps.enabled ||
            this.closed ||
            this.poisoned ||
            !ownBoatRecord(raw) ||
            !ownBoatExact(raw, ['schema', 'vesselId']) ||
            raw.schema !== 1 ||
            !ownBoatUuid(raw.vesselId)
        )
            throw Error('Review private instrument access');
        this.pending = null;
        this.reading = null;
        this.request?.abort();
        const epoch = ++this.epoch;
        const control = this.deps.store.control(),
            first = await this.deps.context(controllerId);
        if (epoch !== this.epoch || !first?.source || !first.current() || !first.allowInternet)
            throw Error('Fresh boat instruments and owner verification are required');
        const owner = await this.deps.owner.verify(
            token,
            first.identity.ownerId,
            raw.vesselId,
            () => epoch === this.epoch && first.current(),
        );
        const context = await this.deps.context(controllerId),
            now = this.now();
        if (
            epoch !== this.epoch ||
            !context?.source ||
            !context.current() ||
            identityKey(context.identity) !== identityKey(first.identity) ||
            this.deps.store.control().generation !== control.generation ||
            this.mono() < started ||
            this.mono() - started >= LIMIT.ownerProofMs ||
            now < control.highWater - 1000
        )
            throw Error('Private review retired');
        const proposal: OwnBoatProposal = {
            schema: 1,
            nonce: randomBytes(32).toString('hex'),
            expiresAt: now + LIMIT.prepareMs,
            binding: bind(owner, context),
            vesselName: owner.vesselName,
            windSource: context.source.windSource,
            positionSource: context.source.positionSource,
        };
        this.pending = { proposal, generation: control.generation, at: now, mono: this.mono() };
        return proposal;
    }
    async confirm(raw: unknown, controllerId: string, token: unknown): Promise<OwnBoatCapability> {
        const started = this.mono();
        const pending = this.pending,
            epoch = this.epoch;
        this.pending = null;
        if (
            !pending ||
            this.closed ||
            !ownBoatRecord(raw) ||
            !ownBoatExact(raw, ['schema', 'nonce', 'logging']) ||
            raw.schema !== 1 ||
            raw.nonce !== pending.proposal.nonce ||
            typeof raw.logging !== 'boolean' ||
            controllerId !== pending.proposal.binding.controllerId ||
            this.now() < pending.at - 1000 ||
            this.now() >= pending.proposal.expiresAt ||
            this.mono() - pending.mono >= LIMIT.prepareMs
        )
            throw Error('Private review expired');
        const expected = pending.proposal.binding;
        const first = await this.deps.context(controllerId);
        if (
            epoch !== this.epoch ||
            !first?.source ||
            !first.current() ||
            !first.allowInternet ||
            identityKey(first.identity) !== identityKey(fromConsent(expected))
        )
            throw Error('Private owner verification is unavailable');
        const owner = await this.deps.owner.verify(
            token,
            expected.ownerId,
            expected.vesselId,
            () => epoch === this.epoch && first.current(),
        );
        const context = await this.deps.context(controllerId),
            now = this.now();
        if (
            epoch !== this.epoch ||
            !context?.source ||
            !context.current() ||
            !context.allowInternet ||
            now < pending.at - 1000 ||
            now >= pending.proposal.expiresAt ||
            this.mono() - pending.mono >= LIMIT.prepareMs ||
            this.mono() < started ||
            this.mono() - started >= LIMIT.ownerProofMs ||
            ownBoatBindingKey(bind(owner, context)) !== ownBoatBindingKey(expected)
        )
            throw Error('Private source or owner proof changed');
        const capability = randomBytes(32).toString('hex'),
            consent = {
                schema: 1 as const,
                revision: randomUUID(),
                binding: expected,
                issuedAt: now,
                expiresAt: now + LIMIT.consentMs,
            };
        this.deps.store.install(
            {
                capabilityHash: hash(capability),
                consent,
                vesselName: owner.vesselName,
                logging: false,
                loggingApproved: raw.logging,
            },
            now,
            pending.generation,
        );
        this.epoch++;
        this.reading = null;
        this.runtime = { revision: consent.revision, wall: now, mono: this.mono(), remaining: LIMIT.consentMs };
        this.phase = 'Logging is off.';
        return { schema: 1, capability, consent };
    }
    async enable(capability: unknown, controllerId: string) {
        const c = this.access(capability, controllerId),
            epoch = this.epoch;
        if (!c.active!.loggingApproved) throw Error('Private logging requires an explicit owner review');
        const context = await this.currentContext(c);
        this.access(capability, controllerId);
        if (
            epoch !== this.epoch ||
            !context.current() ||
            !context.source ||
            this.deps.store.control().generation !== c.generation
        )
            throw Error('Private activation retired');
        this.deps.store.enable(c.generation, this.now());
        this.phase = 'Warming; waiting for original samples and forecasts.';
        return { schema: 1, state: 'logging' };
    }
    off(capability: unknown, controllerId: string, clear = false) {
        // Privacy stop may revoke the same current capability even when its
        // read deadline/clock has expired. It cannot affect a successor grant.
        const c = this.deps.store.control();
        if (
            !ownBoatHex(capability) ||
            !c.active ||
            c.active.consent.binding.controllerId !== controllerId ||
            !timingSafeEqual(Buffer.from(hash(capability), 'hex'), Buffer.from(c.active.capabilityHash, 'hex'))
        )
            throw Error('Private stop authority unavailable');
        this.retire(clear);
        return { schema: 1, state: 'off', cleared: clear };
    }
    async openRead(capability: unknown, controllerId: string) {
        const c = this.access(capability, controllerId),
            epoch = this.epoch;
        await this.currentContext(c);
        const current = this.access(capability, controllerId),
            now = this.now();
        if (epoch !== this.epoch || current.generation !== c.generation) throw Error('Private reader retired');
        this.deps.store.touch(c.generation, now);
        this.reading = {
            id: randomBytes(32).toString('hex'),
            generation: c.generation,
            cap: hash(String(capability)),
            expiresAt: Math.min(now + LIMIT.readMs, c.active!.consent.expiresAt),
            at: now,
            mono: this.mono(),
        };
        return { schema: 1, readId: this.reading.id, expiresAt: this.reading.expiresAt };
    }
    assertRead(capability: unknown, controllerId: string, readId: unknown): SkillControl {
        const c = this.access(capability, controllerId),
            r = this.reading,
            now = this.now();
        if (
            !r ||
            r.id !== readId ||
            r.cap !== hash(String(capability)) ||
            r.generation !== c.generation ||
            now < r.at - 1000 ||
            now >= r.expiresAt ||
            this.mono() < r.mono ||
            this.mono() - r.mono >= LIMIT.readMs
        )
            throw Error('Private read session expired');
        return c;
    }
    async read(capability: unknown, controllerId: string, readId: unknown) {
        const c = this.assertRead(capability, controllerId, readId),
            epoch = this.epoch,
            context = await this.currentContext(c);
        this.assertRead(capability, controllerId, readId);
        if (epoch !== this.epoch) throw Error('Private reader retired');
        const now = this.now(),
            evidence = this.deps.store.evidence(c.generation, ownSkillScope(c.active!.consent), now);
        const result = {
            schema: 1,
            basis: 'private-instrument-agreement',
            generatedAt: Math.floor(now / 1000),
            consentRevision: c.active!.consent.revision,
            logging: c.active!.logging,
            phase: context.source ? this.phase : 'Current instruments unavailable; logging is paused.',
            lastMeasuredAt: evidence.samples.at(-1)?.at ?? null,
            scores: scoreOwnWind(evidence.samples, evidence.issues, now, 'own:' + c.active!.consent.binding.vesselId),
        };
        if (Buffer.byteLength(JSON.stringify(result)) > LIMIT.responseBytes) throw Error('Private read response bound');
        this.assertRead(capability, controllerId, readId);
        return result;
    }
    start(): void {
        if (this.started || !this.deps.enabled) return;
        this.started = true;
        this.closed = false;
        this.schedule(0);
    }
    stop(): void {
        this.started = false;
        this.closed = true;
        this.epoch++;
        this.pending = null;
        this.reading = null;
        this.request?.abort();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }
    private schedule(delay = 60_000): void {
        if (!this.started) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.tick().finally(() => this.schedule());
        }, delay);
        this.timer.unref?.();
    }
    async tick(): Promise<void> {
        if (this.busy || !this.deps.enabled || this.poisoned || this.closed) return;
        this.busy = true;
        const request = new AbortController();
        this.request = request;
        const epoch = this.epoch;
        try {
            const control = this.deps.store.control();
            if (!control.active) return;
            if (!this.live(control)) {
                this.retire();
                return;
            }
            if (!control.active.logging) return;
            const context = await this.currentContext(control);
            const current = () =>
                epoch === this.epoch &&
                !request.signal.aborted &&
                context.current() &&
                this.live(this.deps.store.control()) &&
                this.deps.store.control().generation === control.generation;
            if (!current()) return;
            this.deps.store.touch(control.generation, this.now());
            if (!context.source) {
                this.phase = 'Current instruments unavailable; logging is paused.';
                return;
            }
            const scope = ownSkillScope(control.active.consent);
            let captures = 0;
            if (context.allowInternet && this.deps.store.claimCaptureHour(control.generation, this.now())) {
                for (const model of OWN_BOAT_MODELS) {
                    if (!current()) return;
                    try {
                        const issue = await this.deps.forecasts.read(
                            model,
                            context.source.sample.cell,
                            request.signal,
                            current,
                        );
                        if (!current()) return;
                        if (issue) {
                            // Device removal may happen while the original
                            // HTTP request is pending. Re-read enrollment and
                            // source identity before any durable write.
                            const admission = await this.currentContext(control);
                            if (!current() || !admission.current() || !admission.source) return;
                            this.deps.store.capture(control.generation, scope, issue, this.now());
                            captures++;
                        }
                    } catch {
                        if (!current()) return;
                    }
                }
            }
            const fresh = await this.currentContext(control);
            if (!current() || !fresh.current() || !fresh.source) return;
            this.deps.store.sample(control.generation, scope, fresh.source.sample, this.now());
            this.phase = context.allowInternet
                ? captures
                    ? 'Warming; original forecasts and samples are retained privately.'
                    : 'Warming; no replacement of prior issues. Missing forecasts stay unscored.'
                : 'Instrument logging is local; new forecast reads are paused by internet policy.';
        } catch {
            this.phase = 'Private evidence is held; review source, clock or storage.';
        } finally {
            this.busy = false;
            if (this.request === request) this.request = null;
        }
    }
}
