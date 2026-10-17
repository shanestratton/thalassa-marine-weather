import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const swift = readFileSync('ios/App/App/GribDocumentPlugin.swift', 'utf8');
function between(start: string, end: string): string {
    const from = swift.indexOf(start);
    const to = swift.indexOf(end, from + start.length);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    return swift.slice(from, to);
}

// These are native source contracts, not an iOS compiler or file-provider test.
// In particular, the first case rejects the original string round-trip that
// discarded the security scope carried by UIDocumentPicker's URL object.
describe('142 native chart picker security-scope source contract', () => {
    it('passes the original picker URL to the copy helper and uses its string only for validation', () => {
        const delegate = between('public func documentPicker(', 'public func documentPickerWasCancelled(');
        expect(delegate).toMatch(/copyDocument\(call,\s*gpx:\s*false,\s*chart:\s*true,\s*sourceURL:\s*url\)/);
        expect(delegate).not.toContain('absoluteString');
        const input = between('private func copyDocument(', 'Self.queue.async {');
        expect(input).toMatch(/sourceURL:\s*URL\?\s*=\s*nil/);
        expect(input).toMatch(/let raw\s*=\s*sourceURL\?\.absoluteString\s*\?\?\s*call\.getString\("url"\)/);
        expect(input).toMatch(/let source\s*=\s*sourceURL\s*\?\?\s*URL\(string:\s*raw\)/);
        // The original Open-in string fallback still receives the same guards.
        for (const guard of [
            'raw.utf8.count <= 8192',
            'source.isFileURL',
            'source.user == nil',
            'source.password == nil',
            'source.query == nil',
            'source.fragment == nil',
            'source.host == nil || source.host == "" || source.host == "localhost"',
            'extensions.contains(source.pathExtension.lowercased())',
        ])
            expect(input).toContain(guard);
    });

    it('balances that chosen source scope around serial coordinated reads on every exit', () => {
        const copy = between('Self.queue.async {', 'private enum ImportFailure:');
        expect(copy.match(/source\.startAccessingSecurityScopedResource\(\)/g)).toHaveLength(1);
        expect(copy.match(/source\.stopAccessingSecurityScopedResource\(\)/g)).toHaveLength(1);
        expect(copy).toMatch(/let scoped = source\.startAccessingSecurityScopedResource\(\)/);
        expect(copy).toMatch(/defer\s*\{\s*if scoped\s*\{\s*source\.stopAccessingSecurityScopedResource\(\)\s*\}\s*\}/);
        expect(copy.indexOf('defer { if scoped')).toBeLessThan(copy.indexOf('NSFileCoordinator()'));
        expect(copy).toContain('coordinate(readingItemAt: source');
        expect(copy).toContain('FileHandle(forReadingFrom: readable)');
        expect(copy).toContain('read(upToCount: 65536)');
        expect(copy).toContain('guard copied == size');
        expect(copy).toContain('outcome = ["path": "\\(rootName)/\\(namespace)/\\(filename)", "size": copied]');
        expect(copy).not.toMatch(/outcome.*(?:sourceURL|absoluteString|bookmarkData)/);
    });

    it('holds an incomplete chart quota scan before creating a destination and includes hidden entries', () => {
        const quota = between('var total = 0, count = 0, visited = 0', 'let folder = root.appendingPathComponent');
        expect(quota).toContain('var enumerationFailure: Error?');
        expect(quota).toMatch(/options:\s*chart\s*\?\s*\[\]\s*:\s*\[\.skipsHiddenFiles\]/);
        expect(quota).toMatch(/errorHandler:\s*\{\s*_, error in/);
        expect(quota).toMatch(
            /if chart\s*\{\s*if enumerationFailure == nil\s*\{\s*enumerationFailure = error\s*\}\s*return false\s*\}\s*return true/,
        );
        // A nil enumerator is unavailable, never an empty measured directory.
        expect(quota).toMatch(/\}\) else\s*\{\s*throw ImportFailure\.invalid\s*\}/);
        expect(quota).toMatch(
            /if chart, let enumerationFailure = enumerationFailure\s*\{\s*throw enumerationFailure\s*\}/,
        );
        expect(quota).toContain('guard visited <= 128');
        expect(quota).toContain('metadataSize >= 0');
        expect(quota).toContain('metadataSize <= 16 * 1024');
        expect(quota).toContain('retainedSize <= 64 * 1024 * 1024 - total');
        expect(quota).toContain('total + size <= (gpx ? 16 : 64) * 1024 * 1024');
        expect(quota).toContain('chart && ProcessInfo.processInfo.systemUptime >= chartDeadline');
    });
});
