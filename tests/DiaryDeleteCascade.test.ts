/**
 * Deleting a diary entry must take its media with it.
 *
 * Shane 2026-09-04: "ensure that if a punter deletes a diary entry off of his
 * phone, it deletes the corresponding videos and photos off supabase".
 *
 * It already does. This pins the behaviour rather than changing it, because
 * the failure mode is silent and permanent: an orphaned object in a private
 * bucket is storage nobody can see, nobody is paying attention to, and — until
 * the video bucket was closed earlier today — was world-readable by URL.
 *
 * The ORDER is the part worth protecting. The row is deleted first: storage
 * first, with a row delete that then kept failing, would resurrect the entry
 * pointing at media that no longer exists. And the tombstone is not
 * acknowledged until every object is gone, so a failed storage removal retries
 * instead of being quietly forgotten.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const svc = readFileSync('services/DiaryService.ts', 'utf8');
const fn = svc.slice(svc.indexOf('private async _deleteOnServer'), svc.indexOf('async publishEntry'));

describe('diary delete cascades to Supabase storage', () => {
    it('removes photos, audio AND video from their buckets', () => {
        expect(fn).toMatch(/storage\.from\(PHOTO_BUCKET\)\.remove\(\[path\]\)/);
        expect(fn).toMatch(/storage\.from\(AUDIO_BUCKET\)\.remove\(\[audioPath\]\)/);
        expect(fn).toMatch(/storage\.from\(VIDEO_BUCKET\)\.remove\(\[videoPath\]\)/);
    });

    it('deletes the ROW first, so a failing delete cannot resurrect an entry with dead media', () => {
        const row = fn.indexOf(`.from(TABLE).delete()`);
        const firstObject = fn.indexOf('storage.from(PHOTO_BUCKET)');
        expect(row).toBeGreaterThan(-1);
        expect(firstObject).toBeGreaterThan(row);
    });

    it('keeps the tombstone until every object is gone', () => {
        // Each storage failure returns false, which leaves the tombstone in
        // place for the next drain. Silently continuing would orphan the file
        // forever, since nothing else ever revisits it.
        const failures = fn.match(/cleanup failed — will retry with the tombstone/g) ?? [];
        expect(failures.length).toBe(3);
    });

    it('recovers the media paths from the row when the local copy has lost them', () => {
        // A cold cache knows the id but not the photo list. Without this the
        // delete would succeed and leave every object behind.
        expect(fn).toMatch(/select\('photos, audio_url, video_url, client_operation_id'\)/);
    });

    it('cancels a Pi-parked upload, so it cannot land after the delete', () => {
        // _parkVideoOnPi mints the URL before the object exists; the Pi
        // uploads later. Without the cancellation an entry deleted in that
        // window would be re-populated by a clip arriving afterwards.
        expect(svc).toMatch(/void cancelDiaryOnPi\(clientOperationId\)/);
        expect(fn).toMatch(/cancelDiaryDirect\(operationId\)/);
    });

    it('an offline entry cleans up its on-device media too', () => {
        const offline = svc.slice(svc.indexOf('async deleteEntry'), svc.indexOf('private _commitLocalDelete'));
        expect(offline).toMatch(/idbDeletePhoto\(p\)/);
        expect(offline).toMatch(/discardUnsavedAudio\(entry\.audio_url\)/);
        expect(offline).toMatch(/discardUnsavedVideo\(entry\.video_url\)/);
        // …and revokes the object URL, which is what actually frees the bytes.
        expect(offline).toMatch(/URL\.revokeObjectURL\(cachedUrl\)/);
    });
});
