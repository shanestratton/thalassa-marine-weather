#!/usr/bin/env node
/**
 * Generate the first-party Anchor/Shore Watch notification sound.
 *
 * Apple requires bundled notification sounds to last less than 30 seconds.
 * This 24-second linear PCM WAV repeats the foreground alarm's two-tone
 * pattern 16 times. It is an ordinary notification sound: iOS sound settings
 * still apply, and this file cannot provide an indefinitely sounding alarm.
 * No playback occurs here. Run with --check to verify the committed resource.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const outputUrl = new URL('../ios/App/App/thalassa-anchor-alarm.wav', import.meta.url);

export function createAnchorNotificationWave() {
    const sampleRate = 44_100;
    const channels = 1;
    const bitsPerSample = 16;
    const loopFrames = sampleRate * 1.5;
    const toneFrames = sampleRate * 0.4;
    const fadeFrames = Math.floor(sampleRate * 0.006);
    const frames = sampleRate * 24;
    const bytesPerFrame = channels * (bitsPerSample / 8);
    const dataBytes = frames * bytesPerFrame;
    const wave = Buffer.alloc(44 + dataBytes);

    wave.write('RIFF', 0);
    wave.writeUInt32LE(36 + dataBytes, 4);
    wave.write('WAVE', 8);
    wave.write('fmt ', 12);
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20); // Linear PCM, not compressed audio.
    wave.writeUInt16LE(channels, 22);
    wave.writeUInt32LE(sampleRate, 24);
    wave.writeUInt32LE(sampleRate * bytesPerFrame, 28);
    wave.writeUInt16LE(bytesPerFrame, 32);
    wave.writeUInt16LE(bitsPerSample, 34);
    wave.write('data', 36);
    wave.writeUInt32LE(dataBytes, 40);

    for (let frame = 0; frame < frames; frame++) {
        const loopFrame = frame % loopFrames;
        if (loopFrame >= toneFrames * 2) continue; // 0.7-second pause.
        const toneFrame = loopFrame % toneFrames;
        const frequency = loopFrame < toneFrames ? 880 : 1_320;
        const envelope = Math.max(0, Math.min(1, toneFrame / fadeFrames, (toneFrames - 1 - toneFrame) / fadeFrames));
        const amplitude = Math.sin((2 * Math.PI * frequency * toneFrame) / sampleRate) * 0.85 * envelope;
        wave.writeInt16LE(Math.round(amplitude * 32_767), 44 + frame * bytesPerFrame);
    }
    return wave;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const generated = createAnchorNotificationWave();
    if (process.argv.includes('--check')) {
        if (!readFileSync(outputUrl).equals(generated)) {
            throw new Error('Bundled Anchor Watch sound differs from its generator. Regenerate before building.');
        }
        console.log('Anchor Watch notification sound verified: 24 s, mono 44.1 kHz, 16-bit linear PCM.');
    } else {
        writeFileSync(outputUrl, generated);
        console.log(`Generated ${fileURLToPath(outputUrl)} (24 s; no audio played).`);
    }
}
