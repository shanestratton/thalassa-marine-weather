export type DeepgramFrameKind =
    | 'binary'
    | 'text'
    | 'Results'
    | 'Metadata'
    | 'UtteranceEnd'
    | 'SpeechStarted'
    | 'Finalize'
    | 'Error'
    | 'other-json';

/** Maps upstream-controlled JSON onto a fixed diagnostic vocabulary. */
export function classifyDeepgramFrame(data: unknown): DeepgramFrameKind {
    if (data instanceof ArrayBuffer) return 'binary';
    if (typeof data !== 'string') return 'binary';
    try {
        const parsed = JSON.parse(data) as { type?: unknown };
        switch (parsed.type) {
            case 'Results':
                return 'Results';
            case 'Metadata':
                return 'Metadata';
            case 'UtteranceEnd':
                return 'UtteranceEnd';
            case 'SpeechStarted':
                return 'SpeechStarted';
            case 'Finalize':
                return 'Finalize';
            case 'Error':
                return 'Error';
            default:
                return 'other-json';
        }
    } catch {
        return 'text';
    }
}
