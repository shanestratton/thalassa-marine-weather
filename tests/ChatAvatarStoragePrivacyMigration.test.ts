import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260804194000_retire_legacy_crew_avatar_paths.sql'),
    'utf8',
);

describe('legacy Crew List avatar path retirement', () => {
    it('preserves current avatar paths while removing crew-path write access', () => {
        expect(migration).toContain("bucket_id = 'chat-avatars'");
        expect(migration).toContain('(storage.foldername(name))[1] = auth.uid()::TEXT');
        expect(migration).toContain("(storage.foldername(name))[1] = 'dating'");
        expect(migration).not.toMatch(/foldername\(name\)\)\[1\]\s*=\s*'crew'/i);
    });

    it('replaces only write policies and leaves the public-read policy untouched', () => {
        expect(migration.match(/CREATE POLICY "Users can (?:upload|update|delete) own avatar"/g)).toHaveLength(3);
        expect(migration).not.toMatch(/(?:DROP|CREATE) POLICY "Anyone can view avatars"/i);
    });

    it('applies both USING and WITH CHECK to attachment-moving updates', () => {
        const updatePolicy = migration.match(
            /CREATE POLICY "Users can update own avatar"[\s\S]*?CREATE POLICY "Users can delete own avatar"/,
        )?.[0];

        expect(updatePolicy).toContain('USING (');
        expect(updatePolicy).toContain('WITH CHECK (');
    });
});
