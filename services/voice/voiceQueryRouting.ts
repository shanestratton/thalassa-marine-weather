/**
 * Select the transport after a Calypso capture cycle.
 *
 * A live recognizer has already turned a spoken question into text. Sending
 * its placeholder/recording blob through a second STT pass is slower and can
 * lose the words altogether, so both the cloud and boat-side paths consume
 * that text directly. When no usable live transcript exists, retain the
 * established audio fallback (cloud Scribe or the Pi's Whisper path).
 */
export type VoiceQueryTarget = 'bosun' | 'cloud';

export type VoiceQueryRoute =
    | { kind: 'cloud-text'; text: string }
    | { kind: 'bosun-text'; text: string }
    | { kind: 'cloud-audio' }
    | { kind: 'bosun-audio' };

export function selectVoiceQueryRoute(
    target: VoiceQueryTarget,
    preTranscribed: string | null | undefined,
): VoiceQueryRoute {
    const text = preTranscribed?.trim();
    if (text) {
        return target === 'cloud' ? { kind: 'cloud-text', text } : { kind: 'bosun-text', text };
    }

    return target === 'cloud' ? { kind: 'cloud-audio' } : { kind: 'bosun-audio' };
}
