/**
 * No diary bucket may be world-readable.
 *
 * diary-photos and diary-audio were closed in July 2026 and switched to
 * short-lived signed URLs. Five weeks later the diary-video migration created
 * its bucket with `public = true` and a blanket read policy, under the comment
 * "public read, same policy as diary-photos" — false since July. A private
 * entry still served its clip to anyone holding the URL, and unpublishing
 * could not revoke it because nothing checked.
 *
 * This sweeps EVERY migration rather than pinning the one that was wrong: the
 * failure mode was a NEW bucket copying a stale comment, so the guard has to
 * catch the next new bucket too.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = 'supabase/migrations';
const sql = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ file: f, body: readFileSync(`${DIR}/${f}`, 'utf8') }));

/** The last thing every migration says about a bucket, in order. */
function finalPublicFlag(bucket: string): boolean | null {
    let state: boolean | null = null;
    for (const { body } of sql) {
        const insert = body.match(new RegExp(`'${bucket}',\\s*'${bucket}',\\s*(true|false)`));
        if (insert) state = insert[1] === 'true';
        const update = [...body.matchAll(/UPDATE storage\.buckets SET public = (true|false) WHERE id[^;]*;/g)];
        for (const u of update) if (u[0].includes(bucket)) state = u[1] === 'true';
    }
    return state;
}

describe('diary media buckets', () => {
    for (const bucket of ['diary-photos', 'diary-audio', 'diary-video']) {
        it(`${bucket} ends up PRIVATE`, () => {
            expect(finalPublicFlag(bucket)).toBe(false);
        });
    }

    it('no blanket public-read policy survives on a diary bucket', () => {
        const created = sql.map((s) => s.body).join('\n');
        for (const bucket of ['diary-photos', 'diary-audio', 'diary-video']) {
            const open = new RegExp(`CREATE POLICY "Public read[^"]*"[\\s\\S]{0,300}?bucket_id = '${bucket}'`);
            const dropped = new RegExp(`DROP POLICY IF EXISTS "Public read[^"]*"`);
            if (open.test(created)) expect(dropped.test(created), `${bucket} public policy never dropped`).toBe(true);
        }
    });

    it('video playback signs rather than relying on a public URL', () => {
        const svc = readFileSync('services/DiaryService.ts', 'utf8');
        // Sliced FORWARD from the method: an unanchored indexOf for the next
        // symbol finds an earlier CALL SITE and slices backwards to ''.
        const at = svc.indexOf('async resolveVideoUrl');
        expect(at).toBeGreaterThan(-1);
        const resolve = svc.slice(at, at + 1400);
        expect(resolve).toMatch(/_createSignedStorageUrl\(VIDEO_BUCKET/);
    });
});
