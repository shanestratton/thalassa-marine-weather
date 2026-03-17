/**
 * AisHubService unit tests — validates deduplication, rate limiting,
 * config persistence, and forwarding behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
});

// Mock Capacitor as web platform (no native TCP)
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false },
}));

import { AisHubService } from '../services/AisHubService';

beforeEach(() => {
    // Clear localStorage
    Object.keys(store).forEach(k => delete store[k]);
    // Reset service state
    AisHubService.destroy();
});

describe('AisHubService config', () => {
    it('should persist enabled state to localStorage', () => {
        AisHubService.configure('1.2.3.4', 5678);
        AisHubService.setEnabled(true);
        expect(localStorage.getItem('aishub_enabled')).toBe('true');
        expect(localStorage.getItem('aishub_ip')).toBe('1.2.3.4');
        expect(localStorage.getItem('aishub_port')).toBe('5678');
    });

    it('should return config correctly', () => {
        AisHubService.configure('1.2.3.4', 5678);
        AisHubService.setEnabled(true);
        const config = AisHubService.getConfig();
        expect(config.enabled).toBe(true);
        expect(config.ip).toBe('1.2.3.4');
        expect(config.port).toBe(5678);
    });

    it('should default to disabled', () => {
        AisHubService.init();
        expect(AisHubService.getConfig().enabled).toBe(false);
    });
});

describe('AisHubService forwarding', () => {
    beforeEach(() => {
        AisHubService.configure('1.2.3.4', 5678);
        AisHubService.setEnabled(true);
    });

    it('should count forwarded sentences (web mode)', () => {
        AisHubService.forward('!AIVDM,1,1,,B,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*75');
        const stats = AisHubService.getStats();
        expect(stats.sentenceCount).toBe(1);
        expect(stats.bytesSent).toBeGreaterThan(0);
    });

    it('should deduplicate same sentence within 3s window', () => {
        const sentence = '!AIVDM,1,1,,B,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*75';
        AisHubService.forward(sentence);
        AisHubService.forward(sentence); // Duplicate — should be skipped
        expect(AisHubService.getStats().sentenceCount).toBe(1);
    });

    it('should deduplicate same sentence on different channels (different checksum)', () => {
        // Same payload, different channel = different checksum
        AisHubService.forward('!AIVDM,1,1,,B,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*75');
        AisHubService.forward('!AIVDM,1,1,,A,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*74');
        // Both have same content before *, so dedup catches it
        expect(AisHubService.getStats().sentenceCount).toBe(1);
    });

    it('should allow different sentences', () => {
        AisHubService.forward('!AIVDM,1,1,,B,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*75');
        AisHubService.forward('!AIVDM,1,1,,B,13u@Dt002s000000000000000000,0*40');
        expect(AisHubService.getStats().sentenceCount).toBe(2);
    });

    it('should not forward when disabled', () => {
        AisHubService.setEnabled(false);
        AisHubService.forward('!AIVDM,1,1,,B,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*75');
        expect(AisHubService.getStats().sentenceCount).toBe(0);
    });

    it('should not forward without IP configured', () => {
        AisHubService.configure('', 0);
        AisHubService.forward('!AIVDM,1,1,,B,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*75');
        expect(AisHubService.getStats().sentenceCount).toBe(0);
    });
});

describe('AisHubService subscribe', () => {
    it('should notify subscribers on stats update', () => {
        AisHubService.configure('1.2.3.4', 5678);
        AisHubService.setEnabled(true);

        let notified = false;
        const unsub = AisHubService.subscribe(() => { notified = true; });

        // Forward 10 sentences to trigger notification (every 10th)
        for (let i = 0; i < 10; i++) {
            AisHubService.forward(`!AIVDM,1,1,,B,${i}5MwkT1P05Fo;H\`EKP8a8:R\`0@Fv,0*7${i}`);
        }

        expect(notified).toBe(true);
        unsub();
    });
});
