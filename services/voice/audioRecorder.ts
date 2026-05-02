/**
 * Audio recorder — MediaRecorder wrapper for the Bosun voice console.
 *
 * Replaces the previous Web Speech API approach which was fragile on iOS
 * WKWebView (audio session conflicts with playback, second-query failures,
 * inconsistent onend firing). MediaRecorder is a standards-based API that
 * iOS Safari has supported since 14.3 and behaves identically to Chrome.
 *
 * Pattern:
 *   - start()   acquire mic via getUserMedia, begin recording
 *   - stop()    flush, release the mic, return the recorded Blob
 *   - cancel()  release the mic, discard
 *
 * Caller (BosunConsole) handles the tap-to-toggle UX: tap once → start(),
 * tap again → stop() → POST blob to backend for STT.
 */

interface RecorderHandle {
    /** Stop recording and return the captured audio Blob. */
    stop: () => Promise<Blob>;
    /** Abort recording without returning audio. */
    cancel: () => void;
    /** True while the recorder is actively capturing audio. */
    isRecording: () => boolean;
    /** MIME type of the audio (e.g. 'audio/mp4', 'audio/webm'). */
    mimeType: () => string;
}

/** True when the runtime supports MediaRecorder + getUserMedia. */
export function isAudioRecordingSupported(): boolean {
    if (typeof navigator === 'undefined') return false;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    if (typeof MediaRecorder === 'undefined') return false;
    return true;
}

/**
 * Pick the best MIME type the runtime supports.
 *
 * iOS Safari WKWebView typically supports audio/mp4 (AAC). Chrome/Firefox
 * prefer audio/webm with opus. Empty string lets MediaRecorder pick its
 * own default if nothing in our preference list works.
 */
function pickMimeType(): string {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
        'audio/mp4', // iOS Safari WKWebView
        'audio/webm;codecs=opus', // Chrome, Firefox
        'audio/webm',
        'audio/mpeg',
        '',
    ];
    for (const mt of candidates) {
        if (mt === '') return '';
        try {
            if (MediaRecorder.isTypeSupported(mt)) return mt;
        } catch {
            /* some platforms throw on isTypeSupported — skip */
        }
    }
    return '';
}

/**
 * Start recording audio. Returns a handle the caller uses to stop or cancel.
 * Throws if the platform doesn't support MediaRecorder or the user denies
 * mic permission.
 */
export async function startRecording(): Promise<RecorderHandle> {
    if (!isAudioRecordingSupported()) {
        throw new Error('Audio recording not supported on this device. Update iOS or use the text input below.');
    }

    let stream: MediaStream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
    } catch (err) {
        const e = err as Error;
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
            throw new Error('Microphone permission denied. Enable mic access in iOS Settings.');
        }
        throw new Error(`Could not access microphone: ${e.message}`);
    }

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (err) {
        // Last-resort: try with no options. Some platforms reject explicit
        // mimeType but accept the default.
        stream.getTracks().forEach((t) => t.stop());
        throw new Error(`MediaRecorder creation failed: ${(err as Error).message}`);
    }

    const chunks: Blob[] = [];
    let recording = true;

    recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    recorder.start(250); // emit chunks every 250 ms so stop() finishes promptly

    const releaseTracks = () => {
        try {
            stream.getTracks().forEach((t) => t.stop());
        } catch {
            /* ignore */
        }
    };

    return {
        stop: () => {
            return new Promise<Blob>((resolve, reject) => {
                if (!recording) {
                    return resolve(new Blob([], { type: recorder.mimeType }));
                }
                recording = false;

                // Hard timeout in case the recorder doesn't fire onstop
                // (rare iOS WKWebView quirk on consecutive sessions).
                const timeout = setTimeout(() => {
                    releaseTracks();
                    reject(new Error('Recorder stop timed out'));
                }, 5000);

                recorder.onstop = () => {
                    clearTimeout(timeout);
                    releaseTracks();
                    const blob = new Blob(chunks, { type: recorder.mimeType });
                    resolve(blob);
                };

                recorder.onerror = (event: Event) => {
                    clearTimeout(timeout);
                    releaseTracks();
                    const errorEvent = event as Event & { error?: Error };
                    reject(errorEvent.error || new Error('Recorder error'));
                };

                try {
                    recorder.stop();
                } catch (err) {
                    clearTimeout(timeout);
                    releaseTracks();
                    reject(err as Error);
                }
            });
        },
        cancel: () => {
            recording = false;
            try {
                if (recorder.state !== 'inactive') recorder.stop();
            } catch {
                /* ignore */
            }
            releaseTracks();
        },
        isRecording: () => recording,
        mimeType: () => recorder.mimeType,
    };
}

/** Convert a Blob to a base64 data string (no data: prefix). */
export async function blobToBase64(blob: Blob): Promise<string> {
    if (blob.size === 0) return '';
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 32_768;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}
