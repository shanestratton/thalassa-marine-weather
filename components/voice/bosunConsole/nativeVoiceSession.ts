/**
 * The optional native AppleMusic bridge that owns iOS's shared
 * AVAudioSession. Split out of BosunConsole.tsx verbatim.
 */

/**
 * The native AppleMusic plugin owns Calypso's response TTS. Its playback
 * path can leave iOS's single shared AVAudioSession in `.playback`, which
 * means a still-live WKWebView MediaStream may report as started while
 * delivering no microphone samples. Keep the bridge deliberately optional:
 * web builds and an older installed native shell simply keep the existing
 * capture path, while a current iOS shell hands the session back to input
 * immediately before we acquire/reuse the microphone.
 */
export type AppleMusicNativeBridge = {
    cancelTtsAudio?: () => Promise<{ status: string }>;
    prepareVoiceInput?: () => Promise<{ status: string }>;
    releaseVoiceInput?: () => Promise<{ status: string }>;
};

export function getAppleMusicNativeBridge(): AppleMusicNativeBridge | undefined {
    return (
        globalThis as typeof globalThis & {
            Capacitor?: {
                Plugins?: {
                    AppleMusic?: AppleMusicNativeBridge;
                };
            };
        }
    ).Capacitor?.Plugins?.AppleMusic;
}

export async function prepareNativeVoiceInput(): Promise<boolean> {
    const plugin = getAppleMusicNativeBridge();
    if (!plugin) return false;

    if (plugin.prepareVoiceInput) {
        try {
            // The current native shell stops its AVAudioPlayer itself before
            // switching to `.playAndRecord`, so this is one ordered bridge
            // call rather than two racing requests to the shared session.
            await plugin.prepareVoiceInput();
            return true;
        } catch (error) {
            // Do not prevent the browser fallback from trying getUserMedia.
            // A second, older-shell fallback below still stops native TTS.
            console.warn('[BosunConsole] native voice-input session handoff failed:', error);
        }
    }

    try {
        // Backward compatibility for an installed native shell from before
        // prepareVoiceInput existed. It cannot restore the input category,
        // but it can at least stop a competing native TTS player.
        await plugin.cancelTtsAudio?.();
    } catch {
        // A cancelled / already-finished utterance is not a capture failure.
    }
    return false;
}

export function releaseNativeVoiceInput(): void {
    void getAppleMusicNativeBridge()
        ?.releaseVoiceInput?.()
        .catch(() => undefined);
}
