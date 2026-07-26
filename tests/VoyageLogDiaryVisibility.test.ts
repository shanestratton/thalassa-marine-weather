import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'supabase/functions/voyage-log/index.ts'), 'utf8');

describe('public Voyage Log diary visibility', () => {
    it('keeps an explicitly published diary entry visible when its track is hidden', () => {
        const diaryQuery = source.slice(source.indexOf(".from('diary_entries')"), source.indexOf('const entries ='));
        const entryAssembly = source.slice(source.indexOf('const entries ='), source.indexOf('const durableTrack ='));

        expect(diaryQuery).toContain(".eq('is_public', true)");
        expect(entryAssembly).not.toContain('hiddenVoyageIds.has');
    });
});
