/**
 * AlarmAudioService — owner-scoped alarm playback.
 *
 * Every caller acquires an opaque lease and may release only that lease. The
 * native/web alarm stops when the final lease is released, so a short Calypso
 * chime can never silence an active Anchor Watch alarm (or vice versa).
 * On iOS this remains ordinary playback-category audio: audibility still depends
 * on the active route, system volume, Focus behavior, and the pre-arm sound check.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

import { createLogger } from '../utils/createLogger';

const log = createLogger('AlarmAudioService');
const DETACHED_RELEASE_RETRY_MS = 1_000;

interface AlarmAudioPluginInterface {
    startAlarm(): Promise<{ playing: boolean }>;
    stopAlarm(): Promise<{ stopped: boolean }>;
    isAlarmPlaying(): Promise<{ playing: boolean }>;
}

const AlarmAudioPlugin = registerPlugin<AlarmAudioPluginInterface>('AlarmAudio');

class AlarmAudioServiceClass {
    private webAlarmInterval: ReturnType<typeof setInterval> | null = null;
    private isPlaying = false;
    private readonly leases = new Map<string, string>();
    private readonly detachedReleaseRetries = new Map<string, ReturnType<typeof setTimeout> | null>();
    private leaseSequence = 0;
    private operationTail: Promise<void> = Promise.resolve();

    /**
     * Acquire shared ownership of the audible alarm.
     *
     * The returned token is the only authority that can release this owner's
     * claim. Audio starts before the token resolves; a failed native start does
     * not create a phantom lease.
     */
    async acquire(ownerId: string): Promise<string> {
        const owner = ownerId.trim();
        if (!owner || owner.length > 80) throw new Error('A valid alarm-audio owner is required.');

        return this.runExclusive(async () => {
            if (this.leases.size === 0) await this.startUnderlyingAlarm();

            const token = `${owner}:${Date.now().toString(36)}:${++this.leaseSequence}`;
            this.leases.set(token, owner);
            return token;
        });
    }

    /**
     * Release exactly one ownership token. Unknown/already-released tokens are
     * intentionally harmless and can never stop another owner's audio.
     */
    async release(token: string): Promise<void> {
        await this.runExclusive(async () => {
            const owner = this.leases.get(token);
            if (!owner) return;

            this.leases.delete(token);
            if (this.leases.size > 0) return;

            try {
                await this.stopUnderlyingAlarm();
            } catch (error) {
                // The owner must retain a retryable claim when native iOS did
                // not confirm stop; otherwise JS would report idle while the
                // speaker may still be sounding.
                this.leases.set(token, owner);
                throw error;
            }
        });
        this.cancelDetachedReleaseRetry(token);
    }

    /**
     * Keep retrying a specific owner's release after its UI has unmounted.
     * This never bypasses lease ownership, so it cannot silence another alarm
     * owner. Mounted callers should use `release` directly and surface failures
     * so the skipper retains an immediate retry control.
     */
    releaseEventually(token: string): void {
        const lease = token.trim();
        if (!lease || this.detachedReleaseRetries.has(lease)) return;

        this.detachedReleaseRetries.set(lease, null);
        const attemptRelease = async (): Promise<void> => {
            try {
                await this.release(lease);
            } catch (error) {
                log.warn('[AlarmAudioService] Detached lease release will retry', error);
                if (!this.detachedReleaseRetries.has(lease)) return;

                const retryTimer = setTimeout(() => {
                    if (this.detachedReleaseRetries.get(lease) !== retryTimer) return;
                    this.detachedReleaseRetries.set(lease, null);
                    void attemptRelease();
                }, DETACHED_RELEASE_RETRY_MS);
                this.detachedReleaseRetries.set(lease, retryTimer);
            }
        };

        void attemptRelease();
    }

    /**
     * Emergency teardown. This deliberately bypasses the JS playback cache and
     * always invokes the native stop method, even after a reload/race left JS
     * believing audio was idle.
     */
    async forceStop(): Promise<void> {
        await this.runExclusive(async () => {
            await this.stopUnderlyingAlarm();
            this.leases.clear();
        });
        this.cancelAllDetachedReleaseRetries();
    }

    getIsPlaying(): boolean {
        return this.isPlaying;
    }

    /** Exposed for safety diagnostics and deterministic ownership tests. */
    getActiveLeaseCount(): number {
        return this.leases.size;
    }

    private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationTail.then(operation, operation);
        this.operationTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private cancelDetachedReleaseRetry(token: string): void {
        const retryTimer = this.detachedReleaseRetries.get(token);
        if (retryTimer) clearTimeout(retryTimer);
        this.detachedReleaseRetries.delete(token);
    }

    private cancelAllDetachedReleaseRetries(): void {
        for (const retryTimer of this.detachedReleaseRetries.values()) {
            if (retryTimer) clearTimeout(retryTimer);
        }
        this.detachedReleaseRetries.clear();
    }

    private async startUnderlyingAlarm(): Promise<void> {
        if (Capacitor.isNativePlatform()) {
            try {
                const result = await AlarmAudioPlugin.startAlarm();
                if (result.playing !== true) throw new Error('iOS did not confirm alarm playback.');
                this.isPlaying = true;
                return;
            } catch (error) {
                this.isPlaying = false;
                log.warn('[AlarmAudioService]', error);
                throw error instanceof Error ? error : new Error('The native alarm could not start.');
            }
        }

        this.startWebAlarm();
        this.isPlaying = true;
    }

    private async stopUnderlyingAlarm(): Promise<void> {
        if (Capacitor.isNativePlatform()) {
            try {
                // No isPlaying guard: explicit teardown must reach native iOS
                // after reloads, interrupted starts, and stale JS state.
                const result = await AlarmAudioPlugin.stopAlarm();
                if (result.stopped !== true) throw new Error('iOS did not confirm that alarm playback stopped.');
                this.isPlaying = false;
                return;
            } catch (error) {
                log.warn('[AlarmAudioService]', error);
                throw error instanceof Error ? error : new Error('The native alarm could not be stopped.');
            }
        }

        this.stopWebAlarm();
        this.isPlaying = false;
    }

    // ---- WEB FALLBACK ----

    private startWebAlarm(): void {
        const AudioCtx =
            window.AudioContext ||
            ('webkitAudioContext' in window
                ? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
                : AudioContext);
        const ctx = new AudioCtx();

        const playTone = () => {
            const osc1 = ctx.createOscillator();
            const gain1 = ctx.createGain();
            osc1.connect(gain1);
            gain1.connect(ctx.destination);
            osc1.frequency.value = 880;
            osc1.type = 'square';
            gain1.gain.setValueAtTime(0.5, ctx.currentTime);
            gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
            osc1.start(ctx.currentTime);
            osc1.stop(ctx.currentTime + 0.4);

            const osc2 = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.frequency.value = 1320;
            osc2.type = 'square';
            gain2.gain.setValueAtTime(0.5, ctx.currentTime + 0.4);
            gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8);
            osc2.start(ctx.currentTime + 0.4);
            osc2.stop(ctx.currentTime + 0.8);
        };

        playTone();
        this.webAlarmInterval = setInterval(playTone, 1500);
    }

    private stopWebAlarm(): void {
        if (this.webAlarmInterval) {
            clearInterval(this.webAlarmInterval);
            this.webAlarmInterval = null;
        }
    }
}

export const AlarmAudioService = new AlarmAudioServiceClass();
