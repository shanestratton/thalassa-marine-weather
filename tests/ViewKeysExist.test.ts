/**
 * Every setPage('…') literal must name a view that actually exists.
 *
 * setPage() accepts any string and App.tsx quietly renders unregistered
 * views as the dashboard's search-bar chrome over an empty body — which is
 * how Cast Off's setPage('log') (the Log tab's real key is 'details') sent
 * Shane to a blank screen on 2026-08-26 instead of the Log page. The bad
 * key hid for a day because the old flow rarely reached the navigation.
 *
 * The registry is parsed textually rather than imported: importing
 * viewRegistry drags the entire lazy page graph into this test for no
 * added safety.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd());

function readRegistryKeys(): Set<string> {
    const source = readFileSync(join(root, 'viewRegistry.tsx'), 'utf8');
    const body = source.slice(source.indexOf('export const VIEW_REGISTRY'));
    const keys = new Set<string>();
    for (const match of body.matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*): \{/gm)) {
        keys.add(match[1]);
    }
    return keys;
}

function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            yield* walk(path);
        } else if (/\.(ts|tsx)$/.test(name)) {
            yield path;
        }
    }
}

describe('view keys', () => {
    it('parses the registry (sanity pins so a refactor cannot hollow this test out)', () => {
        const keys = readRegistryKeys();
        expect(keys.has('details')).toBe(true);
        expect(keys.size).toBeGreaterThan(10);
    });

    it("every setPage('…') literal names a registered view", () => {
        const valid = readRegistryKeys();
        // dashboard and map render outside the registry (App.tsx hosts them
        // directly); they are legitimate navigation targets all the same.
        valid.add('dashboard');
        valid.add('map');

        const offenders: string[] = [];
        for (const dir of ['components', 'pages', 'hooks']) {
            for (const path of walk(join(root, dir))) {
                const source = readFileSync(path, 'utf8');
                for (const match of source.matchAll(/set[Pp]age\('([a-z_][A-Za-z0-9_]*)'\)/g)) {
                    if (!valid.has(match[1])) {
                        offenders.push(`${path.slice(root.length + 1)} → setPage('${match[1]}')`);
                    }
                }
            }
        }
        const appSource = readFileSync(join(root, 'App.tsx'), 'utf8');
        for (const match of appSource.matchAll(/set[Pp]age\('([a-z_][A-Za-z0-9_]*)'\)/g)) {
            if (!valid.has(match[1])) offenders.push(`App.tsx → setPage('${match[1]}')`);
        }

        expect(offenders).toEqual([]);
    });
});
