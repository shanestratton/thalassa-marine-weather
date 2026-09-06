import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'supabase/functions/voyage-log/index.ts'), 'utf8');
const privateVideo = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260904120000_private_diary_video.sql'),
    'utf8',
);

function publicVideoSource(): string {
    const start = source.indexOf('async function publicVideo(');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n}\n', start);
    return source.slice(start, end);
}

/**
 * 2026-09-06, Shane, from the phone: photos reach the public Voyage Log, the
 * video does not — the page says "the video is still making its way ashore"
 * for a clip that landed at 10:29. The diary-video bucket had gone private two
 * days earlier while this function kept handing the page the public-bucket
 * URL, which now answers 400; DiarySidebar's HEAD probe reads any non-OK
 * answer as "not ashore yet". Photos worked because publicPhotos signs them.
 */
describe('public Voyage Log video signing', () => {
    it('the bucket is private, so a public-bucket URL cannot be what the page receives', () => {
        expect(privateVideo).toContain("UPDATE storage.buckets SET public = false WHERE id = 'diary-video';");
        expect(privateVideo).toContain('DROP POLICY IF EXISTS "Public read diary video" ON storage.objects;');
    });

    it('signs the clip for the published entry exactly as photos are signed', () => {
        const fn = publicVideoSource();
        expect(fn).toContain("const privatePrefix = 'storage:diary-video:';");
        expect(fn).toContain('video.match(/diary-video\\/(.+?)(?:\\?.*)?$/)');
        expect(fn).toContain("await supabase.storage.from('diary-video').createSignedUrl(path, 3600)");
        expect(fn).toContain('return data.signedUrl;');
    });

    it('binds the path to the entry owner before signing — the endpoint signs nobody else’s media', () => {
        const fn = publicVideoSource();
        const bind = fn.indexOf("if (path.split('/')[0] !== ownerUserId) return null;");
        const sign = fn.indexOf('createSignedUrl(path, 3600)');
        expect(bind).toBeGreaterThan(-1);
        expect(sign).toBeGreaterThan(bind);
    });

    it('a clip the Pi has not landed yet passes through unsigned, so the pending card still shows', () => {
        const fn = publicVideoSource();
        expect(fn).toContain('const passThrough = /^https:\\/\\//i.test(video) ? video : null;');
        expect(fn).toContain('if (error || !data?.signedUrl) return passThrough;');
    });

    it('the entry payload goes through publicVideo and never passes an https URL through untouched', () => {
        expect(source).toContain('video_url: await publicVideo(supabase, e.video_url, e.user_id as string),');
        expect(source).not.toContain("e.video_url.startsWith('https://') ? e.video_url : null");
    });
});
