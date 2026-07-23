import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260723100000_crew_manifest_hardening.sql', 'utf8');

describe('vessel register authorization migration', () => {
    it('does not let a view-only stores membership satisfy a write check', () => {
        const helper = migration.match(
            /CREATE OR REPLACE FUNCTION public\.can_access_vessel_register[\s\S]+?\n\$\$;/i,
        )?.[0];

        expect(helper).toBeTruthy();
        expect(helper).toMatch(
            /WHEN p_register = 'stores'[\s\S]+WHEN p_write THEN coalesce\([\s\S]+can_edit_stores[\s\S]+ELSE[\s\S]+can_view_stores/i,
        );
        expect(helper).toMatch(/ELSE p_register = ANY\(membership\.shared_registers\)/i);
        expect(helper).not.toMatch(
            /p_register = ANY\(membership\.shared_registers\)[\s\S]+OR[\s\S]+p_register = 'stores'/i,
        );
    });
});
