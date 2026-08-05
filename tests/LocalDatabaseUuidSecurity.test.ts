import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateUUID } from '../services/vessel/LocalDatabase';

describe('LocalDatabase secure UUID generation', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uses the platform randomUUID implementation when available', () => {
        const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
        vi.stubGlobal('crypto', { randomUUID });

        expect(generateUUID()).toBe('11111111-2222-4333-8444-555555555555');
        expect(randomUUID).toHaveBeenCalledOnce();
    });

    it('builds an RFC 4122 version 4 UUID from cryptographically secure bytes', () => {
        const getRandomValues = vi.fn((bytes: Uint8Array) => {
            bytes.set([0, 1, 2, 3, 4, 5, 255, 7, 255, 9, 10, 11, 12, 13, 14, 15]);
            return bytes;
        });
        vi.stubGlobal('crypto', { getRandomValues });

        expect(generateUUID()).toBe('00010203-0405-4f07-bf09-0a0b0c0d0e0f');
        expect(getRandomValues).toHaveBeenCalledOnce();
    });

    it('fails closed when the runtime has no secure random source', () => {
        vi.stubGlobal('crypto', undefined);

        expect(() => generateUUID()).toThrow('Secure random UUID generation is unavailable on this device.');
    });
});
