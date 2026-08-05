import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const nativeAudio = read('ios/App/App/AlarmAudioPlugin.swift');
const infoPlist = read('ios/App/App/Info.plist');
const audioService = read('services/AlarmAudioService.ts');
const soundCheck = read('components/anchor-watch/SoundCheckModal.tsx');
const anchorPage = read('components/AnchorWatchPage.tsx');

describe('native Anchor Watch audible-alarm contract', () => {
    it('uses one continuously looping player instead of Timer-scheduled audio bursts', () => {
        expect(nativeAudio).toContain('let player = try AVAudioPlayer(data: Self.alarmWaveData)');
        expect(nativeAudio).toContain('player.numberOfLoops = -1');
        expect(nativeAudio).toContain('try session.setCategory(.playback');
        expect(nativeAudio).toContain('try session.setActive(true)');
        expect(nativeAudio).not.toContain('Timer.scheduledTimer');
        expect(nativeAudio).not.toContain('AVAudioEngine()');
        expect(infoPlist).toMatch(/<key>UIBackgroundModes<\/key>[\s\S]*?<string>audio<\/string>/);
    });

    it('rebuilds active alarm playback after interruptions and media-service resets', () => {
        expect(nativeAudio).toContain('AVAudioSession.interruptionNotification');
        expect(nativeAudio).toContain('AVAudioSession.mediaServicesWereResetNotification');
        expect(nativeAudio).toContain('handleAudioSessionInterruption');
        expect(nativeAudio).toContain('handleMediaServicesReset');
        expect(nativeAudio).toContain('resumeAlarmAfterSystemEvent(reason: "interruption")');
        expect(nativeAudio).toContain('resumeAlarmAfterSystemEvent(reason: "media-services reset")');
        expect(nativeAudio).toContain('guard alarmRequested else { return }');
        expect(nativeAudio).toContain('capturePreviousConfiguration: false');
        expect(nativeAudio).toContain('call.reject("Alarm audio is active but could not resume playback.")');
        expect(nativeAudio).toContain('let nextDelay = min(30, retryDelay * 2)');
        expect(nativeAudio).toContain('guard let self = self, self.alarmRequested, !self.isPlaying else { return }');
    });

    it('makes explicit stop authoritative and never manipulates system volume', () => {
        const stopMethod = nativeAudio.slice(
            nativeAudio.indexOf('@objc func stopAlarm'),
            nativeAudio.indexOf('// MARK: - Check Status'),
        );
        expect(stopMethod).toContain('self.cancelRequestedAlarmAndRestoreSession()');
        const authoritativeStop = nativeAudio.slice(
            nativeAudio.indexOf('private func cancelRequestedAlarmAndRestoreSession()'),
            nativeAudio.indexOf('public func audioPlayerDidFinishPlaying'),
        );
        expect(authoritativeStop).toContain('alarmRequested = false');
        expect(authoritativeStop).toContain('resumeRetryWorkItem?.cancel()');
        expect(authoritativeStop).toContain('stopLoopingAlarmPlayer()');
        expect(authoritativeStop).toContain('restoreAudioSession()');
        expect(nativeAudio).not.toContain('MPVolumeView');
        expect(nativeAudio).not.toContain('UISlider');
        expect(nativeAudio).not.toContain('outputVolume');

        // The three-second setup test exercises the exact service and stop path
        // used by a real alarm rather than a separate preview sound.
        expect(soundCheck).toContain("const leasePromise = AlarmAudioService.acquire('anchor-sound-check')");
        expect(soundCheck).toContain('testLeasePromiseRef.current = leasePromise');
        expect(soundCheck).toContain('const lease = await leasePromise');
        expect(soundCheck).toContain('AlarmAudioService.releaseEventually(resolvedLease)');
        expect(soundCheck).toContain('await AlarmAudioService.release(lease)');
        expect(soundCheck).toContain('}, 3_000);');
        expect(soundCheck).toContain('Confirm alarm was audible');
        expect(soundCheck).toContain(
            'disabled={!alarmAudibilityConfirmed || notificationBlocked || audioCleanupBlocked}',
        );
        expect(anchorPage).toContain('Every arming attempt requires a fresh audible test');
        expect(anchorPage).not.toContain('soundCheckShownRef');
    });

    it('does not describe ordinary app audio as an unsupported Critical Alert guarantee', () => {
        expect(nativeAudio).toContain('This is ordinary app audio, not a Critical Alert');
        expect(nativeAudio).toContain('Actual audibility still depends on');
        expect(nativeAudio).not.toMatch(/regardless of:[\s\S]{0,240}(Do Not Disturb|Volume button)/i);
        expect(audioService).not.toMatch(/full volume, mute switch bypassed/i);
        expect(audioService).toContain('audibility still depends');
    });

    it('fails closed instead of disguising a native bridge failure as web audio', () => {
        const nativeStart = audioService.slice(
            audioService.indexOf('private async startUnderlyingAlarm()'),
            audioService.indexOf('private async stopUnderlyingAlarm()'),
        );
        expect(nativeStart).toContain("throw new Error('iOS did not confirm alarm playback.')");
        expect(nativeStart).toContain(
            "throw error instanceof Error ? error : new Error('The native alarm could not start.')",
        );
        expect(nativeStart.indexOf('this.startWebAlarm()')).toBeGreaterThan(
            nativeStart.indexOf('if (Capacitor.isNativePlatform())'),
        );
        expect(audioService).toContain("throw new Error('iOS did not confirm that alarm playback stopped.')");
    });

    it('uses owner-scoped leases and an authoritative uncached emergency stop', () => {
        expect(audioService).toContain('private readonly leases = new Map<string, string>()');
        expect(audioService).toContain('async acquire(ownerId: string): Promise<string>');
        expect(audioService).toContain('async release(token: string): Promise<void>');
        expect(audioService).toContain('if (this.leases.size > 0) return');
        expect(audioService).toContain('async forceStop(): Promise<void>');

        const forceStop = audioService.slice(
            audioService.indexOf('async forceStop()'),
            audioService.indexOf('getIsPlaying()'),
        );
        expect(forceStop).toContain('await this.stopUnderlyingAlarm()');
        expect(forceStop).not.toContain('if (!this.isPlaying)');
    });
});
