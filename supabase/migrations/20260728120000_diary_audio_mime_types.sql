-- Let the diary-audio bucket accept the formats the app actually records.
--
-- normalizeDiaryAudioMimeType (services/DiaryService.ts:173) resolves a
-- recording to one of: audio/webm, audio/mp4, audio/mpeg, audio/wav,
-- audio/ogg, audio/aac. The bucket's allowed_mime_types only listed four of
-- those — audio/mpeg and audio/aac were missing — and Supabase Storage
-- rejects an upload whose contentType is not in the list.
--
-- That rejection is not survivable by the sync loop: _uploadAudioBlob returns
-- null, audioStillPending goes true, and the entry is skipped BEFORE both the
-- Pi handoff and the direct write. The IDB blob is only discarded on success,
-- so every retry re-sends the same rejected type and re-parks the entry — a
-- permanent, silent stall for any memo recorded as aac or mpeg. Exactly the
-- shape of the diary-relay outage, waiting on a format iOS is entitled to pick.
--
-- Widening the BUCKET rather than narrowing the normalizer, deliberately: the
-- normalizer describes what the recorder produces, and coercing a real aac
-- recording's contentType to audio/mp4 would store a file whose declared type
-- is a lie. Storage is the thing that was out of date.
UPDATE storage.buckets
   SET allowed_mime_types = ARRAY[
        'audio/webm',
        'audio/mp4',
        'audio/mpeg',
        'audio/wav',
        'audio/ogg',
        'audio/aac'
   ]::text[]
 WHERE id = 'diary-audio';
