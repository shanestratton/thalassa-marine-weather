import { describe, expect, it } from 'vitest';
import { combineDiaryVoiceTranscript } from '../utils/diaryVoiceTranscript';

describe('combineDiaryVoiceTranscript', () => {
    it('shows a live partial without changing the pre-existing note', () => {
        expect(combineDiaryVoiceTranscript('Earlier watch notes.', 'We are making six knots')).toBe(
            'Earlier watch notes.\n\nWe are making six knots',
        );
    });

    it('replaces an interim result with the final result instead of appending it', () => {
        const baseline = 'Earlier watch notes.';
        const interim = combineDiaryVoiceTranscript(baseline, 'We are making six');
        const final = combineDiaryVoiceTranscript(baseline, 'We are making six knots on a calm sea.');

        expect(interim).toBe('Earlier watch notes.\n\nWe are making six');
        expect(final).toBe('Earlier watch notes.\n\nWe are making six knots on a calm sea.');
        expect(final).not.toContain('six\n\nWe are');
    });

    it('does not leave extra whitespace when a recognizer returns no text', () => {
        expect(combineDiaryVoiceTranscript('Earlier watch notes.   ', '   ')).toBe('Earlier watch notes.');
        expect(combineDiaryVoiceTranscript('', '  Fresh voice note.  ')).toBe('Fresh voice note.');
    });
});
