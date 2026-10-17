import { afterEach, describe, expect, it } from 'vitest';
import { parseAst } from 'rollup/parseAst';
import { readPreloadData } from '../utils/readPreloadData';
import { preloadChecksum, preloadRecord, rewritePreloadHelper } from '../scripts/inert-preload-data.mjs';

afterEach(() => {
    document.body.replaceChildren();
});
const paths = ['assets/lazy-a-hash.js', 'assets/lazy-a-hash.css'];
function insert(record: ReturnType<typeof preloadRecord>, text = record.text) {
    const element = document.createElement('script');
    element.type = 'application/json';
    element.id = record.id;
    element.textContent = text;
    document.body.append(element);
    return element;
}
const read = (record: ReturnType<typeof preloadRecord>) =>
    readPreloadData(record.id, record.text.length, record.count, record.checksum);
describe('lazy local preload data', () => {
    it('reads only the requested local array, keeps JS/CSS order and removes only its record', () => {
        const a = preloadRecord('assets/a-hash.js', paths),
            b = preloadRecord('assets/b-hash.js', paths);
        const own = insert(a),
            other = insert(b);
        const value = read(a);
        expect(value).toEqual(paths);
        expect(Object.isFrozen(value)).toBe(true);
        expect(own.isConnected).toBe(false);
        expect(other.isConnected).toBe(true);
        expect(readPreloadData(value)).toBe(value);
    });
    it('keeps one chunk key unchanged when another local array changes', () => {
        const before = preloadRecord('assets/a-hash.js', paths);
        preloadRecord('assets/b-hash.js', ['assets/new-hash.js']);
        expect(preloadRecord('assets/a-hash.js', paths)).toEqual(before);
    });
    it.each([
        'missing',
        'duplicate',
        'src',
        'wrong tag',
        'wrong type',
        'changed text',
        'wrong count',
        'wrong checksum',
    ])('refuses %s before returning paths', (mode) => {
        const record = preloadRecord('assets/a-hash.js', paths),
            element = insert(record);
        if (mode === 'missing') element.remove();
        if (mode === 'duplicate') insert(record);
        if (mode === 'src') element.setAttribute('src', '/remote.json');
        if (mode === 'wrong tag') {
            const div = document.createElement('div');
            div.id = element.id;
            div.textContent = element.textContent;
            element.replaceWith(div);
        }
        if (mode === 'wrong type') element.type = 'text/plain';
        if (mode === 'changed text') element.textContent = record.text.replace('lazy-a', 'lazy-b');
        if (mode === 'wrong count') record.count++;
        if (mode === 'wrong checksum') record.checksum++;
        expect(() => read(record)).toThrow('Bundled preload data unavailable');
    });
    it.each([['https://example.test/a.js'], ['assets/../a.js'], ['assets/a.js', 3], ['assets/a.js?x=1']])(
        'refuses malformed or non-local paths even with matching text checksum',
        (...bad) => {
            const record = preloadRecord('assets/a-hash.js', paths);
            record.text = JSON.stringify(bad);
            record.count = bad.length;
            record.checksum = preloadChecksum(record.text);
            insert(record);
            expect(() => read(record)).toThrow('Bundled preload data unavailable');
        },
    );
    it.each([
        [1, 2, 0],
        [32769, 2, 0],
        [10, 1025, 0],
        [10, 2, -1],
        [10, 2, 0x100000000],
    ])('keeps reviewed length/count/checksum bounds', (length, count, checksum) => {
        expect(() => readPreloadData(`thalassa-preload-${'a'.repeat(64)}`, length, count, checksum)).toThrow();
    });
});

describe('proven Vite helper grammar', () => {
    const prefix = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=${JSON.stringify(paths)})))=>i.map(i=>d[i]);\n`;
    const tail = 'import{r as p}from"./preload-data-hash.js";p(__vite__mapDeps([0,1]));';
    it('preserves the complete body and all indices; replaces only an unmapped first line', () => {
        const result = rewritePreloadHelper(prefix + tail, 'assets/a-hash.js', parseAst, { mappings: ';AAAA' })!;
        expect(result.code.slice(result.code.indexOf('\n') + 1)).toBe(tail);
        expect(result.record.text).toBe(JSON.stringify(paths));
        expect(result.calls).toBe(1);
    });
    it.each([
        prefix.replace('i.map(i=>d[i])', 'i.map(i=>d[i]||"fallback")') + tail,
        prefix + '__vite__mapDeps([0,1]);',
        prefix + tail.replace('[0,1]', '[0,2]'),
        prefix + tail.replace('[0,1]', '[0,,1]'),
        prefix + tail + 'globalThis.exposed=__vite__mapDeps;',
    ])('refuses unfamiliar grammar/indices/escaped helpers', (code) => {
        expect(() => rewritePreloadHelper(code, 'assets/a-hash.js', parseAst)).toThrow();
    });
    it('refuses mapped prefixes and router/worker helper paths', () => {
        expect(() => rewritePreloadHelper(prefix + tail, 'assets/a-hash.js', parseAst, { mappings: 'AAAA' })).toThrow(
            'mapped',
        );
        expect(() => rewritePreloadHelper(prefix + tail, 'assets/router-engine-hash.js', parseAst)).toThrow(
            'worker/router',
        );
    });
});
