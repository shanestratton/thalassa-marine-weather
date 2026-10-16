import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import { getPairing, getChartDevice, pinnedPiRequest } from '../PiPairingService';
import { isPinnedTransportAvailable } from '../piTls';
import { piCache } from '../PiCacheService';
import { parsePiSignalKNotifications } from './piNotifications';
import { SignalKNotificationAudio } from './notificationAudio';
import type { SignalKNotice, SignalKNoticeEvent } from '../../utils/signalkProtocol';

export interface PairedPiNotificationView {
    status: 'off' | 'connecting' | 'reading' | 'paused' | 'unavailable' | 'enrollment' | 'update' | 'error';
    source: 'pairedPi';
    notices: SignalKNotice[];
    truncated: boolean;
    soundEnabled: boolean;
}
class PairedPiNotificationsClass {
    private view: PairedPiNotificationView = {
        status: 'off',
        source: 'pairedPi',
        notices: [],
        truncated: false,
        soundEnabled: false,
    };
    private listeners = new Set<() => void>();
    private generation = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private guardTimer: ReturnType<typeof setInterval> | null = null;
    private appListener: { remove(): Promise<void> } | null = null;
    private visibility: (() => void) | null = null;
    private audio: SignalKNotificationAudio | null = null;
    private session: string | null = null;
    private clocks = new Map<string, number>();
    constructor() {
        subscribeAuthIdentityScope(() => this.stop('paused'));
    }
    getSnapshot = () => this.view;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    private update(change: Partial<PairedPiNotificationView>): void {
        this.view = { ...this.view, ...change };
        for (const listener of this.listeners) listener();
    }
    stop(status: PairedPiNotificationView['status'] = 'off'): void {
        this.generation++;
        if (this.timer) clearTimeout(this.timer);
        if (this.guardTimer) clearInterval(this.guardTimer);
        this.timer = this.guardTimer = null;
        this.audio?.stop();
        this.audio = null;
        const listener = this.appListener;
        this.appListener = null;
        if (listener) void listener.remove();
        if (this.visibility) document.removeEventListener('visibilitychange', this.visibility);
        this.visibility = null;
        this.session = null;
        this.clocks.clear();
        this.update({ status, notices: [], truncated: false, soundEnabled: false });
    }
    setNotificationSound(enabled: boolean): void {
        if (this.view.status !== 'reading' || this.view.truncated) return;
        this.audio?.setEnabled(enabled);
        this.update({ soundEnabled: enabled });
    }
    /** Explicit foreground reader. Pinned boat LAN only, including in Satellite Mode; never WAN. */
    async start(): Promise<void> {
        this.stop();
        const pairing = getPairing(),
            base = piCache.lanBaseUrlNow(),
            scope = getAuthIdentityScope();
        if (!pairing?.publicKeySpki || !base || !isPinnedTransportAvailable()) return this.stop('unavailable');
        const generation = this.generation,
            startedAt = Date.now();
        const current = () => {
            const now = getPairing();
            const good =
                generation === this.generation &&
                isAuthIdentityScopeCurrent(scope) &&
                isPinnedTransportAvailable() &&
                piCache.lanBaseUrlNow() === base &&
                now?.publicKeySpki === pairing.publicKeySpki &&
                now?.deviceId === pairing.deviceId &&
                now?.pairedAt === pairing.pairedAt &&
                document.visibilityState !== 'hidden';
            if (!good && generation === this.generation) this.stop('paused');
            return good;
        };
        this.update({ status: 'connecting' });
        try {
            const enrolled = await getChartDevice();
            if (!current()) return;
            if (!enrolled) return this.stop('enrollment');
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
            if (!foreground.isActive) return this.stop('paused');
            this.visibility = () => {
                if (document.visibilityState === 'hidden') this.stop('paused');
            };
            document.addEventListener('visibilitychange', this.visibility);
            this.guardTimer = setInterval(current, 1000);
            this.audio = new SignalKNotificationAudio(() => current() && this.view.status === 'reading');
            const poll = async () => {
                if (!current()) return;
                let timeout: ReturnType<typeof setTimeout> | undefined;
                try {
                    const response = await Promise.race([
                        pinnedPiRequest({
                            url: `${base}/api/signalk/notifications`,
                            method: 'GET',
                            responseType: 'text',
                            connectTimeout: 2500,
                            readTimeout: 4000,
                        }),
                        new Promise<never>((_, reject) => {
                            timeout = setTimeout(() => reject(new Error('Pi unavailable')), 7000);
                        }),
                    ]);
                    if (!current()) return;
                    if (response.status === 401 || response.status === 403) return this.stop('enrollment');
                    if (response.status === 404) return this.stop('update');
                    if (response.status !== 200) return this.stop('error');
                    const snapshot = parsePiSignalKNotifications(response.data);
                    const events: SignalKNoticeEvent[] = [];
                    if (snapshot.session !== this.session) {
                        this.audio?.stop();
                        this.clocks.clear();
                        this.session = snapshot.session;
                        this.update({ soundEnabled: false });
                        for (const n of snapshot.notices) this.clocks.set(`${n.source}|${n.path}`, n.at);
                    } else {
                        for (const n of snapshot.notices) {
                            const key = `${n.source}|${n.path}`,
                                old = this.clocks.get(key);
                            if (old === undefined && this.clocks.size >= 64) throw new Error('Pi response unavailable');
                            if (old === undefined || n.at > old) {
                                this.clocks.set(key, n.at);
                                events.push({
                                    notice: n,
                                    fresh:
                                        !snapshot.truncated &&
                                        n.at > startedAt &&
                                        n.at > (snapshot.startedAt ?? Infinity) &&
                                        Date.now() - n.at >= 0 &&
                                        Date.now() - n.at <= 10_000,
                                });
                            }
                        }
                    }
                    if (snapshot.state !== 'reading' || snapshot.truncated) {
                        this.audio?.stop();
                        this.update({ soundEnabled: false });
                    }
                    this.update({
                        status: snapshot.state === 'reading' ? 'reading' : 'unavailable',
                        notices: snapshot.notices,
                        truncated: snapshot.truncated,
                    });
                    this.audio?.update(snapshot.notices, events);
                    if (current())
                        this.timer = setTimeout(() => {
                            this.timer = null;
                            void poll();
                        }, 3000);
                } catch {
                    if (generation === this.generation) this.stop('error');
                } finally {
                    if (timeout) clearTimeout(timeout);
                }
            };
            await poll();
        } catch {
            if (generation === this.generation) this.stop('error');
        }
    }
}
export const PairedPiNotifications = new PairedPiNotificationsClass();
