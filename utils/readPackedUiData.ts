/** Build-owned inert display tuples only. No fetch, globals, eval or app imports. */
import { decodeClassNames } from './decodeClassNames';

const FAILURE = 'Thalassa could not load its bundled display data. Reload the app.';
function startupFailure(): never {
    if (typeof document !== 'undefined' && document.body && !document.getElementById('thalassa-display-data-error')) {
        const panel = document.createElement('section');
        panel.id = 'thalassa-display-data-error';
        panel.setAttribute('role', 'alert');
        // Independent of React and the unavailable class/UI table; do not
        // tear down an already-running app if a later lazy table fails.
        panel.style.cssText =
            'position:fixed;inset:16px 16px auto;z-index:2147483647;padding:16px;background:#0f172a;color:white;font:16px sans-serif';
        const message = document.createElement('p');
        message.textContent = FAILURE;
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.textContent = 'Reload';
        reload.style.cssText = 'min-height:44px;min-width:88px;font:inherit';
        reload.addEventListener('click', () => window.location.reload(), { once: true });
        panel.append(message, reload);
        document.body.append(panel);
    }
    throw Error('Bundled display data unavailable');
}

/** All expectations are compiled from the exact tuple, independently of HTML.
 * The existing bounded decoder, output freeze and checksum rules are unchanged. */
export function readPackedUiData(
    id: string,
    encodedLength: number,
    bytes: number,
    count: number,
    checksum: number,
): readonly string[] {
    try {
        if (
            typeof document === 'undefined' ||
            !/^thalassa-ui-[0-9a-f]{64}$/.test(id) ||
            !Number.isSafeInteger(encodedLength) ||
            encodedLength < 8 ||
            encodedLength > 64000 ||
            !Number.isSafeInteger(bytes) ||
            bytes < 1 ||
            bytes > 128000 ||
            !Number.isSafeInteger(count) ||
            count < 0 ||
            count > 4096 ||
            !Number.isSafeInteger(checksum) ||
            checksum < 0 ||
            checksum > 0xffffffff
        )
            return startupFailure();
        const nodes = document.querySelectorAll(`[id="${id}"]`);
        const node = nodes[0];
        if (
            nodes.length !== 1 ||
            node.tagName !== 'SCRIPT' ||
            node.getAttribute('type') !== 'application/json' ||
            node.hasAttribute('src')
        )
            return startupFailure();
        const text = node.textContent ?? '';
        if (text.length < 1 || text.length > encodedLength + 64) return startupFailure();
        const value: unknown = JSON.parse(text);
        if (
            !Array.isArray(value) ||
            value.length !== 4 ||
            typeof value[0] !== 'string' ||
            value[0].length !== encodedLength ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(value[0]) ||
            value[1] !== bytes ||
            value[2] !== count ||
            value[3] !== checksum
        )
            return startupFailure();
        // Consumption is synchronous and module initialization occurs once.
        // Do not retain a second global encoded-data cache after decoding.
        node.remove();
        return decodeClassNames(value[0], bytes, count, checksum);
    } catch {
        return startupFailure();
    }
}
