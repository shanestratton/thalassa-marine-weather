import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const soundName = 'thalassa-anchor-alarm.wav';
const sound = readFileSync(resolve(process.cwd(), 'ios/App/App', soundName));
const nativePlugin = readFileSync(resolve(process.cwd(), 'ios/App/App/AnchorSafetyNotificationPlugin.swift'), 'utf8');
const project = readFileSync(resolve(process.cwd(), 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');

describe('bundled Anchor Watch notification siren', () => {
    it('is a valid 24-second mono linear PCM WAV below Apple’s 30-second limit', () => {
        expect(sound.toString('ascii', 0, 4)).toBe('RIFF');
        expect(sound.readUInt32LE(4)).toBe(sound.length - 8);
        expect(sound.toString('ascii', 8, 16)).toBe('WAVEfmt ');
        expect(sound.readUInt32LE(16)).toBe(16);
        expect(sound.readUInt16LE(20)).toBe(1); // Linear PCM.
        expect(sound.readUInt16LE(22)).toBe(1); // Mono.
        expect(sound.readUInt32LE(24)).toBe(44_100);
        expect(sound.readUInt32LE(28)).toBe(88_200);
        expect(sound.readUInt16LE(32)).toBe(2);
        expect(sound.readUInt16LE(34)).toBe(16);
        expect(sound.toString('ascii', 36, 40)).toBe('data');
        expect(sound.readUInt32LE(40)).toBe(sound.length - 44);
        const seconds = sound.readUInt32LE(40) / sound.readUInt32LE(28);
        expect(seconds).toBe(24);
        expect(seconds).toBeLessThan(30);
    });

    it('has two distinct tones, short fades, silence between cycles, and no clipping', () => {
        const sampleRate = sound.readUInt32LE(24);
        const sample = (frame: number) => sound.readInt16LE(44 + frame * 2);
        const crossingCount = (startSeconds: number, seconds: number) => {
            let positiveCrossings = 0;
            const start = Math.round(startSeconds * sampleRate);
            const end = start + Math.round(seconds * sampleRate);
            for (let frame = start + 1; frame <= end; frame++) {
                if (sample(frame - 1) <= 0 && sample(frame) > 0) positiveCrossings++;
            }
            return positiveCrossings;
        };
        expect(crossingCount(0.05, 0.3)).toBeCloseTo(880 * 0.3, 0);
        expect(crossingCount(0.45, 0.3)).toBeCloseTo(1_320 * 0.3, 0);
        expect(sample(0)).toBe(0);
        expect(Math.abs(sample(1))).toBeLessThan(20);
        expect(sample(Math.round(sampleRate * 0.4) - 1)).toBe(0);
        expect(sample(Math.round(sampleRate * 0.4))).toBe(0);
        let peak = 0;
        for (let frame = 0; frame < sampleRate * 24; frame++) peak = Math.max(peak, Math.abs(sample(frame)));
        expect(peak).toBeGreaterThan(27_000);
        expect(peak).toBeLessThanOrEqual(Math.ceil(32_767 * 0.85));
        for (let cycle = 0; cycle < 16; cycle++) {
            const start = Math.round((cycle * 1.5 + 0.8) * sampleRate);
            const end = Math.round((cycle + 1) * 1.5 * sampleRate);
            expect(sound.subarray(44 + start * 2, 44 + end * 2).some((byte) => byte !== 0)).toBe(false);
        }
    });

    it('exactly matches the deterministic generator without modifying the asset or playing sound', () => {
        const result = execFileSync(process.execPath, ['scripts/generate-anchor-notification-sound.mjs', '--check'], {
            cwd: process.cwd(),
            encoding: 'utf8',
        });
        expect(result).toContain('notification sound verified: 24 s');
    });

    it('is explicitly copied into the app bundle and used by ordinary local alarm notifications', () => {
        expect(project).toContain(
            'AA000030AAAA003000000001 /* thalassa-anchor-alarm.wav in Resources */ = {isa = PBXBuildFile; fileRef = AA000030AAAA003000000002',
        );
        const resources = project.slice(
            project.indexOf('/* Begin PBXResourcesBuildPhase section */'),
            project.indexOf('/* End PBXResourcesBuildPhase section */'),
        );
        expect(resources).toContain('AA000030AAAA003000000001 /* thalassa-anchor-alarm.wav in Resources */,');
        expect(project).toContain('lastKnownFileType = audio.wav; path = "thalassa-anchor-alarm.wav";');
        expect(nativePlugin).toContain(`private static let alarmSoundName = "${soundName}"`);
        expect(nativePlugin).toContain('Bundle.main.url(forResource: Self.alarmSoundName, withExtension: nil)');
        expect(nativePlugin).toContain('ANCHOR_NOTIFICATION_SOUND_MISSING');
        expect(nativePlugin).toContain(
            'content.sound = UNNotificationSound(named: UNNotificationSoundName(Self.alarmSoundName))',
        );
        expect(nativePlugin).toContain('content.interruptionLevel = .timeSensitive');
        expect(nativePlugin).not.toContain('content.interruptionLevel = .critical');
        expect(nativePlugin).not.toContain('defaultCritical');
        expect(nativePlugin).toContain('Silent mode, volume and Focus settings still');
    });
});
