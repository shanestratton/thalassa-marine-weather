/** Build-owned local Vite paths only. No network, app imports or general codec. */
export function readPreloadData(
    key: string | readonly string[] | undefined,
    length?: number,
    count?: number,
    checksum?: number,
): readonly string[] | undefined {
    const fail = (): never => {
        if (
            typeof document !== 'undefined' &&
            document.body &&
            !document.getElementById('thalassa-display-data-error')
        ) {
            const panel = document.createElement('section');
            panel.id = 'thalassa-display-data-error';
            panel.setAttribute('role', 'alert');
            panel.style.cssText =
                'position:fixed;inset:16px 16px auto;z-index:2147483647;padding:16px;background:#0f172a;color:white;font:16px sans-serif';
            const message = document.createElement('p');
            message.textContent = 'Thalassa could not load its bundled display data. Reload the app.';
            const reload = document.createElement('button');
            reload.type = 'button';
            reload.textContent = 'Reload';
            reload.style.cssText = 'min-height:44px;min-width:88px;font:inherit';
            reload.addEventListener('click', () => window.location.reload(), { once: true });
            panel.append(message, reload);
            document.body.append(panel);
        }
        throw Error('Bundled preload data unavailable. Reload the app.');
    };
    // The source transform retains this normal bundler dependency while Vite
    // materialises its preload calls. Their already-resolved arrays stay exact.
    // Rollup can fold a lazy import into its current chunk; Vite then supplies
    // `void 0` for the legitimately absent list, which must stay absent.
    if (typeof key !== 'string')
        return (key === undefined || Array.isArray(key)) &&
            length === undefined &&
            count === undefined &&
            checksum === undefined
            ? key
            : fail();
    if (
        typeof document === 'undefined' ||
        !/^thalassa-preload-[0-9a-f]{64}$/.test(key) ||
        !Number.isSafeInteger(length) ||
        length! < 2 ||
        length! > 32768 ||
        !Number.isSafeInteger(count) ||
        count! < 1 ||
        count! > 1024 ||
        !Number.isSafeInteger(checksum) ||
        checksum! < 0 ||
        checksum! > 0xffffffff
    )
        return fail();
    const nodes = document.querySelectorAll(`[id="${key}"]`),
        node = nodes[0];
    if (
        nodes.length !== 1 ||
        node.tagName !== 'SCRIPT' ||
        node.getAttribute('type') !== 'application/json' ||
        node.hasAttribute('src')
    )
        return fail();
    const text = node.textContent ?? '';
    if (text.length !== length) return fail();
    let a = 1,
        b = 0;
    for (let i = 0; i < text.length; i++) {
        a = (a + text.charCodeAt(i)) % 65521;
        b = (b + a) % 65521;
    }
    if (((b << 16) | a) >>> 0 !== checksum) return fail();
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return fail();
    }
    if (
        !Array.isArray(value) ||
        value.length !== count ||
        value.some(
            (path) =>
                typeof path !== 'string' ||
                path.length > 160 ||
                !/^assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(path) ||
                path.includes('..'),
        )
    )
        return fail();
    node.remove();
    return Object.freeze(value);
}
