import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_THALASSA_SUPABASE_ORIGIN } from './outboundHttp.js';
import { isSupabaseFunctionName, supabaseEdgeUrl } from './proxy.js';

const config = {
    supabaseUrl: DEFAULT_THALASSA_SUPABASE_ORIGIN,
    supabaseAnonKey: 'public-anon-key',
};

test('Supabase Edge URL construction keeps request data below the pinned authority', () => {
    const url = new URL(
        supabaseEdgeUrl(config, 'proxy-openmeteo', {
            next: 'https://attacker.test/internal',
            latitude: -27.4,
        }),
    );
    assert.equal(url.origin, DEFAULT_THALASSA_SUPABASE_ORIGIN);
    assert.equal(url.pathname, '/functions/v1/proxy-openmeteo');
    assert.equal(url.searchParams.get('next'), 'https://attacker.test/internal');
    assert.equal(url.searchParams.get('latitude'), '-27.4');
});

test('generic Edge function names cannot traverse or replace the fixed origin', () => {
    for (const valid of ['weather', 'fetch-wind-grid', 'proxy-rainbow', 'custom_proxy']) {
        assert.equal(isSupabaseFunctionName(valid), true, valid);
    }
    for (const invalid of ['../admin', 'https://attacker.test', '//attacker.test', 'UPPERCASE', '', 'a'.repeat(64)]) {
        assert.equal(isSupabaseFunctionName(invalid), false, invalid);
        assert.throws(() => supabaseEdgeUrl(config, invalid), /Unsupported/);
    }
});
