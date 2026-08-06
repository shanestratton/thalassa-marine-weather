import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MusicKit public-beta server boundary', () => {
    it('fails closed before authentication, cache or private-key access', () => {
        const source = readFileSync(join(process.cwd(), 'supabase/functions/musickit-token/index.ts'), 'utf8');
        const hold = source.indexOf('if (!MUSICKIT_PUBLIC_BETA_ENABLED)');
        const quota = source.indexOf("requireAuthenticatedOrPublicQuota(req, 'musickit_token'");
        const key = source.indexOf("Deno.env.get('MUSICKIT_PRIVATE_KEY')");

        // Server gate is a DEPLOYMENT secret, never the client's VITE_ flag —
        // that ships in the bundle where any user can read and set it. Unset
        // or malformed leaves the endpoint closed.
        expect(source).toContain("Deno.env.get('MUSICKIT_ENABLED') === 'true'");
        expect(source).not.toContain('VITE_APPLE_MUSIC_ENABLED');
        expect(hold).toBeGreaterThan(-1);
        expect(hold).toBeLessThan(quota);
        expect(hold).toBeLessThan(key);
        expect(source.slice(hold, quota)).toContain("'Cache-Control': 'no-store'");
        expect(source.slice(hold, quota)).toContain('status: 503');
    });
});
