import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { packClassNames } from '../scripts/share-class-names.mjs';
import { readPackedUiData } from '../utils/readPackedUiData';

const values = [' a  b\tc ', 'text-["☀️"] \\ escaped', '', ' '.repeat(3)];
function fixture() {
    const packed = packClassNames(values);
    const tuple = [packed.encoded, packed.bytes, packed.count, packed.checksum];
    const id = 'thalassa-ui-' + createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
    const node = document.createElement('script');
    node.id = id;
    node.type = 'application/json';
    node.textContent = JSON.stringify(tuple);
    document.body.append(node);
    return {
        node,
        tuple,
        read: () => readPackedUiData(id, packed.encoded.length, packed.bytes, packed.count, packed.checksum),
    };
}
afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

it('synchronously restores exact frozen values and consumes the inert node without fetch or an encoded cache', () => {
    const f = fixture(),
        fetch = vi.spyOn(globalThis, 'fetch');
    const restored = f.read();
    expect(restored).toEqual(values);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(f.node.isConnected).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(() => f.read()).toThrow('Bundled display data unavailable');
});

it.each([
    'missing',
    'duplicate',
    'stale-id',
    'wrong-type',
    'external-src',
    'bad-json',
    'wrong-primitive',
    'wrong-metadata',
    'wrong-count',
    'wrong-checksum',
    'bad-header',
    'oversized',
])('fails closed on %s with one fixed independent startup alert', (kind) => {
    const f = fixture();
    switch (kind) {
        case 'missing':
            f.node.remove();
            break;
        case 'duplicate':
            document.body.append(f.node.cloneNode(true));
            break;
        case 'stale-id':
            f.node.id += '0';
            break;
        case 'wrong-type':
            f.node.type = 'text/plain';
            break;
        case 'external-src':
            f.node.src = '/must-not-fetch.json';
            break;
        case 'bad-json':
            f.node.textContent = '{';
            break;
        case 'wrong-primitive':
            f.tuple[1] = String(f.tuple[1]);
            f.node.textContent = JSON.stringify(f.tuple);
            break;
        case 'wrong-metadata':
            f.tuple[1] = Number(f.tuple[1]) + 1;
            f.node.textContent = JSON.stringify(f.tuple);
            break;
        case 'wrong-count':
            f.tuple[2] = Number(f.tuple[2]) + 1;
            f.node.textContent = JSON.stringify(f.tuple);
            break;
        case 'wrong-checksum':
            f.tuple[3] = Number(f.tuple[3]) + 1;
            f.node.textContent = JSON.stringify(f.tuple);
            break;
        case 'bad-header': {
            const encoded = Buffer.from(String(f.tuple[0]), 'base64');
            encoded[0] = 0;
            f.tuple[0] = encoded.toString('base64');
            f.node.textContent = JSON.stringify(f.tuple);
            break;
        }
        case 'oversized':
            f.node.textContent = ' '.repeat(64065);
    }
    expect(() => f.read()).toThrow('Bundled display data unavailable');
    const panel = document.querySelector('[role=alert]')!;
    expect(panel.textContent).toBe('Thalassa could not load its bundled display data. Reload the app.Reload');
    expect(panel.querySelector('button')?.style.minHeight).toBe('44px');
    expect(() => f.read()).toThrow('Bundled display data unavailable');
    expect(document.querySelectorAll('[role=alert]')).toHaveLength(1);
});

it('rejects oversized raw text before JSON parsing and does not erase an already-mounted app', () => {
    const app = document.createElement('main');
    app.textContent = 'Already mounted';
    document.body.append(app);
    const f = fixture();
    f.node.textContent = ' '.repeat(64065);
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => f.read()).toThrow('Bundled display data unavailable');
    expect(parse).not.toHaveBeenCalled();
    expect(app.textContent).toBe('Already mounted');
});

it.each([
    ['', 8, 1, 1, 1],
    ['thalassa-ui-' + 'a'.repeat(64), 64001, 1, 1, 1],
    ['thalassa-ui-' + 'a'.repeat(64), 8, 128001, 1, 1],
    ['thalassa-ui-' + 'a'.repeat(64), 8, 1, 4097, 1],
    ['thalassa-ui-' + 'a'.repeat(64), 8, 1, 1, -1],
])('rejects invalid compiled expectations before looking up data: %s', (id, length, bytes, count, checksum) => {
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => readPackedUiData(String(id), Number(length), Number(bytes), Number(count), Number(checksum))).toThrow(
        'Bundled display data unavailable',
    );
    expect(parse).not.toHaveBeenCalled();
});
