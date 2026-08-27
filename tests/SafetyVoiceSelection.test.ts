/**
 * Shane 2026-08-28, on the spoken MOB position: "the person speaking is all
 * fucked up. i think it is apples standard text to speech… we need it far
 * more polished."
 *
 * He was right about the cause. The Calypso (ElevenLabs) path is raced
 * against a deliberately tight budget so a distress call can never stall on
 * the network — but the fallback then built its utterance and set NO voice at
 * all, so iOS handed back its default, which is usually the compact one this
 * module's own header calls "a 1980s autopilot". The fallback fires when the
 * network is poor, which at sea is exactly when the Mayday matters, so it
 * deserves the best voice on the device.
 */
import { describe, expect, it } from 'vitest';
import { pickBestNativeVoice } from '../services/voice/safetyTts';

const v = (name: string, lang: string, localService = true): SpeechSynthesisVoice =>
    ({ name, lang, localService, default: false, voiceURI: name }) as SpeechSynthesisVoice;

describe('pickBestNativeVoice', () => {
    it('prefers a Siri/Premium/Enhanced voice over the compact default', () => {
        const chosen = pickBestNativeVoice([v('Samantha', 'en-US'), v('Karen (Enhanced)', 'en-AU')]);
        expect(chosen?.name).toBe('Karen (Enhanced)');
    });

    it('ranks quality above locale — a better voice in the wrong accent still wins', () => {
        // Copying a Mayday matters more than the accent it arrives in.
        const chosen = pickBestNativeVoice([v('Karen', 'en-AU'), v('Siri Voice 2', 'en-US')]);
        expect(chosen?.name).toBe('Siri Voice 2');
    });

    it('prefers Australian English when quality is equal', () => {
        const chosen = pickBestNativeVoice([
            v('Daniel (Enhanced)', 'en-GB'),
            v('Karen (Enhanced)', 'en-AU'),
            v('Alex (Enhanced)', 'en-US'),
        ]);
        expect(chosen?.name).toBe('Karen (Enhanced)');
    });

    it('never picks a novelty voice for a distress call', () => {
        // Apple still ships these. Any of them reading a MAYDAY is grotesque.
        const chosen = pickBestNativeVoice([v('Zarvox', 'en-US'), v('Bad News', 'en-US'), v('Samantha', 'en-US')]);
        expect(chosen?.name).toBe('Samantha');
    });

    it('excludes novelty voices even when they are the only English ones', () => {
        expect(pickBestNativeVoice([v('Trinoids', 'en-US'), v('Bubbles', 'en-GB')])).toBeNull();
    });

    it('ignores non-English voices entirely', () => {
        expect(pickBestNativeVoice([v('Anna', 'de-DE'), v('Amelie', 'fr-CA')])).toBeNull();
    });

    it('returns null on an empty list so the caller keeps the OS default', () => {
        // iOS populates getVoices() asynchronously; an empty list must
        // degrade to "speak with whatever you have", never to silence.
        expect(pickBestNativeVoice([])).toBeNull();
    });

    it('breaks a tie toward the on-device voice', () => {
        // A network voice can fail halfway through a distress call.
        const chosen = pickBestNativeVoice([
            v('Karen (Enhanced)', 'en-AU', false),
            v('Karen (Enhanced)', 'en-AU', true),
        ]);
        expect(chosen?.localService).toBe(true);
    });
});
