import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    buildBrowserEnvironment,
    navigateToWarningPage,
    normalizeWarnings,
    persist,
    runScraper,
    validateWriteEnvironment,
} from './scrape.mjs';

const fixture = await readFile(new URL('./fixtures/warnings-page.txt', import.meta.url), 'utf8');
const runTimestamp = '2026-05-15T06:00:00.000Z';
const quietLogger = { log() {} };

test('navigation waits for warning-page semantics instead of network quiescence', async () => {
    const navigationCalls = [];
    let readinessPredicate;
    let readinessArgument;
    let readinessOptions;
    const page = {
        async goto(url, options) {
            navigationCalls.push({ url, options });
        },
        async waitForFunction(predicate, argument, options) {
            readinessPredicate = predicate;
            readinessArgument = argument;
            readinessOptions = options;
        },
    };

    await navigateToWarningPage(page, { timeoutMs: 1_234 });

    assert.deepEqual(navigationCalls, [
        {
            url: 'https://www.maritimenz.govt.nz/navigational-warnings/',
            options: { waitUntil: 'domcontentloaded', timeout: 1_234 },
        },
    ]);
    assert.deepEqual(readinessOptions, { timeout: 1_234 });

    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    try {
        globalThis.window = { location: { href: 'https://www.maritimenz.govt.nz/navigational-warnings/' } };
        globalThis.document = { body: { innerText: 'Just a moment…' } };
        assert.equal(readinessPredicate(readinessArgument), false);

        globalThis.document.body.innerText =
            'Warnings In-Force at: 050100 UTC AUG 2026\nNo warning records are rendered yet.';
        assert.equal(readinessPredicate(readinessArgument), false);

        globalThis.document.body.innerText =
            'Warnings In-Force at: 050100 UTC AUG 2026\nNAVAREA XIV WARNING 211/26\nNNNN';
        assert.equal(readinessPredicate(readinessArgument), true);

        globalThis.window.location.href = 'https://example.com/navigational-warnings/';
        assert.equal(readinessPredicate(readinessArgument), false);
    } finally {
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
    }
});

test('parses a bounded fresh fixture and ignores cancelled sub-references', () => {
    const result = normalizeWarnings(fixture, runTimestamp);

    assert.equal(result.issueDate, '150500Z MAY 2026');
    assert.equal(result.blockCount, 3);
    assert.deepEqual(
        result.warnings.map((warning) => warning.id),
        ['XIV-2026/130', 'NZC-2026/136', 'XIV-2026/131'],
    );
    assert.match(result.warnings[2].text, /CANCEL NAVAREA XIV WARNING 119\/26/);
});

test('fails closed on partial, stale, and duplicate parses', () => {
    const firstTerminator = fixture.indexOf('\nNNNN');
    const partialFixture = fixture.slice(0, firstTerminator + '\nNNNN'.length);
    assert.throws(() => normalizeWarnings(partialFixture, runTimestamp), /minimum safe count/);
    assert.throws(() => normalizeWarnings(fixture, '2026-05-20T06:00:00.000Z'), /timestamp is stale/);
    assert.throws(
        () =>
            normalizeWarnings(
                `${fixture}\nNAVAREA XIV WARNING 130/26\nDUPLICATE COPY MUST FAIL CLOSED.\nNNNN\n`,
                runTimestamp,
            ),
        /duplicate warning IDs/,
    );
});

test('dry-run exercises parsing without reading credentials or calling persistence', async () => {
    let persistCalls = 0;
    let receivedBrowserEnv;
    const result = await runScraper({
        env: {
            DRY_RUN: '1',
            HOME: '/tmp/linz-home',
            PATH: '/usr/bin:/bin',
            SUPABASE_URL: 'https://project.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_must_not_reach_browser',
        },
        now: () => new Date(runTimestamp),
        scrapePage: async ({ browserEnv }) => {
            receivedBrowserEnv = browserEnv;
            return fixture;
        },
        persistWarnings: async () => {
            persistCalls += 1;
            throw new Error('dry-run attempted persistence');
        },
        logger: quietLogger,
    });

    assert.equal(result.dryRun, true);
    assert.equal(persistCalls, 0);
    assert.deepEqual(receivedBrowserEnv, { HOME: '/tmp/linz-home', PATH: '/usr/bin:/bin' });
});

test('live mode validates an exact service-role write boundary before scraping', async () => {
    let scrapeCalls = 0;
    await assert.rejects(
        runScraper({
            env: {},
            scrapePage: async () => {
                scrapeCalls += 1;
                return fixture;
            },
            logger: quietLogger,
        }),
        /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/,
    );
    assert.equal(scrapeCalls, 0);
    assert.throws(
        () =>
            validateWriteEnvironment({
                SUPABASE_URL: 'https://project.supabase.co',
                SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_not_privileged',
            }),
        /service-role credential/,
    );
});

test('browser environment uses a strict allowlist and excludes service credentials', () => {
    assert.deepEqual(
        buildBrowserEnvironment({
            HOME: '/tmp/home',
            PATH: '/usr/bin',
            LANG: 'en_NZ.UTF-8',
            SUPABASE_URL: 'https://project.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_private',
            UNRELATED_TOKEN: 'private',
        }),
        { HOME: '/tmp/home', LANG: 'en_NZ.UTF-8', PATH: '/usr/bin' },
    );
});

test('persistence upserts the verified batch before stale cleanup', async () => {
    const { warnings } = normalizeWarnings(fixture, runTimestamp);
    const events = [];
    const credentials = {
        supabaseUrl: 'https://project.supabase.co',
        serviceKey: 'sb_secret_test_only',
    };
    const createClientFn = (url, key, options) => {
        events.push(['client', url, key, options]);
        return {
            from(table) {
                assert.equal(table, 'linz_warnings');
                return {
                    async select(columns, options) {
                        events.push(['select', columns, options]);
                        return { error: null, count: 5 };
                    },
                    async upsert(rows, options) {
                        events.push(['upsert', rows, options]);
                        return { error: null };
                    },
                    delete(options) {
                        events.push(['delete', options]);
                        return {
                            async lt(column, cutoff) {
                                events.push(['lt', column, cutoff]);
                                return { error: null, count: 2 };
                            },
                        };
                    },
                };
            },
        };
    };

    const result = await persist(warnings, runTimestamp, credentials, createClientFn);

    assert.deepEqual(result, { upserted: 3, deleted: 2 });
    assert.deepEqual(
        events.map(([name]) => name),
        ['client', 'select', 'upsert', 'delete', 'lt'],
    );
    assert.deepEqual(events[1].slice(1), ['id', { count: 'exact', head: true }]);
    assert.deepEqual(events[2][2], { onConflict: 'id', ignoreDuplicates: false });
    assert.deepEqual(events[3][1], { count: 'exact' });
    assert.deepEqual(events[4].slice(1), ['fetched_at', runTimestamp]);
});

test('write preflight rejects an implausible count drop before mutation', async () => {
    const { warnings } = normalizeWarnings(fixture, runTimestamp);
    let mutationCalls = 0;
    const client = {
        from() {
            return {
                async select() {
                    return { error: null, count: 10 };
                },
                async upsert() {
                    mutationCalls += 1;
                    return { error: null };
                },
                delete() {
                    mutationCalls += 1;
                    return { lt: async () => ({ error: null, count: 0 }) };
                },
            };
        },
    };

    await assert.rejects(
        persist(
            warnings,
            runTimestamp,
            { supabaseUrl: 'https://project.supabase.co', serviceKey: 'sb_secret_test_only' },
            () => client,
        ),
        /below the safe baseline 5/,
    );
    assert.equal(mutationCalls, 0);
});
