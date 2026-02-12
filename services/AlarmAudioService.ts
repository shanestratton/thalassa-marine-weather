/**
 * AlarmAudioService — JavaScript wrapper for native AlarmAudioPlugin
 *
 * On iOS: Uses native AVAudioSession(.playback) to bypass the mute switch
 *         and play alarm tones at full volume through the speaker.
 *
 * On Web:  Falls back to Web Audio API oscillator (respects volume controls).
 *
 * Usage:
 *   import { AlarmAudioService } from './AlarmAudioService';
 *   AlarmAudioService.startAlarm();  // Full volume, mute switch bypassed
 *   AlarmAudioService.stopAlarm();
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

interface AlarmAudioPluginInterface {
    startAlarm(): Promise<{ playing: boolean }>;
    stopAlarm(): Promise<{ stopped: boolean }>;
    isAlarmPlaying(): Promise<{ playing: boolean }>;
}

// Register the native plugin (only available on iOS)
const AlarmAudioPlugin = registerPlugin<AlarmAudioPluginInterface>('AlarmAudio');

class AlarmAudioServiceClass {
    private webAlarmInterval: ReturnType<typeof setInterval> | null = null;
    private isPlaying = false;

    /**
     * Start the alarm sound.
     * - iOS: Bypasses mute switch, plays at max volume through speaker.
     * - Web: Uses Web Audio API (respects volume).
     */
    async startAlarm(): Promise<void> {
        if (this.isPlaying) return;

        if (Capacitor.isNativePlatform()) {
            try {
                await AlarmAudioPlugin.startAlarm();
                this.isPlaying = true;
                return;
            } catch (err) {
                console.warn('[AlarmAudio] Native plugin failed, falling back to Web Audio:', err);
            }
        }

        // Web fallback
        this.startWebAlarm();
        this.isPlaying = true;
    }

    /**
     * Stop the alarm sound and restore audio session.
     */
    async stopAlarm(): Promise<void> {
        if (!this.isPlaying) return;

        if (Capacitor.isNativePlatform()) {
            try {
                await AlarmAudioPlugin.stopAlarm();
            } catch {
                /* best effort */
            }
        }

        this.stopWebAlarm();
        this.isPlaying = false;
    }

    /** Check if alarm is currently playing */
    getIsPlaying(): boolean {
        return this.isPlaying;
    }

    // ---- WEB FALLBACK ----

    private startWebAlarm(): void {
        try {
            const AudioCtx = window.AudioContext ||
                ('webkitAudioContext' in window
                    ? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
                    : AudioContext);
            const ctx = new AudioCtx();

            const playTone = () => {
                // Two-tone burst: 880Hz then 1320Hz
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
        } catch (e) {
            console.warn('[AlarmAudio] Web Audio fallback failed:', e);
        }
    }

    private stopWebAlarm(): void {
        if (this.webAlarmInterval) {
            clearInterval(this.webAlarmInterval);
            this.webAlarmInterval = null;
        }
    }
}

export const AlarmAudioService = new AlarmAudioServiceClass();
