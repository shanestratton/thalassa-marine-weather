// @vitest-environment node
/**
 * The Files app no longer lists "On My iPhone › Thalassa" (127-C-c decision
 * 10). UIFileSharingEnabled and LSSupportsOpeningDocumentsInPlace came in with
 * the S-63 fingerprint export (5753183a), which 127 retired; with them on, the
 * whole Documents folder — where older builds kept every chart cell — was
 * browsable and copyable.
 *
 * This test asserts booleans only and never prints the file: Info.plist holds
 * a licence key.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Info.plist does not share Documents with the Files app', () => {
    const plist = readFileSync('ios/App/App/Info.plist', 'utf8');

    it('has neither file-sharing key', () => {
        expect(plist.includes('<key>UIFileSharingEnabled</key>')).toBe(false);
        expect(plist.includes('<key>LSSupportsOpeningDocumentsInPlace</key>')).toBe(false);
    });

    it('is still one well-formed plist dictionary', () => {
        expect(plist.trimStart().startsWith('<?xml')).toBe(true);
        expect((plist.match(/<plist /g) ?? []).length).toBe(1);
        expect(plist.trimEnd().endsWith('</plist>')).toBe(true);
        expect((plist.match(/<key>/g) ?? []).length).toBeGreaterThan(10);
    });
});
