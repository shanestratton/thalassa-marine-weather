/**
 * The cloud tool-loop turn, lifted out of BosunConsole.tsx verbatim as a
 * single useCallback called from the same position in the component body.
 *
 * The dependency arrays below are the originals plus the ref / setState
 * identities the extraction made visible to react-hooks/exhaustive-deps.
 * React guarantees both are stable for the component's lifetime, so the
 * arrays are unchanged in effect.
 */
import { type MutableRefObject, useCallback } from 'react';
import { askHaiku, consumeLastTtsError, synthesiseSpeech } from '../../../services/voice/orchestrator';
import { startSpokenReply, type SpokenReply } from '../../../services/voice/spokenReplyQueue';
import { gatherThalassaContext } from '../../../services/voice/thalassaContext';
import { consumeTtsClientError } from '../../../services/voice/ttsClient';
import { buildHistory } from './helpers';
import type { VoiceOperation } from './types';
import type { VoiceQueryResponse, VoiceTurn } from '../../../types/voice';

/**
 * Run the on-device orchestrator path: Haiku tool-loop runs locally
 * via anthropic-proxy, dispatching Pi tools and thalassa_weather
 * client-side, then ElevenLabs TTS via elevenlabs-tts. Returns the
 * standard VoiceQueryResponse envelope so handleResponse can stay
 * agnostic to which path produced the answer.
 */
export function useRunOrchestrator(
    turns: VoiceTurn[],
    integrationsEnabled: { appleMusic: boolean; gmail: boolean },
    isVoiceOperationCurrent: (operation: VoiceOperation) => boolean,
    setErrorMessage: (msg: string | null) => void,
    spokenReplyRef: MutableRefObject<SpokenReply | null>,
): (text: string, operation: VoiceOperation, signal: AbortSignal, spoken: boolean) => Promise<VoiceQueryResponse> {
    return useCallback(
        async (
            text: string,
            operation: VoiceOperation,
            signal: AbortSignal,
            /**
             * Speak the reply as it streams. True for a turn the skipper
             * started with their voice — asking out loud and getting silent
             * text back is the complaint this fixes. A TYPED question stays
             * text-only: someone at the keyboard, possibly with guests aboard,
             * did not ask to be talked at.
             */
            spoken: boolean,
        ): Promise<VoiceQueryResponse> => {
            if (!isVoiceOperationCurrent(operation)) throw new Error('Voice operation cancelled');
            const context = gatherThalassaContext();
            const history = buildHistory(turns);

            // Speak sentence-by-sentence off the stream. Time-to-first-word
            // becomes "first sentence written" instead of "whole reply
            // written, then synthesised, then played".
            // A new spoken turn silences the previous one. Speech outlives
            // the request that produced it, so without this the answer to the
            // last question talks over the next one.
            spokenReplyRef.current?.cancel();
            const reply = spoken ? startSpokenReply() : null;
            spokenReplyRef.current = reply;
            // Stays attached until playback finishes, not just until the
            // request does — an abort mid-sentence has to stop the audio.
            const abortSpeech = () => reply?.cancel();
            signal.addEventListener('abort', abortSpeech, { once: true });
            const detachAbort = () => signal.removeEventListener('abort', abortSpeech);

            let result;
            try {
                result = await askHaiku({
                    text,
                    context,
                    history,
                    integrations: integrationsEnabled,
                    signal,
                    onTextDelta: reply ? (delta) => reply.push(delta) : undefined,
                    onTurnEnd: reply ? () => reply.flush() : undefined,
                });
            } catch (err) {
                reply?.cancel();
                detachAbort();
                throw err;
            }
            if (!isVoiceOperationCurrent(operation)) {
                reply?.cancel();
                detachAbort();
                throw new Error('Voice operation cancelled');
            }
            if (!reply) detachAbort();

            if (reply) {
                // Don't await — the text belongs on screen now, while the
                // remaining sentences are still being spoken.
                void reply.end().then(() => {
                    detachAbort();
                    if (spokenReplyRef.current === reply) spokenReplyRef.current = null;
                    // TWO channels, because there are two TTS clients. The
                    // spoken queue goes through ttsClient.speak, which records
                    // its failures in its own module-level slot — checking only
                    // the orchestrator's meant the path that actually went
                    // quiet was the one path that never reported why.
                    const ttsError = consumeTtsClientError() ?? consumeLastTtsError();
                    if (ttsError && isVoiceOperationCurrent(operation)) setErrorMessage(ttsError);
                });
                return {
                    transcript: text,
                    answer_text: result.answerText,
                    // Already spoken by the queue — handing audio to
                    // playResponseAudio as well would say it twice.
                    audio_b64: undefined,
                    source: 'cloud',
                    tool_calls: result.toolCalls.map((name) => ({ name, args: {}, status: 'success' as const })),
                };
            }

            const audio_b64 = await synthesiseSpeech(result.answerText, signal);
            if (!isVoiceOperationCurrent(operation)) throw new Error('Voice operation cancelled');
            // A null here means ElevenLabs refused — quota, auth, or
            // unreachable. Saying nothing turned every one of those into
            // "Calypso just writes now" with no way to tell why.
            if (!audio_b64) {
                const ttsError = consumeLastTtsError();
                if (ttsError) setErrorMessage(ttsError);
            }
            return {
                transcript: text,
                answer_text: result.answerText,
                audio_b64: audio_b64 ?? undefined,
                source: 'cloud',
                tool_calls: result.toolCalls.map((name) => ({
                    name,
                    args: {},
                    status: 'success' as const,
                })),
            };
        },
        [turns, integrationsEnabled, isVoiceOperationCurrent, setErrorMessage, spokenReplyRef],
    );
}
