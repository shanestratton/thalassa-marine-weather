import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('retired public float-plan Edge boundary', () => {
    it('ships only a fail-closed tombstone with no database or service-role access', () => {
        const source = readFileSync(join(process.cwd(), 'supabase/functions/float-plan/index.ts'), 'utf8');

        expect(source).toContain('status: 410');
        expect(source).toContain("'Cache-Control': 'no-store'");
        expect(source).toContain('Public float-plan links are retired for this beta');
        expect(source).not.toContain('createClient');
        expect(source).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(source).not.toContain('voyage_log_configs');
        expect(source).not.toContain('ship_logs');
    });
});
