import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import { getPairing, getChartDevice, pinnedPiRequest } from '../PiPairingService';
import { piCache } from '../PiCacheService';
import { isPinnedTransportAvailable } from '../piTls';
import {
    evaluateWakeRule,
    initialWakeState,
    wakeKeeper,
    wakePresetPriority,
    wakeRulesCanonical,
    WAKE_PRESETS,
    type WakeEvaluation,
    type WakePreset,
    type WakeState,
    type WakeReading,
} from '../../utils/wakeRule';
import { getWakeRulePreferences, subscribeWakeRulePreferences } from './wakeRulePreferences';
import { clearWakeRuleSources, publishWakeRuleSources, wakeSourceKey } from './wakeRuleSources';
import {
    parseWakePiConfigurationResponse,
    parseWakePiSensors,
    parseWakePiStatus,
    wakePiBindingKey,
} from './wakePiWire';
import type { WakeKeeperStatus, WakeSensors } from '../../utils/wakePiContract';
import { WakeAlarmStore } from './wakeAlarmStore';

export interface WakePhoneRule extends WakeEvaluation {
    preset: WakePreset;
    value: number | null;
    depthBasis?: WakeReading['depthBasis'];
}
export interface WakeRuleView {
    state:
        | 'off'
        | 'connecting'
        | 'watching'
        | 'paused'
        | 'unavailable'
        | 'enrollment'
        | 'update'
        | 'conflict'
        | 'error';
    keeper: 'phone-only' | 'pi';
    rules: readonly WakePhoneRule[];
    pi: WakeKeeperStatus | null;
    busy: boolean;
    muted: boolean;
}
const empty = (): WakeRuleView => ({
    state: 'off',
    keeper: 'phone-only',
    rules: [],
    pi: null,
    busy: false,
    muted: false,
});
const digest = async (text: string) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
type Alarm = Pick<typeof import('../AlarmAudioService').AlarmAudioService, 'acquire' | 'releaseEventually'>;

/** Foreground, enrolled boat-LAN measurements only. Mutations are explicit CAS operations. */
export class WakeRuleWatchClass {
    private view = empty();
    private listeners = new Set<() => void>();
    private generation = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private guard: ReturnType<typeof setInterval> | null = null;
    private appListener: { remove(): Promise<void> } | null = null;
    private visibility: (() => void) | null = null;
    private current: (() => boolean) | null = null;
    private request:
        | ((
              path: string,
              method?: 'GET' | 'POST' | 'DELETE',
              data?: unknown,
          ) => Promise<{ status: number; data: unknown }>)
        | null = null;
    private states = new Map<WakePreset, WakeState>();
    private sensors: WakeSensors | null = null;
    private bindingKey: string | null = null;
    private rulesDigest: string | null = null;
    private draftM: number | null = null;
    private audioGeneration = 0;
    private pendingAudio = false;
    private held: { audio: Alarm; lease: string } | null = null;
    private preferenceStop: (() => void) | null = null;
    constructor(
        private readonly loadAudio: () => Promise<Alarm> = async () =>
            (await import('../AlarmAudioService')).AlarmAudioService,
    ) {
        subscribeAuthIdentityScope(() => this.stop('paused', true));
    }
    getSnapshot = () => this.view;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    private update(change: Partial<WakeRuleView>) {
        this.view = { ...this.view, ...change };
        WakeAlarmStore.publish(
            this.view.rules
                .filter((r) => r.state.active)
                .sort((a, b) => wakePresetPriority(a.preset) - wakePresetPriority(b.preset))
                .map((r) => ({
                    preset: r.preset,
                    status: this.view.state === 'watching' ? r.status : this.view.state,
                    value: r.value,
                    quiet: r.quiet,
                    muted: this.view.muted,
                    ...(r.depthBasis ? { depthBasis: r.depthBasis } : {}),
                    ...this.piEpisode(r.preset),
                })),
        );
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch {
                console.error('[WakeRules] subscriber failed');
            }
        }
    }
    private piEpisode(preset: WakePreset) {
        const config = this.view.pi?.configuration,
            episode = this.view.pi?.rules.find((r) => r.preset === preset)?.episode;
        if (!config || config.rulesDigest !== this.rulesDigest || !episode) return {};
        if (episode.ackedAt !== null) return { acknowledged: true };
        const revision = this.view.pi?.push.contextRevision;
        return this.view.pi?.push.capability === 1 && revision
            ? {
                  cloud: {
                      ownerId: config.binding.ownerId,
                      piDeviceId: config.binding.piDeviceId,
                      contextRevision: revision,
                      rulesDigest: config.rulesDigest,
                      key: episode.key,
                  },
              }
            : {};
    }
    private releaseAudio() {
        this.audioGeneration++;
        this.pendingAudio = false;
        const held = this.held;
        this.held = null;
        held?.audio.releaseEventually(held.lease);
    }
    private sound() {
        if (!this.current?.() || this.view.muted || !this.view.rules.some((r) => r.audible)) return this.releaseAudio();
        if (this.held || this.pendingAudio) return;
        const generation = this.audioGeneration;
        this.pendingAudio = true;
        void this.loadAudio()
            .then(async (audio) => {
                if (
                    generation !== this.audioGeneration ||
                    !this.current?.() ||
                    this.view.muted ||
                    !this.view.rules.some((r) => r.audible)
                )
                    return;
                const first = [...this.view.rules]
                    .filter((r) => r.audible)
                    .sort((a, b) => wakePresetPriority(a.preset) - wakePresetPriority(b.preset))[0];
                const lease = await audio.acquire(first.preset === 'depth-below-keel' ? 'wake-depth' : 'wake-sensor');
                if (
                    generation !== this.audioGeneration ||
                    !this.current?.() ||
                    this.view.muted ||
                    !this.view.rules.some((r) => r.audible)
                )
                    audio.releaseEventually(lease);
                else this.held = { audio, lease };
            })
            .catch(() => undefined)
            .finally(() => {
                if (generation === this.audioGeneration) this.pendingAudio = false;
            });
    }
    mute() {
        this.update({ muted: true });
        this.releaseAudio();
    }
    unmute() {
        this.update({ muted: false });
        this.sound();
    }
    stop(state: WakeRuleView['state'] = 'off', retire = false) {
        this.generation++;
        if (this.timer) clearTimeout(this.timer);
        if (this.guard) clearInterval(this.guard);
        this.timer = this.guard = null;
        this.current = this.request = null;
        this.preferenceStop?.();
        this.preferenceStop = null;
        if (this.visibility) document.removeEventListener('visibilitychange', this.visibility);
        this.visibility = null;
        const listener = this.appListener;
        this.appListener = null;
        if (listener) void listener.remove();
        clearWakeRuleSources(getAuthIdentityScope());
        this.sensors = null;
        this.rulesDigest = null;
        this.releaseAudio();
        if (retire) {
            this.states.clear();
            this.bindingKey = null;
            this.view = empty();
        }
        this.update({ state, keeper: 'phone-only', pi: null, busy: false });
    }
    private evaluate() {
        const preferences = getWakeRulePreferences(),
            now = Date.now();
        const readings = new Map(
            this.sensors?.options.map((o) => [wakeSourceKey(o.preset, o.selection), o.reading]) ?? [],
        );
        const rows = preferences.rules.map((rule) => {
            const reading = rule.selection ? (readings.get(wakeSourceKey(rule.preset, rule.selection)) ?? null) : null;
            const result = evaluateWakeRule(rule, this.states.get(rule.preset) ?? initialWakeState(), reading, now);
            if (
                this.view.pi?.configuration?.rulesDigest === this.rulesDigest &&
                this.view.pi.rules.find((r) => r.preset === rule.preset)?.episode?.ackedAt != null
            )
                result.audible = false;
            this.states.set(rule.preset, result.state);
            const previous = this.view.rules.find((r) => r.preset === rule.preset),
                depthBasis = reading?.depthBasis ?? (result.state.active ? previous?.depthBasis : undefined);
            return {
                ...result,
                preset: rule.preset,
                value: result.status === 'unknown' ? null : (reading?.value ?? null),
                ...(depthBasis ? { depthBasis } : {}),
            };
        });
        if (rows.some((r) => r.transition === 'fire')) this.view = { ...this.view, muted: false };
        const pi = this.view.pi,
            binding = this.sensors?.binding;
        const fresh =
            pi?.running &&
            !this.sensors?.truncated &&
            pi.configuration &&
            pi.configuration.rulesDigest === this.rulesDigest &&
            wakeRulesCanonical(pi.configuration.rules, pi.configuration.draftM) ===
                wakeRulesCanonical(preferences.rules, this.draftM) &&
            pi.configuration.rules.every(
                (rule) =>
                    !rule.enabled ||
                    pi.rules.some(
                        (row) =>
                            row.preset === rule.preset &&
                            ['watching', 'pending', 'active'].includes(row.status) &&
                            row.lastAt !== null &&
                            row.lastAt <= now + 1000 &&
                            now - row.lastAt <= WAKE_PRESETS[rule.preset].maxAge,
                    ),
            );
        const keeper =
            fresh && binding && this.rulesDigest
                ? wakeKeeper(
                      pi.proof,
                      { ownerId: binding.ownerId, feedId: binding.feedId, rulesDigest: this.rulesDigest },
                      now,
                  )
                : 'phone-only';
        this.update({ rules: rows, keeper });
        this.sound();
    }
    private sameBinding(binding: NonNullable<WakeSensors['binding']>) {
        return !!this.sensors?.binding && wakePiBindingKey(this.sensors.binding) === wakePiBindingKey(binding);
    }
    /** Explicit read, or boot resume of already enabled rules. Never starts a Pi keeper. */
    async start(draftM: number | null = null, contextCurrent: () => boolean = () => true) {
        if (!(draftM === null || (Number.isFinite(draftM) && draftM > 0 && draftM <= 20))) return;
        this.stop('off');
        this.draftM = draftM;
        const storedPairing = getPairing();
        const pairing = storedPairing ? { ...storedPairing } : null,
            base = piCache.lanBaseUrlNow(),
            scope = getAuthIdentityScope();
        if (!scope.userId || !pairing?.publicKeySpki || !base || !isPinnedTransportAvailable())
            return this.stop('unavailable');
        const generation = this.generation;
        const current = () => {
            const next = getPairing();
            const good =
                generation === this.generation &&
                contextCurrent() &&
                isAuthIdentityScopeCurrent(scope) &&
                isPinnedTransportAvailable() &&
                base === piCache.lanBaseUrlNow() &&
                next?.deviceId === pairing.deviceId &&
                next?.publicKeySpki === pairing.publicKeySpki &&
                next?.pairedAt === pairing.pairedAt &&
                document.visibilityState !== 'hidden';
            if (!good && generation === this.generation) this.stop('paused', true);
            return good;
        };
        this.current = current;
        this.update({ state: 'connecting' });
        try {
            const enrolled = await getChartDevice();
            if (!current()) return;
            if (!enrolled) return this.stop('enrollment', true);
            const { App } = await import('@capacitor/app');
            if (!current()) return;
            const listener = await App.addListener('appStateChange', (s) => {
                if (!s.isActive && current()) this.stop('paused');
            });
            if (!current()) {
                void listener.remove();
                return;
            }
            this.appListener = listener;
            const foreground = await App.getState();
            if (!current()) return;
            if (!foreground.isActive) return this.stop('paused');
            this.visibility = () => {
                if (document.visibilityState === 'hidden') this.stop('paused');
            };
            document.addEventListener('visibilitychange', this.visibility);
            this.request = async (path, method = 'GET', data) => {
                let timeout: ReturnType<typeof setTimeout> | undefined;
                try {
                    return await Promise.race([
                        pinnedPiRequest({
                            url: `${base}/api/wake-rules/${path}`,
                            method,
                            data,
                            responseType: 'text',
                            connectTimeout: 2500,
                            readTimeout: 4000,
                            isCurrent: current,
                        }),
                        new Promise<never>((_, reject) => {
                            timeout = setTimeout(() => reject(Error('Boat unavailable')), 7000);
                        }),
                    ]);
                } finally {
                    if (timeout) clearTimeout(timeout);
                }
            };
            this.preferenceStop = subscribeWakeRulePreferences(() => {
                if (current()) {
                    this.rulesDigest = null;
                    this.update({ keeper: 'phone-only' });
                    this.evaluate();
                }
            });
            this.guard = setInterval(() => {
                if (current()) this.evaluate();
            }, 1000);
            const poll = async () => {
                if (!current() || !this.request) return;
                try {
                    const enrolledNow = await getChartDevice();
                    if (!current()) return;
                    if (enrolledNow?.chartDeviceId !== enrolled.chartDeviceId) return this.stop('enrollment', true);
                    const sensorResponse = await this.request(`sensors?draftM=${draftM === null ? 'none' : draftM}`);
                    if (!current()) return;
                    if (sensorResponse.status === 401 || sensorResponse.status === 403)
                        return this.stop('enrollment', true);
                    if (sensorResponse.status === 404) return this.stop('update');
                    if (sensorResponse.status !== 200) throw Error();
                    const sensors = parseWakePiSensors(sensorResponse.data, Date.now());
                    const binding = sensors.binding;
                    if (
                        !binding ||
                        binding.ownerId !== scope.userId ||
                        binding.piDeviceId !== pairing.deviceId ||
                        binding.deviceId !== enrolled.chartDeviceId ||
                        sensors.draftM !== draftM
                    )
                        return this.stop('unavailable', true);
                    const key = wakePiBindingKey(binding);
                    if (this.bindingKey !== key) {
                        this.states.clear();
                        this.releaseAudio();
                        this.bindingKey = key;
                        this.update({ rules: [], keeper: 'phone-only', pi: null, muted: false });
                    }
                    this.sensors = sensors;
                    publishWakeRuleSources(scope, sensors.truncated ? [] : sensors.options);
                    if (sensors.truncated) this.sensors = { ...sensors, options: [] };
                    const response = await this.request('status');
                    if (!current()) return;
                    if (response.status === 401 || response.status === 403) return this.stop('enrollment', true);
                    if (response.status !== 200) throw Error();
                    const status = parseWakePiStatus(response.data, Date.now());
                    if (!status.binding || wakePiBindingKey(status.binding) !== key)
                        return this.stop('unavailable', true);
                    const canonical = wakeRulesCanonical(getWakeRulePreferences().rules, draftM);
                    const expected = await digest(canonical);
                    if (!current()) return;
                    if (canonical !== wakeRulesCanonical(getWakeRulePreferences().rules, draftM)) throw Error();
                    this.rulesDigest = expected;
                    this.update({
                        state: 'watching',
                        pi: status,
                        keeper: wakeKeeper(
                            status.proof,
                            { ownerId: scope.userId, feedId: binding.feedId, rulesDigest: expected },
                            Date.now(),
                        ),
                    });
                    this.evaluate();
                } catch {
                    if (!current()) return;
                    this.sensors = null;
                    clearWakeRuleSources(scope);
                    this.update({ state: 'error', keeper: 'phone-only', pi: null });
                    this.evaluate();
                }
                if (current())
                    this.timer = setTimeout(() => {
                        this.timer = null;
                        void poll();
                    }, 3000);
            };
            await poll();
        } catch {
            if (current()) this.stop('error');
        }
    }
    /** No retries or automatic replacement after 409/uncertain network outcomes. */
    async configurePi(replaceExisting = false): Promise<boolean> {
        const current = this.current,
            request = this.request,
            status = this.view.pi,
            sensors = this.sensors;
        const scope = getAuthIdentityScope(),
            preferences = getWakeRulePreferences();
        if (
            !current?.() ||
            !request ||
            !status ||
            !sensors?.binding ||
            this.view.busy ||
            !this.rulesDigest ||
            preferences.unreadable ||
            sensors.truncated ||
            (status.configuration !== null && !replaceExisting)
        )
            return false;
        const canonical = wakeRulesCanonical(preferences.rules, this.draftM),
            expected = this.rulesDigest;
        const binding = sensors.binding;
        this.update({ busy: true, keeper: 'phone-only' });
        try {
            if (
                (await digest(canonical)) !== expected ||
                !current() ||
                !isAuthIdentityScopeCurrent(scope) ||
                !this.sameBinding(binding) ||
                this.view.pi !== status
            )
                return false;
            const data = {
                schema: 1,
                expectedRevision: status.configuration?.revision ?? null,
                binding,
                draftM: this.draftM,
                rulesDigest: expected,
                rules: preferences.rules,
            };
            if (new TextEncoder().encode(JSON.stringify(data)).length > 16_384) return false;
            if (canonical !== wakeRulesCanonical(getWakeRulePreferences().rules, this.draftM)) return false;
            const response = await request('configuration', 'POST', data);
            if (!current() || !this.sameBinding(binding)) return false;
            if (response.status === 409) {
                this.update({ state: 'conflict', pi: null });
                return false;
            }
            if (response.status !== 200) throw Error();
            const saved = parseWakePiConfigurationResponse(response.data);
            if (
                saved.rulesDigest !== expected ||
                wakePiBindingKey(saved.binding) !== wakePiBindingKey(binding) ||
                wakeRulesCanonical(saved.rules, saved.draftM) !== canonical
            )
                throw Error();
            // Acknowledged configuration is not running proof. The next fresh poll must prove it.
            this.update({ pi: null });
            return true;
        } catch {
            if (current()) this.update({ state: 'error', pi: null });
            return false;
        } finally {
            if (current()) this.update({ busy: false });
        }
    }
    async clearPi(): Promise<boolean> {
        const current = this.current,
            request = this.request,
            configuration = this.view.pi?.configuration,
            binding = this.sensors?.binding;
        if (
            !current?.() ||
            !request ||
            !configuration ||
            !binding ||
            this.view.busy ||
            configuration.binding.feedId !== binding.feedId
        )
            return false;
        this.update({ busy: true, keeper: 'phone-only' });
        try {
            const response = await request('configuration', 'DELETE', {
                schema: 1,
                expectedRevision: configuration.revision,
                binding,
                rulesDigest: configuration.rulesDigest,
            });
            if (!current() || !this.sameBinding(binding)) return false;
            if (response.status === 409) {
                this.update({ state: 'conflict', pi: null });
                return false;
            }
            if (response.status !== 200 || typeof response.data !== 'string' || response.data.length > 1024)
                throw Error();
            const result = JSON.parse(response.data);
            if (result.schema !== 1 || result.cleared !== true) throw Error();
            this.update({ pi: null });
            return true;
        } catch {
            if (current()) this.update({ state: 'error', pi: null });
            return false;
        } finally {
            if (current()) this.update({ busy: false });
        }
    }
}
export const WakeRuleWatch = new WakeRuleWatchClass();
