import { randomUUID } from 'node:crypto';
import type { ChartDevicePublic, EncDeviceStore } from '../encDevices.js';
import {
    defaultWakeRules,
    evaluateWakeRule,
    initialWakeState,
    wakeQuietNow,
    WAKE_PRESETS,
    type WakeState,
} from '../wakeRule/wakeRule.js';
import { wakeReadingFromSignalK, type WakeInputContext, type WakePressureHistory } from '../wakeRule/wakeRuleInputs.js';
import { wakeSensorCatalogue, wakeStationPressure } from './catalogue.js';
import {
    WakeKeeperError,
    parseWakeConfigurationRequest,
    parseWakeClearRequest,
    validWakePair,
    wakeEnrollmentRevision,
    wakeFeedId,
    wakePairKey,
    wakeRecord,
    sameWakeSelection,
    validWakeBinding,
    wakeUuid,
    type WakePairIdentity,
    type WakeBinding,
    type WakeConfiguration,
    type WakeConfigurationRequest,
    type WakeClearRequest,
    type WakeKeeperStatus,
    type WakeSensors,
    type WakeRuleStatus,
    type WakePressureStatus,
    type WakeRelayReviewRequest,
} from './contract.js';
import { WakeKeeperStore } from './store.js';
import { WakeEpisodes } from './episodes.js';
import type { WakeRelay } from './relay.js';
import { wakeCloudContext, wakeCloudContextKey } from './relayProtocol.js';

const unavailablePressure = (): WakePressureStatus => ({ state: 'unavailable', sampleCount: 0, spanMs: 0 });
/** No transport is accepted here. Both documents and ownership are authenticated, cache-only callbacks.
 * A timer owns evaluation; a status/sensor request never opens a source or provider connection. */
export class PiWakeKeeper {
    readonly instance = randomUUID();
    private readonly now: () => number;
    private bootAt: number;
    private configuration: WakeConfiguration | null = null;
    private loadPromise: Promise<void> | null = null;
    private storageUnavailable = false;
    private enrollmentUnavailable = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private started = false;
    private epoch = 0;
    private mutations = 0;
    private flight: Promise<void> | null = null;
    private pair: WakePairIdentity | null = null;
    private scopeKey: string | null = null;
    private feedId: string | null = null;
    private document: unknown = null;
    private history: WakePressureHistory | null = null;
    private states: WakeState[] = defaultWakeRules().map(initialWakeState);
    private rows: WakeRuleStatus[] = [];
    private proof: WakeKeeperStatus['proof'] = null;
    private proofUntil = 0;
    private episodes = new WakeEpisodes();
    constructor(
        private readonly deps: {
            store: WakeKeeperStore;
            identity: () => WakePairIdentity | null;
            devices: Pick<EncDeviceStore, 'list'>;
            selfDocument: () => Promise<unknown | null>;
            now?: () => number;
            relay?: WakeRelay;
        },
    ) {
        this.now = deps.now ?? Date.now;
        this.bootAt = this.now();
    }
    private identity(): WakePairIdentity | null {
        try {
            const pair = this.deps.identity();
            return validWakePair(pair)
                ? { ownerId: pair.ownerId, piDeviceId: pair.piDeviceId, pairingId: pair.pairingId }
                : null;
        } catch {
            return null;
        }
    }
    private retire(clearDocument = true): void {
        this.deps.relay?.retire();
        this.episodes.clear();
        this.epoch++;
        this.history = null;
        this.states = defaultWakeRules().map(initialWakeState);
        this.rows = [];
        this.proof = null;
        this.proofUntil = 0;
        if (clearDocument) this.document = null;
    }
    private freezeMutation(): void {
        this.mutations++;
        this.epoch++;
        this.proof = null;
        this.proofUntil = 0;
        // A rejected CAS is not a source measurement or a configuration change.
        // Preserve active/confirmation/history state until a change commits.
    }
    private initialize(): Promise<void> {
        return (this.loadPromise ??= this.deps.store.load().then(
            (config) => {
                this.configuration = config;
            },
            () => {
                this.storageUnavailable = true;
            },
        ));
    }
    async start(schedule = true): Promise<void> {
        await this.initialize();
        if (this.started) return;
        this.bootAt = this.now();
        this.started = true;
        this.retire();
        if (schedule) {
            this.timer = setInterval(() => {
                void this.tick();
            }, 1000);
            this.timer.unref();
        }
    }
    stop(): void {
        this.started = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.retire();
    }
    private async enrollment(binding: WakeBinding): Promise<boolean> {
        const device = (await this.deps.devices.list()).find((d) => d.id === binding.deviceId);
        return !!device && wakeEnrollmentRevision(device) === binding.enrollmentRevision;
    }
    private visible(): WakeConfiguration | null {
        return this.configuration && wakePairKey(this.configuration.binding) === wakePairKey(this.pair)
            ? this.configuration
            : null;
    }
    /** Retire synchronously on identity change, and after the bounded enrollment read. */
    private async reconcile(): Promise<boolean> {
        const pair = this.identity(),
            pairKey = wakePairKey(pair);
        if (pairKey !== wakePairKey(this.pair)) {
            this.retire();
            this.feedId = null;
            this.pair = pair;
            this.scopeKey = null;
        }
        const config = this.visible();
        let enrolled = true;
        this.enrollmentUnavailable = false;
        try {
            if (config) enrolled = await this.enrollment(config.binding);
        } catch {
            this.enrollmentUnavailable = true;
            this.document = null;
            this.proof = null;
            this.proofUntil = 0;
            // An unreadable enrollment file is unknown, not proof that a phone
            // was removed. It must not clear an already-active rule.
            return false;
        }
        if (pairKey !== wakePairKey(this.identity())) {
            this.retire();
            this.pair = null;
            this.feedId = null;
            this.scopeKey = null;
            return false;
        }
        const key = JSON.stringify([
            pairKey,
            config?.binding.deviceId ?? null,
            enrolled ? (config?.binding.enrollmentRevision ?? null) : 'removed',
        ]);
        if (key !== this.scopeKey) {
            this.retire();
            this.scopeKey = key;
        }
        return !!pair && enrolled;
    }
    private context(draftM: number | null, now = this.now()): WakeInputContext {
        return {
            feedId: this.feedId ?? '',
            localBoatSource: !!this.pair && !!this.feedId,
            selfDocument: this.document,
            now,
            draftM,
            pressureHistory: this.history,
        };
    }
    private async cachedDocument(): Promise<unknown | null> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                this.deps.selfDocument().catch(() => null),
                new Promise<null>((resolve) => {
                    timeout = setTimeout(() => resolve(null), 2000);
                    timeout.unref();
                }),
            ]);
        } catch {
            return null;
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }
    private pressureSample(context: WakeInputContext): void {
        const sample = wakeStationPressure(context);
        if (!sample || sample.t <= this.bootAt) return;
        if (this.history?.sensorId !== sample.sensorId || this.history.feedId !== context.feedId)
            this.history = { feedId: context.feedId, sensorId: sample.sensorId, samples: [] };
        const history = this.history!,
            previous = history.samples.at(-1);
        if (previous && sample.t <= previous.t) return;
        const row = { ...sample, feedId: context.feedId };
        // Keep the most recent actual measurement per minute. Repeated 1Hz
        // values must not evict the 90min–3h record needed for a tendency.
        if (previous && Math.floor(previous.t / 60_000) === Math.floor(row.t / 60_000)) history.samples.pop();
        history.samples.push(row);
        history.samples = history.samples.filter((s) => s.t >= context.now - 4 * 3_600_000).slice(-2048);
    }
    private pressure(draftM: number | null): WakePressureStatus {
        const context = this.context(draftM),
            sample = wakeStationPressure(context);
        if (!sample || !this.history || sample.sensorId !== this.history.sensorId || sample.t <= this.bootAt)
            return unavailablePressure();
        const rule = defaultWakeRules().find((r) => r.preset === 'pressure-fall')!;
        rule.enabled = true;
        rule.selection = {
            feedId: context.feedId,
            sensorId: sample.sensorId,
            reference: WAKE_PRESETS['pressure-fall'].reference,
        };
        return {
            state: wakeReadingFromSignalK(rule, context) ? 'ready' : 'warming',
            sampleCount: this.history.samples.length,
            spanMs: this.history.samples.length
                ? Math.max(0, this.history.samples.at(-1)!.t - this.history.samples[0].t)
                : 0,
        };
    }
    /** One non-overlapping evaluation. Delayed callbacks may not commit across any binding mutation. */
    tick(): Promise<void> {
        if (this.flight) return this.flight;
        this.flight = this.evaluate()
            .catch(() => {
                this.proof = null;
                this.proofUntil = 0;
            })
            .finally(() => {
                this.flight = null;
            });
        return this.flight;
    }
    private async evaluate(): Promise<void> {
        await this.initialize();
        if (!this.started || this.mutations) return;
        const loadingEpoch = this.epoch;
        try {
            const stored = await this.deps.store.load();
            if (loadingEpoch !== this.epoch || this.mutations || !this.started) return;
            if (stored?.revision !== this.configuration?.revision) {
                this.configuration = stored;
                this.scopeKey = null;
                this.retire();
            }
            this.storageUnavailable = false;
        } catch {
            this.storageUnavailable = true;
            this.document = null;
            this.proof = null;
            this.proofUntil = 0;
            return;
        }
        if (!(await this.reconcile())) return;
        const epoch = this.epoch,
            pairKey = wakePairKey(this.pair),
            doc = await this.cachedDocument();
        if (!this.started || this.mutations || epoch !== this.epoch || pairKey !== wakePairKey(this.identity())) return;
        if (!(await this.reconcile()) || epoch !== this.epoch) return;
        const nextFeed = wakeFeedId(this.pair!.piDeviceId, wakeRecord(doc) ? doc.uuid : null);
        if (nextFeed && this.feedId !== nextFeed) {
            this.retire();
            this.feedId = nextFeed;
        }
        this.document = nextFeed ? doc : null;
        const now = this.now(),
            config = this.visible(),
            context = this.context(config?.draftM ?? null, now);
        this.pressureSample(context);
        context.pressureHistory = this.history;
        if (!config || config.binding.feedId !== this.feedId || this.storageUnavailable) {
            this.rows = [];
            this.proof = null;
            return;
        }
        const readings = config.rules.map((rule) => {
            const reading = wakeReadingFromSignalK(rule, context);
            return reading && reading.at > this.bootAt ? reading : null;
        });
        this.rows = config.rules.map((rule, index) => {
            const reading = readings[index],
                result = evaluateWakeRule(rule, this.states[index], reading, now);
            this.states[index] = result.state;
            return {
                preset: rule.preset,
                status: result.status,
                active: result.state.active,
                audible: result.audible,
                quiet: result.quiet,
                lastAt: result.state.lastAt,
                value: reading?.value ?? null,
                ...(reading?.depthBasis ? { depthBasis: reading.depthBasis } : {}),
            };
        });
        const enabled = config.rules.flatMap((rule, i) => (rule.enabled ? [{ rule, reading: readings[i] }] : []));
        this.proof =
            enabled.length &&
            enabled.every(
                ({ rule, reading }) =>
                    !!reading && this.rows.find((r) => r.preset === rule.preset)?.status !== 'unknown',
            )
                ? {
                      update: 7,
                      ownerId: config.binding.ownerId,
                      feedId: config.binding.feedId,
                      rulesDigest: config.rulesDigest,
                      running: true,
                      evaluatedAt: now,
                      binding: { ...config.binding },
                      revision: config.revision,
                      instance: this.instance,
                  }
                : null;
        this.proofUntil = this.proof
            ? Math.min(
                  now + 30_000,
                  ...enabled.map(({ rule, reading }) => reading!.at + WAKE_PRESETS[rule.preset].maxAge),
              )
            : 0;
        const pass = this.episodes.pass(config, this.instance, this.rows, now),
            passEpoch = this.epoch;
        this.deps.relay?.update(
            pass,
            () =>
                this.started &&
                !this.mutations &&
                !this.storageUnavailable &&
                !this.enrollmentUnavailable &&
                this.epoch === passEpoch &&
                this.configuration?.revision === config.revision &&
                wakePairKey(config.binding) === wakePairKey(this.identity()),
            (key, acked, at) => this.episodes.acknowledge(key, acked, at),
        );
    }
    private bindingFor(device: ChartDevicePublic): WakeBinding | null {
        return this.pair && this.feedId
            ? {
                  ...this.pair,
                  feedId: this.feedId,
                  deviceId: device.id,
                  enrollmentRevision: wakeEnrollmentRevision(device),
              }
            : null;
    }
    async sensors(device: ChartDevicePublic, draftM?: number | null): Promise<WakeSensors> {
        await this.initialize();
        await this.reconcile();
        const draft = draftM === undefined ? (this.visible()?.draftM ?? null) : draftM;
        const catalogue = wakeSensorCatalogue(this.context(draft));
        return {
            schema: 1,
            update: 7,
            binding: this.bindingFor(device),
            draftM: draft,
            servedAt: this.now(),
            ...catalogue,
            pressure: this.pressure(draft),
        };
    }
    async status(device: ChartDevicePublic): Promise<WakeKeeperStatus> {
        await this.initialize();
        const valid = await this.reconcile(),
            config = this.visible(),
            now = this.now();
        const matching =
            (valid || this.enrollmentUnavailable) &&
            !!config &&
            (this.feedId === null || config.binding.feedId === this.feedId);
        const proof =
            this.started && valid && matching && this.proof && now >= this.proof.evaluatedAt && now <= this.proofUntil
                ? this.proof
                : null;
        const enabled = config?.rules.some((r) => r.enabled) === true;
        const reason = !this.started
            ? 'stopped'
            : this.storageUnavailable || this.enrollmentUnavailable
              ? 'storage-unavailable'
              : !config
                ? 'off'
                : !matching
                  ? 'binding-changed'
                  : !enabled
                    ? 'off'
                    : proof
                      ? 'watching'
                      : 'awaiting-sensors';
        // Re-evaluate freshness for presentation without advancing durations.
        const context = this.context(config?.draftM ?? null, now);
        const rows =
            matching && config
                ? config.rules.map((rule, i) => {
                      const reading = wakeReadingFromSignalK(rule, context),
                          row = this.rows[i];
                      if (!row)
                          return {
                              preset: rule.preset,
                              status: rule.enabled ? 'unknown' : 'disabled',
                              active: false,
                              audible: false,
                              quiet: false,
                              lastAt: null,
                              value: null,
                          } as WakeRuleStatus;
                      const quiet = wakeQuietNow(rule.quietHours, now),
                          audible = row.active && !quiet;
                      return (reading &&
                          reading.at > this.bootAt &&
                          (this.states[i].lastNow === null || now >= this.states[i].lastNow!)) ||
                          !rule.enabled
                          ? { ...row, quiet, audible }
                          : { ...row, quiet, audible, status: 'unknown' as const, value: null };
                  })
                : [];
        for (const row of rows) {
            const episode = this.episodes.episode(row.preset);
            if (episode) {
                row.episode = episode;
                if (episode.ackedAt !== null) row.audible = false;
            }
        }
        return {
            schema: 1,
            update: 7,
            instance: this.instance,
            binding: this.bindingFor(device),
            configured: !!config,
            configuration: config ? structuredClone(config) : null,
            running: this.started,
            reason,
            proof: proof ? structuredClone(proof) : null,
            rules: rows,
            pressure: this.pressure(config?.draftM ?? null),
            push: this.deps.relay?.status() ?? { state: 'unavailable', capability: 0 },
            servedAt: now,
        };
    }
    private async current(binding: WakeBinding, requireFeed: boolean): Promise<boolean> {
        if (wakePairKey(binding) !== wakePairKey(this.identity()) || !(await this.enrollment(binding))) return false;
        const doc = await this.cachedDocument();
        if (wakePairKey(binding) !== wakePairKey(this.identity()) || !(await this.enrollment(binding))) return false;
        const feed = wakeFeedId(binding.piDeviceId, wakeRecord(doc) ? doc.uuid : null);
        const stored =
            this.configuration && wakePairKey(this.configuration.binding) === wakePairKey(binding)
                ? this.configuration.binding.feedId
                : null;
        return requireFeed
            ? feed === binding.feedId
            : feed === binding.feedId ||
                  stored === binding.feedId ||
                  (!feed && wakePairKey(this.pair) === wakePairKey(binding) && this.feedId === binding.feedId);
    }
    async configure(raw: WakeConfigurationRequest, device: ChartDevicePublic): Promise<WakeConfiguration> {
        await this.initialize();
        const request = parseWakeConfigurationRequest(raw);
        if (
            request.binding.deviceId !== device.id ||
            request.binding.enrollmentRevision !== wakeEnrollmentRevision(device)
        )
            throw new WakeKeeperError('binding');
        const enabled = request.rules.some((r) => r.enabled);
        if (!(await this.current(request.binding, enabled))) throw new WakeKeeperError('binding');
        if (enabled) {
            const doc = await this.cachedDocument(),
                context = {
                    ...this.context(request.draftM),
                    selfDocument: doc,
                    feedId: request.binding.feedId,
                    localBoatSource: true,
                };
            const options = wakeSensorCatalogue(context).options;
            if (
                request.rules.some(
                    (r) =>
                        r.enabled &&
                        !options.some((o) => o.preset === r.preset && sameWakeSelection(o.selection, r.selection!)),
                )
            )
                throw new WakeKeeperError('binding');
        }
        this.freezeMutation();
        try {
            const config = await this.deps.store.configure(
                request,
                () => this.current(request.binding, enabled),
                this.now(),
            );
            this.configuration = config;
            this.storageUnavailable = false;
            this.scopeKey = null;
            this.retire();
            return structuredClone(config);
        } finally {
            this.mutations--;
        }
    }
    async clear(raw: WakeClearRequest, device: ChartDevicePublic): Promise<void> {
        await this.initialize();
        const request = parseWakeClearRequest(raw);
        if (
            request.binding.deviceId !== device.id ||
            request.binding.enrollmentRevision !== wakeEnrollmentRevision(device)
        )
            throw new WakeKeeperError('binding');
        const old = this.configuration;
        if (
            old &&
            wakePairKey(old.binding) === wakePairKey(request.binding) &&
            (old.rulesDigest !== request.rulesDigest || old.binding.feedId !== request.binding.feedId)
        )
            throw new WakeKeeperError('conflict');
        this.freezeMutation();
        try {
            await this.deps.store.clear(request.binding, request.expectedRevision, () =>
                this.current(request.binding, false),
            );
            this.configuration = null;
            this.storageUnavailable = false;
            this.scopeKey = null;
            this.retire();
        } finally {
            this.mutations--;
        }
    }
    async reviewRelay(raw: WakeRelayReviewRequest, device: ChartDevicePublic): Promise<{ schema: 1; accepted: true }> {
        if (
            !wakeRecord(raw) ||
            Object.keys(raw).length !== 5 ||
            raw.schema !== 1 ||
            !wakeUuid(raw.expectedRevision) ||
            !wakeUuid(raw.expectedContextRevision) ||
            !validWakeBinding(raw.binding) ||
            typeof raw.rulesDigest !== 'string' ||
            !/^[a-f0-9]{64}$/.test(raw.rulesDigest)
        )
            throw new WakeKeeperError('invalid');
        raw = { ...raw, binding: { ...raw.binding } };
        await this.initialize();
        await this.reconcile();
        const config = this.visible(),
            epoch = this.epoch,
            binding = { ...raw.binding };
        if (binding.deviceId !== device.id || binding.enrollmentRevision !== wakeEnrollmentRevision(device))
            throw new WakeKeeperError('binding');
        if (
            !config ||
            config.revision !== raw.expectedRevision ||
            config.rulesDigest !== raw.rulesDigest ||
            config.binding.feedId !== binding.feedId ||
            wakePairKey(config.binding) !== wakePairKey(binding)
        )
            throw new WakeKeeperError('conflict');
        if ((await this.deps.store.load())?.revision !== config.revision) throw new WakeKeeperError('conflict');
        if (
            !(await this.current(binding, true)) ||
            epoch !== this.epoch ||
            this.configuration?.revision !== config.revision ||
            (await this.deps.store.load())?.revision !== config.revision ||
            this.mutations
        )
            throw new WakeKeeperError('binding');
        if (!this.deps.relay) throw new WakeKeeperError('unavailable');
        if (
            !this.deps.relay.review(
                raw.expectedContextRevision,
                wakeCloudContextKey(wakeCloudContext(config, this.instance)),
            )
        )
            throw new WakeKeeperError('conflict');
        return { schema: 1, accepted: true };
    }
}
