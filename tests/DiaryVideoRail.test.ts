/**
 * The diary video rail — the invariants that keep a 200MB clip from becoming
 * a leak, a lie, or a surprise bill.
 *
 * Source-contract style, like DiaryComposeMediaOwnershipContract: the sync
 * machinery is too interwoven to unit-drive here, but every load-bearing line
 * the video rail added can be pinned so a later refactor cannot silently drop
 * one half of a mirrored pair.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const service = readFileSync(resolve(process.cwd(), 'services/DiaryService.ts'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'components/DiaryPage.tsx'), 'utf8');
const edge = readFileSync(resolve(process.cwd(), 'supabase/functions/diary-relay/index.ts'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260831120000_diary_video.sql'), 'utf8');

describe('diary video rail', () => {
    it('the drain uploads the clip, adopts the ref, then deletes the local blob', () => {
        expect(service).toContain('if (videoUrl && isIdbVideo(videoUrl)) {');
        // Phone-first, Pi-fallback (Shane, 2026-08-31: "if the phone can
        // upload direct, all the better. but if it cant, then pi first, as
        // always. if it exists") — and the direct attempt is only impatient
        // when a Pi is actually standing by to catch the clip.
        expect(service).toContain('const piStandingBy = isPiVideoRelayAvailable(scope);');
        // Whitespace-tolerant: prettier owns the line breaks, the ORDER is
        // the contract — direct attempt first, Pi park second.
        const drainFlat = service.replace(/\s+/g, ' ');
        expect(drainFlat).toContain(
            '(await this._uploadVideoBlob( blob, scope, piStandingBy ? directVideoBudgetMs(blob.size) : null, )) ??',
        );
        expect(drainFlat).toContain("(await this._parkVideoOnPi(blob, entry.client_operation_id ?? '', scope));");
        expect(service).toContain('adoptStorageRefs(VIDEO_BUCKET, [uploaded]);');
        expect(service).toContain('await this.discardUnsavedVideo(idbRef);');
        // An entry must never reach the server while its clip is still local.
        expect(service).toContain('if (videoStillPending) {');
    });

    it('the post-save prepend replaces, never duplicates', () => {
        // The 8s poll racing a slow save delivered the same entry into the
        // list before the prepend ran — two copies for a few seconds
        // ("phantom entry", 2026-09-01).
        const page = readFileSync(resolve(process.cwd(), 'components/DiaryPage.tsx'), 'utf8');
        expect(page).toContain('[entry, ...prev.filter((e) => e.id !== entry.id)]');
    });

    it('an in-flight entry renders exactly once — pending wins over its synced twin', () => {
        // The offline id and the server id are different, so id-dedupe alone
        // shows both copies for a while ("it duplicates it for a little
        // while", 2026-08-31). While the offline twin is pending, its server
        // row stays hidden.
        expect(service).toContain('const pendingIds = new Set(pending.map((e) => e.id));');
        expect(service).toContain('.filter((r) => !pendingIds.has(r.offlineId))');
    });

    it('the interactive publish never walks through the pending-list door', () => {
        // ensurePendingEnabled is the background drain's recovery call: it
        // consumes and CLEARS the pending list, and it RACES the publish tap
        // itself — the interactive call then found the list empty, read null
        // as failure, and showed the error while the entry published anyway
        // (every first tap, deterministically, 2026-08-31).
        const publishing = readFileSync(resolve(process.cwd(), 'components/diary/diaryPublishing.ts'), 'utf8');
        expect(publishing).toContain('await VoyageLogService.ensureEnabled()');
        expect(publishing).not.toContain('VoyageLogService.ensurePendingEnabled()');
        expect(publishing).toContain('VoyageLogService.clearEnableRequest(entryId);');
    });

    it('publishing a still-syncing entry defers, and defers is not an error', () => {
        // publish_requested rides the envelope's first write (is_public
        // derives from it), so a deferred publish is a promise that will be
        // kept — the UI must say "on its way", never "failed".
        expect(service).toContain("if (isPublic && idx >= 0) return 'deferred';");
        const publishing = readFileSync(resolve(process.cwd(), 'components/diary/diaryPublishing.ts'), 'utf8');
        expect(publishing).toContain("if (published === 'deferred') return { ok: true, config, deferred: true };");
    });

    it('a phone-local clip blocks the early Pi relay, like every other local media', () => {
        expect(service).toContain('isIdbVideo(value!) ||');
        expect(service).toContain('isPhoneOnly(entry.video_url)');
    });

    it('deleting an entry cleans the video bucket, via the tombstone if offline', () => {
        expect(service).toContain('video: video ?? null,');
        expect(service).toContain('tombstone.video,');
        expect(service).toContain('this._extractStoragePath(videoUrl, VIDEO_BUCKET)');
        expect(service).toContain('supabase.storage.from(VIDEO_BUCKET).remove([videoPath])');
    });

    it('the orphan sweep knows video refs, so a crashed save cannot strand 200MB', () => {
        expect(service).toContain("select('photos,audio_url,video_url')");
        expect(service).toContain('this._mediaRefKey(row.video_url, VIDEO_BUCKET)');
        expect(service).toContain('item.bucket === VIDEO_BUCKET && isIdbVideo(item.ref)');
    });

    it('the compose page gates duration and size before the clip costs anything', () => {
        expect(page).toContain('if (duration > 61) {');
        expect(page).toContain('550 * 1048576');
        // Replacing a clip discards the old one — two parked clips is a leak.
        expect(page).toContain('if (previous) void DiaryService.discardUnsavedVideo(previous);');
    });

    it('the relay Edge Function validates ownership of the video ref', () => {
        expect(edge).toContain("ownedStorageRef(raw.video_url, 'diary-video', ownerId)");
        expect(edge).toContain('video_url: videoUrl,');
        // The validator must accept the PUBLIC-URL form video actually ships
        // in — it silently nulled it once, and the row arrived video-less
        // while the Pi's outbox proved the envelope carried the URL.
        expect(edge).toContain('`${supabaseUrl}/storage/v1/object/public/${bucket}/${ownerId}/`');
        expect(edge).toMatch(/bucket === 'diary-video'/);
    });

    it('the bucket caps size and MIME so a bad file dies at the door', () => {
        expect(migration).toContain('524288000');
        expect(migration).toContain("'video/mp4', 'video/quicktime'");
        expect(migration).toContain('ADD COLUMN IF NOT EXISTS video_url');
    });
});

describe('pi video hand-off', () => {
    const transport = readFileSync(resolve(process.cwd(), 'services/DiaryRelayTransport.ts'), 'utf8');
    const piRelay = readFileSync(resolve(process.cwd(), 'pi-cache/src/diaryVideoRelay.ts'), 'utf8');

    it('the phone only parks on a Pi paired to the same owner', () => {
        expect(transport).toContain('status.diaryRelayOwnerId !== scope.userId) return false;');
        expect(transport).toContain('crypto.subtle.digest');
    });

    it('the Pi verifies the checksum before parking and refuses foreign folders', () => {
        expect(piRelay).toContain('Checksum mismatch — upload discarded');
        expect(piRelay).toContain('does not belong to the paired skipper');
    });

    it('the Pi uploads only to the trusted origin, via a per-object grant', () => {
        expect(piRelay).toContain("action: 'video-upload-url'");
        expect(piRelay).toContain('Signed URL points off the trusted origin');
    });

    it('the edge function grants a URL only inside the callers own folder', () => {
        expect(edge).toContain("body.action === 'video-upload-url'");
        expect(edge).toContain('Video path must be a single object in your own folder');
    });
});

describe('video reaches the row and the public page', () => {
    const upsert = readFileSync(
        resolve(process.cwd(), 'supabase/migrations/20260831190000_diary_video_in_relay_upsert.sql'),
        'utf8',
    );
    const voyageLog = readFileSync(resolve(process.cwd(), 'supabase/functions/voyage-log/index.ts'), 'utf8');
    const sidebar = readFileSync(resolve(process.cwd(), 'src/components/DiarySidebar.tsx'), 'utf8');

    it('the relay upsert writes and updates video_url', () => {
        // The original omission: the Edge Function sent video_url faithfully
        // and this column list dropped it — then the NULL row overwrote the
        // phone. All three appearances must exist or the bug is back.
        expect(upsert).toContain('        video_url,');
        expect(upsert).toContain("NULLIF(p_entry ->> 'video_url', '')");
        expect(upsert).toContain('video_url = EXCLUDED.video_url,');
        // And the function must keep its privileges intact end to end.
        expect(upsert).toMatch(/GRANT EXECUTE ON FUNCTION public\.diary_relay_upsert_entry.*TO service_role;/);
    });

    it('the public voyage log selects and passes the video through', () => {
        expect(voyageLog).toContain('photos, video_url, location_name');
        expect(voyageLog).toMatch(/video_url: typeof e\.video_url === 'string'/);
    });

    it('the public page plays it, and video-only entries advertise in the list', () => {
        expect(sidebar).toContain('entry.video_url && (');
        expect(sidebar).toContain('preload="metadata"');
        expect(sidebar).toContain('🎥 video');
    });
});
