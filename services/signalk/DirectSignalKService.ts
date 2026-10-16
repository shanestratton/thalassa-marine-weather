import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import { getSecureValue, setSecureValue, removeSecureValue, SECURE_SIGNALK_DEVICE_KEY } from '../auth/secureStorage';
import { NmeaStore } from '../NmeaStore';
import { NmeaListenerService } from '../NmeaListenerService';
import { getPairing } from '../PiPairingService';
import { satelliteModeActive } from '../networkPolicy';
import {
    SignalKReadState,
    signalkRecord,
    validSignalKSelf,
    type SignalKNotice,
} from '../../pi-cache/src/signalkProtocol';
import { readSignalKDeviceConfig, saveSignalKDeviceConfig, type SignalKDeviceConfig } from './config';
import { nativeSignalKAvailable, signalKNativeRequest, openSignalKNative } from './native';
import { directSignalKSnapshot } from './snapshot';
import { SignalKNotificationAudio } from './notificationAudio';
export type DirectSignalKStatus =
    | 'off'
    | 'approval'
    | 'pending'
    | 'denied'
    | 'unsupported'
    | 'connecting'
    | 'reading'
    | 'paused'
    | 'error';
export interface DirectSignalKView {
    status: DirectSignalKStatus;
    notices: SignalKNotice[];
    soundEnabled?: boolean;
}
let writes: Promise<void> = Promise.resolve();
const write = (action: () => Promise<void>) => {
    const next = writes.catch(() => undefined).then(action);
    writes = next;
    return next;
};
function tokenValue(raw: unknown): raw is string {
    return typeof raw === 'string' && raw.length > 0 && raw.length <= 4096 && /^[\x21-\x7e]+$/.test(raw);
}
export function accessRequestId(value: unknown, origin: string): string | null {
    const body = signalkRecord(value);
    if (body?.state !== 'PENDING' || typeof body.href !== 'string' || body.href.length > 512) return null;
    try {
        const url = new URL(body.href, origin);
        if (url.origin !== origin || url.search || url.hash || url.username || url.password) return null;
        const m = /^\/signalk\/v1\/access\/requests\/([^/]{1,512})$/.exec(url.pathname);
        if (!m) return null;
        const id = decodeURIComponent(m[1]);
        return id.length > 0 && id.length <= 128 && !['.', '..'].includes(id) && !/[\p{Cc}]/u.test(id) ? id : null;
    } catch {
        return null;
    }
}
export function approvedSignalKAccess(
    value: unknown,
    now = Date.now(),
): { token: string; expiresAt: number | null } | 'denied' | null {
    const body = signalkRecord(value),
        access = signalkRecord(body?.accessRequest);
    if (body?.state !== 'COMPLETED' || body.statusCode !== 200 || !access) return null;
    if (access.permission === 'DENIED') return 'denied';
    if (access.permission !== 'APPROVED' || !tokenValue(access.token)) return null;
    const expiresAt =
        access.expirationTime === undefined
            ? null
            : typeof access.expirationTime === 'string'
              ? Date.parse(access.expirationTime)
              : NaN;
    return expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > now)
        ? { token: access.token, expiresAt }
        : null;
}
class DirectSignalKServiceClass {
    private generation = 0;
    private transport: ReturnType<typeof openSignalKNative> | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private abort: AbortController | null = null;
    private appListener: { remove(): Promise<void> } | null = null;
    private listeners = new Set<() => void>();
    private view: DirectSignalKView = { status: 'off', notices: [] };
    private audio: SignalKNotificationAudio | null = null;
    private activeConfig: string | null = null;
    private pending: {
        config: SignalKDeviceConfig;
        id: string;
        scope: ReturnType<typeof getAuthIdentityScope>;
        at: number;
    } | null = null;
    constructor() {
        subscribeAuthIdentityScope(() => {
            this.pending = null;
            this.stop();
        });
    }
    getSnapshot = (): DirectSignalKView => this.view;
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    private update(status: DirectSignalKStatus, notices: SignalKNotice[] = []) {
        this.view = { status, notices, soundEnabled: this.view.soundEnabled === true && status === 'reading' };
        for (const listener of this.listeners) listener();
    }
    stop(status: DirectSignalKStatus = 'off'): void {
        this.audio?.stop();
        this.audio = null;
        this.activeConfig = null;
        this.generation++;
        this.abort?.abort();
        this.abort = null;
        this.transport?.stop();
        this.transport = null;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        const held = this.appListener;
        this.appListener = null;
        if (held) void held.remove();
        NmeaStore.clearRemote('signalk');
        this.update(status);
    }
    setNotificationSound(enabled: boolean): void {
        if (this.view.status !== 'reading') return;
        this.audio?.setEnabled(enabled);
        this.view = { ...this.view, soundEnabled: enabled };
        for (const listener of this.listeners) listener();
    }
    /** Explicit user action only; boot never asks an administrator or polls approval. */
    async requestApproval(config: SignalKDeviceConfig): Promise<void> {
        this.pending = null;
        this.stop();
        if (getPairing()) {
            this.update('paused');
            return;
        }
        if (!nativeSignalKAvailable()) {
            this.update('unsupported');
            return;
        }
        if (satelliteModeActive()) {
            this.update('paused');
            return;
        }
        saveSignalKDeviceConfig({ ...config, selected: true });
        const scope = getAuthIdentityScope(),
            generation = this.generation;
        this.abort = new AbortController();
        this.update('connecting');
        try {
            const reply = await signalKNativeRequest(config, 'access', { signal: this.abort.signal });
            if (generation !== this.generation || !isAuthIdentityScopeCurrent(scope)) return;
            if (reply.status === 501) {
                this.update('unsupported');
                return;
            }
            const id = reply.status === 202 ? accessRequestId(reply.body, config.origin) : null;
            if (!id) {
                this.update('error');
                return;
            }
            this.pending = { config, id, scope, at: Date.now() };
            this.update('pending');
        } catch {
            if (generation === this.generation) this.update('error');
        }
    }
    async checkApproval(): Promise<void> {
        const pending = this.pending;
        if (!pending || !isAuthIdentityScopeCurrent(pending.scope) || Date.now() - pending.at > 15 * 60_000)
            return this.update('approval');
        if (getPairing() || satelliteModeActive()) {
            this.stop('paused');
            return;
        }
        const generation = this.generation;
        try {
            const reply = await signalKNativeRequest(pending.config, 'accessStatus', { accessId: pending.id });
            if (generation !== this.generation || !isAuthIdentityScopeCurrent(pending.scope)) return;
            if ([200, 202].includes(reply.status) && signalkRecord(reply.body)?.state === 'PENDING')
                return this.update('pending');
            const access = reply.status === 200 ? approvedSignalKAccess(reply.body) : null;
            if (access === 'denied') {
                this.pending = null;
                this.update('denied');
                return;
            }
            if (!access) {
                this.update('error');
                return;
            }
            await write(() =>
                setSecureValue(
                    SECURE_SIGNALK_DEVICE_KEY,
                    JSON.stringify({
                        owner: pending.scope.key,
                        origin: pending.config.origin,
                        clientId: pending.config.clientId,
                        ...access,
                    }),
                ),
            );
            if (generation !== this.generation || !isAuthIdentityScopeCurrent(pending.scope)) return;
            this.pending = null;
            await this.start();
        } catch {
            if (generation === this.generation) this.update('error');
        }
    }
    async forget(): Promise<void> {
        this.pending = null;
        this.stop();
        const config = readSignalKDeviceConfig();
        if (config) saveSignalKDeviceConfig({ ...config, selected: false });
        const scope = getAuthIdentityScope();
        if (!nativeSignalKAvailable()) return;
        try {
            await write(async () => {
                const raw = await getSecureValue(SECURE_SIGNALK_DEVICE_KEY);
                let v: unknown;
                try {
                    v = JSON.parse(raw ?? 'null');
                } catch {
                    return;
                }
                if (signalkRecord(v)?.owner === scope.key) await removeSecureValue(SECURE_SIGNALK_DEVICE_KEY);
            });
        } catch {
            this.update('error');
        }
    }
    async start(): Promise<void> {
        const next = readSignalKDeviceConfig(),
            nextScope = getAuthIdentityScope();
        const nextIdentity = next
            ? JSON.stringify([nextScope.key, nextScope.generation, next.origin, next.clientId, next.allowInsecureLan])
            : null;
        if (
            this.transport &&
            this.view.status === 'reading' &&
            next?.selected &&
            this.activeConfig === nextIdentity &&
            !getPairing() &&
            !satelliteModeActive()
        )
            return;
        this.stop();
        const config = readSignalKDeviceConfig();
        if (!config?.selected) return;
        if (getPairing() || satelliteModeActive()) {
            this.update('paused');
            return;
        }
        if (!nativeSignalKAvailable()) {
            this.update('unsupported');
            return;
        }
        const scope = getAuthIdentityScope(),
            generation = this.generation;
        const current = () => {
            const selected = readSignalKDeviceConfig();
            const valid =
                generation === this.generation &&
                isAuthIdentityScopeCurrent(scope) &&
                !getPairing() &&
                selected?.origin === config.origin &&
                selected.clientId === config.clientId &&
                selected.allowInsecureLan === config.allowInsecureLan &&
                selected.selected === true &&
                !satelliteModeActive();
            if (!valid && generation === this.generation) this.stop('paused');
            return valid;
        };
        this.abort = new AbortController();
        this.update('connecting');
        try {
            await writes.catch(() => undefined);
            const raw = await getSecureValue(SECURE_SIGNALK_DEVICE_KEY);
            if (!current()) return;
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw ?? 'null');
            } catch {
                parsed = null;
            }
            const access = signalkRecord(parsed);
            if (
                !access ||
                access.owner !== scope.key ||
                access.origin !== config.origin ||
                access.clientId !== config.clientId ||
                !tokenValue(access.token) ||
                !(access.expiresAt === null || (typeof access.expiresAt === 'number' && access.expiresAt > Date.now()))
            ) {
                this.update('approval');
                return;
            }
            const accessToken = access.token;
            const { App } = await import('@capacitor/app');
            if (!current()) return;
            const listener = await App.addListener('appStateChange', (state) => {
                if (!state.isActive && current()) this.stop('paused');
            });
            if (!current()) {
                void listener.remove();
                return;
            }
            this.appListener = listener;
            const foreground = await App.getState();
            if (!current()) return;
            if (!foreground.isActive) {
                this.stop('paused');
                return;
            }
            const reply = await signalKNativeRequest(config, 'self', { accessToken, signal: this.abort!.signal });
            if (!current()) return;
            if (reply.status === 401 || reply.status === 403) {
                this.stop('approval');
                return;
            }
            const document = signalkRecord(reply.body),
                self = document?.uuid;
            if (reply.status !== 200 || !document || !validSignalKSelf(self)) {
                this.stop('error');
                return;
            }
            const state = new SignalKReadState(self);
            state.ingestSelfDocument(document);
            const identity = `signalk:${scope.key}:${config.origin}:${self}:${generation}`;
            const meterIdentity = `signalk:${scope.key}:${config.clientId}:${self}`;
            this.audio = new SignalKNotificationAudio(current);
            this.activeConfig = nextIdentity;
            NmeaListenerService.stop();
            NmeaStore.start();
            const publish = () => {
                if (!current()) {
                    if (generation === this.generation) this.stop('paused');
                    return;
                }
                if (
                    access.expiresAt !== null &&
                    typeof access.expiresAt === 'number' &&
                    access.expiresAt <= Date.now()
                ) {
                    this.stop('approval');
                    return;
                }
                NmeaStore.ingestRemote(directSignalKSnapshot(state.document(), identity, Date.now(), meterIdentity));
                this.update('reading', state.notifications());
            };
            const transport = openSignalKNative(
                config,
                accessToken,
                (text) => {
                    if (!current()) return;
                    let value: unknown;
                    try {
                        value = JSON.parse(text);
                    } catch {
                        this.stop('error');
                        return;
                    }
                    const result = state.ingestDelta(value);
                    this.audio?.update(state.notifications(), result.notices);
                    publish();
                },
                () => {
                    if (generation === this.generation) this.stop('error');
                },
            );
            this.transport = transport;
            await transport.ready;
            if (!current()) {
                transport.stop();
                return;
            }
            publish();
            this.timer = setInterval(publish, 1000);
        } catch {
            if (generation === this.generation) this.stop('error');
        }
    }
}
export const DirectSignalKService = new DirectSignalKServiceClass();
