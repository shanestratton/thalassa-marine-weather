import { describe, expect, it } from 'vitest';
import { isSafeOchartsEncryptedSegment, validateOchartsTokenUrl } from '../services/AvNavService';

describe('AvNav o-charts script trust boundary', () => {
    it('accepts only token modules on the explicitly trusted private boat host', () => {
        expect(
            validateOchartsTokenUrl('http://calypso.local:8083/tokens/tokenHandler.js', ['calypso.local'])?.hostname,
        ).toBe('calypso.local');
        expect(validateOchartsTokenUrl('http://192.168.50.7:8083/tokens/provider.js', ['192.168.50.7'])).not.toBeNull();

        expect(validateOchartsTokenUrl('https://evil.example/tokens/provider.js', ['calypso.local'])).toBeNull();
        expect(validateOchartsTokenUrl('http://calypso.local:8083/other/provider.js', ['calypso.local'])).toBeNull();
        expect(
            validateOchartsTokenUrl('http://calypso.local:8083/tokens/%2e%2e/provider.js', ['calypso.local']),
        ).toBeNull();
        expect(
            validateOchartsTokenUrl('http://user:secret@calypso.local:8083/tokens/provider.js', ['calypso.local']),
        ).toBeNull();
        expect(validateOchartsTokenUrl('http://8.8.8.8/tokens/provider.js', ['8.8.8.8'])).toBeNull();
    });

    it('accepts only the documented same-origin encrypted path grammar', () => {
        const valid = `encrypted/${'a'.repeat(32)}/12/${'b'.repeat(32)}/${'c'.repeat(64)}`;
        expect(isSafeOchartsEncryptedSegment(valid)).toBe(true);
        expect(isSafeOchartsEncryptedSegment('https://evil.example/tile')).toBe(false);
        expect(isSafeOchartsEncryptedSegment('encrypted/session/1/iv/../../secret')).toBe(false);
        expect(isSafeOchartsEncryptedSegment(`encrypted/session/1/${'a'.repeat(32)}/${'g'.repeat(32)}`)).toBe(false);
    });

    it('contains no downloaded-code eval path', async () => {
        const [{ readFile }, { resolve }] = await Promise.all([import('node:fs/promises'), import('node:path')]);
        const source = await readFile(resolve(process.cwd(), 'services/AvNavService.ts'), 'utf8');
        expect(source).not.toMatch(/\(\s*0\s*,\s*eval\s*\)/);
        expect(source).toContain('disableRedirects: true');
        expect(source).toContain('scriptBytes > 512_000');
    });
});
