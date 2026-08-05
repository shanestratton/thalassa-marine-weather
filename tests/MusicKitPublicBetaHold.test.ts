import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MusicKit public-beta server boundary', () => {
    it('fails closed before authentication, cache or private-key access', () => {
        const source = readFileSync(join(process.cwd(), 'supabase/functions/musickit-token/index.ts'), 'utf8');
        const hold = source.indexOf('if (!MUSICKIT_PUBLIC_BETA_ENABLED)');
        const quota = source.indexOf("requireAuthenticatedOrPublicQuota(req, 'musickit_token'");
        const key = source.indexOf("Deno.env.get('MUSICKIT_PRIVATE_KEY')");

        expect(source).toContain('const MUSICKIT_PUBLIC_BETA_ENABLED = false');
        expect(hold).toBeGreaterThan(-1);
        expect(hold).toBeLessThan(quota);
        expect(hold).toBeLessThan(key);
        expect(source.slice(hold, quota)).toContain("'Cache-Control': 'no-store'");
        expect(source.slice(hold, quota)).toContain('status: 503');
    });
});
