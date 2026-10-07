/**
 * Which of this phone's receivers produced a fix (build 123 review): asked
 * per fix, because a Bad Elf / MFi accessory can die mid-passage and hand
 * Core Location back to the phone's own chip. An accessory is claimed only
 * when iOS confirms it produced a location close in time to that fix.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CachedPosition } from '../services/BgGeoManager';
import { createPhoneFixClassifier, type ReceiverSample } from '../services/shiplog/phoneFixClassifier';

const fixAt = (timestamp: number): CachedPosition => ({
    // The Solent, under way.
    latitude: 50.7712,
    longitude: -1.3005,
    accuracy: 4,
    altitude: null,
    heading: 90,
    speed: 3,
    timestamp,
    receivedAt: timestamp,
});

const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('per-fix phone receiver tag', () => {
    it("a live Bad Elf tags its fixes phone-accessory; when its battery dies the chip's fixes are tagged phone", async () => {
        let now = 1_000_000;
        let sample: ReceiverSample = { externalAccessory: true, timestampMs: now };
        const read = vi.fn(async () => sample);
        const classifier = createPhoneFixClassifier(read, () => now);

        // The first fix asks iOS; the answer serves the fixes after it.
        expect(classifier.classify(fixAt(now), true)).toBe('phone');
        await flush();
        now += 2_000;
        expect(classifier.classify(fixAt(now), true)).toBe('phone-accessory');

        // The Bad Elf's battery dies: Core Location falls back to the chip.
        now += 20_000;
        sample = { externalAccessory: false, timestampMs: now };
        classifier.classify(fixAt(now), true); // past the refresh: asks again
        await flush();
        now += 1_000;
        expect(classifier.classify(fixAt(now), true)).toBe('phone');
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('an accessory answer about a location long before this fix (a Bad Elf unplugged before Start) does not vouch for it', async () => {
        let now = 2_000_000;
        // iOS last heard the accessory four minutes ago.
        const read = vi.fn(async () => ({ externalAccessory: true, timestampMs: now - 4 * 60_000 }));
        const classifier = createPhoneFixClassifier(read, () => now);
        classifier.classify(fixAt(now), true);
        await flush();
        now += 1_000;
        expect(classifier.classify(fixAt(now), true)).toBe('phone');
    });

    it('reads iOS at most every 15 s, not once per fix', async () => {
        let now = 3_000_000;
        const read = vi.fn(async () => ({ externalAccessory: true, timestampMs: now }));
        const classifier = createPhoneFixClassifier(read, () => now);
        for (let i = 0; i < 10; i += 1) {
            classifier.classify(fixAt(now), true);
            await flush();
            now += 1_000;
        }
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a failed read, or the web, is the phone', async () => {
        const now = 4_000_000;
        const classifier = createPhoneFixClassifier(
            vi.fn(async () => {
                throw new Error('bridge unavailable');
            }),
            () => now,
        );
        classifier.classify(fixAt(now), true);
        await flush();
        expect(classifier.classify(fixAt(now), true)).toBe('phone');
        expect(createPhoneFixClassifier(vi.fn(), () => now).classify(fixAt(now), false)).toBe('phone');
    });
});
