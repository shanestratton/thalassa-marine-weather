import { beforeEach, describe, expect, it } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { choseJustRecording, rememberJustRecording } from '../services/shiplog/recordingChoice';

describe('Just recording answer', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('persists only for the chosen voyage and its owner', () => {
        const a = setAuthIdentityScope('a');
        rememberJustRecording('voyage-1', a);
        expect(choseJustRecording('voyage-1', a)).toBe(true);
        expect(choseJustRecording('voyage-2', a)).toBe(false);
        const b = setAuthIdentityScope('b');
        expect(choseJustRecording('voyage-1', b)).toBe(false);
        rememberJustRecording('late-voyage', a);
        const aAgain = setAuthIdentityScope('a');
        expect(choseJustRecording('voyage-1', aAgain)).toBe(true);
        expect(choseJustRecording('late-voyage', aAgain)).toBe(false);
    });

    it('ignores corrupt stored answers', () => {
        const scope = setAuthIdentityScope('a');
        const key = authScopedStorageKey('thalassa_just_recording_v1', scope);
        for (const value of ['not-json', 'null', '{}', '[null, false, 5]']) {
            localStorage.setItem(key, value);
            expect(choseJustRecording('v', scope)).toBe(false);
        }
        rememberJustRecording('v', scope);
        expect(choseJustRecording('v', scope)).toBe(true);
    });
});
