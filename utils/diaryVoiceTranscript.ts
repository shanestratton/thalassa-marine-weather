/**
 * Merge a streaming voice result into a diary body without mutating notes
 * that existed before the current microphone session.
 */
export const combineDiaryVoiceTranscript = (baseline: string, transcript: string): string => {
    const existing = baseline.trimEnd();
    const spoken = transcript.trim();
    if (!spoken) return existing;
    return existing ? `${existing}\n\n${spoken}` : spoken;
};
