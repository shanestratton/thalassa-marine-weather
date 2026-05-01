/**
 * Speech recognition via the Web Speech API (`webkitSpeechRecognition`).
 *
 * Why no Capacitor plugin: the Web Speech API works in iOS WKWebView (the
 * runtime Capacitor uses) and gives us record + on-device STT in a single
 * standards-based call. No native plugin install, no Cap-version drift,
 * works the same in dev (Chrome) and on iOS.
 *
 * Used by the PTT button on AvNavPage — press-and-hold to capture, release
 * to stop. The transcript flows to either the Bosun client or the cloud
 * fallback depending on whether the boat WiFi is reachable.
 */

/** Web Speech API result row — only the fields we care about. */
interface SpeechRecognitionResult {
    transcript: string;
    isFinal: boolean;
    confidence: number;
}

interface SpeechRecognitionHandle {
    /** Stop recording and resolve with the final transcript. */
    stop: () => Promise<string>;
    /** Abort without producing a transcript. */
    cancel: () => void;
    /** Subscribe to interim transcripts while the user is still speaking. */
    onPartial: (cb: (text: string) => void) => void;
}

/** Browser-feature-detect — returns null when speech recognition isn't available. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSpeechRecognitionCtor(): (new () => any) | null {
    if (typeof window === 'undefined') return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function isSpeechRecognitionSupported(): boolean {
    return getSpeechRecognitionCtor() !== null;
}

/**
 * Start listening. Caller must invoke `.stop()` to get the final transcript
 * (i.e. on PTT button release) or `.cancel()` to abort.
 *
 * Note: iOS WKWebView's webkitSpeechRecognition uses Apple's online speech
 * service. Works at the marina; degrades offshore. The cloud fallback is
 * the natural offshore answer (it also won't reach Anthropic, so the UI
 * will show "Bosun unreachable" — which is actually correct: at sea, only
 * Bosun-on-the-Pi answers).
 */
export function startListening(): SpeechRecognitionHandle {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
        throw new Error(
            'Speech recognition not available on this device. ' + 'Update iOS or use a more recent device.',
        );
    }

    const recog = new Ctor();
    recog.continuous = false; // single utterance per PTT press
    recog.interimResults = true; // emit partials so UI can show live transcript
    recog.maxAlternatives = 1;
    recog.lang = navigator.language || 'en-US';

    let partialCallbacks: Array<(t: string) => void> = [];
    let bestTranscript = '';
    let stopRequested = false;

    recog.onresult = (event: { resultIndex: number; results: SpeechRecognitionResult[][] }) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const r = event.results[i][0];
            if (r.isFinal) {
                bestTranscript = (bestTranscript ? bestTranscript + ' ' : '') + r.transcript.trim();
            } else {
                // Surface interim text for live UI feedback
                const interim = r.transcript.trim();
                if (interim) partialCallbacks.forEach((cb) => cb(interim));
            }
        }
    };

    type Resolver = (text: string) => void;
    type Rejecter = (err: Error) => void;
    let resolveStop: Resolver = () => {};
    let rejectStop: Rejecter = () => {};
    const finalPromise = new Promise<string>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
    });

    recog.onend = () => {
        // Either path resolves with whatever we captured. The browser may
        // end recognition on its own (silence timeout); still resolve so
        // the caller can handle a short utterance gracefully.
        resolveStop(bestTranscript.trim());
    };

    recog.onerror = (event: { error: string; message?: string }) => {
        if (event.error === 'aborted' || event.error === 'no-speech') {
            // Treat user-initiated cancel and "didn't say anything" as soft outcomes
            resolveStop('');
            return;
        }
        rejectStop(new Error(`Speech recognition: ${event.error}`));
    };

    try {
        recog.start();
    } catch (err) {
        // Common cause: start() called before previous instance fully ended
        rejectStop(err as Error);
    }

    return {
        stop: () => {
            stopRequested = true;
            try {
                recog.stop();
            } catch {
                /* recog may already be stopping */
            }
            // iOS WKWebView quirk: on the second-or-later consecutive
            // SpeechRecognition session, recog.stop() sometimes never
            // triggers the onend/onerror callbacks. The finalPromise then
            // hangs forever, leaving the button stuck on 'sending'. Race
            // against a 3s deadline so the user can always make another
            // attempt — we still return whatever transcript was collected
            // on partials.
            return Promise.race([
                finalPromise,
                new Promise<string>((resolve) => {
                    setTimeout(() => {
                        try {
                            recog.abort();
                        } catch {
                            /* already gone */
                        }
                        resolve(bestTranscript.trim());
                    }, 3000);
                }),
            ]);
        },
        cancel: () => {
            stopRequested = false;
            try {
                recog.abort();
            } catch {
                /* already aborted */
            }
            partialCallbacks = [];
            // Also resolve the finalPromise so any pending await unwedges.
            resolveStop('');
        },
        onPartial: (cb) => {
            partialCallbacks.push(cb);
        },
    };
}
