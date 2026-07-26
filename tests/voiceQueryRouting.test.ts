import { describe, expect, it } from 'vitest';
import { selectVoiceQueryRoute } from '../services/voice/voiceQueryRouting';

describe('Calypso voice query routing', () => {
    it('sends a recognised cloud question directly to the cloud text path', () => {
        expect(selectVoiceQueryRoute('cloud', '  What is our safest heading?  ')).toEqual({
            kind: 'cloud-text',
            text: 'What is our safest heading?',
        });
    });

    it('sends a recognised local question directly to the Pi text path', () => {
        expect(selectVoiceQueryRoute('bosun', 'Read the battery state')).toEqual({
            kind: 'bosun-text',
            text: 'Read the battery state',
        });
    });

    it('keeps the established audio fallbacks when live transcription is absent', () => {
        expect(selectVoiceQueryRoute('cloud', null)).toEqual({ kind: 'cloud-audio' });
        expect(selectVoiceQueryRoute('bosun', '   ')).toEqual({ kind: 'bosun-audio' });
    });
});
