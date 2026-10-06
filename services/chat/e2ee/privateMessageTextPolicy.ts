// Pure admission only. No normalization, Auth, storage, SDK or transport.
import { MAX_CHAT_MESSAGE_CHARS } from '../messagePolicy';

/** Preserve exact caller bytes; structured legacy shares are not pilot text. */
export function isPrivateMessagePilotText(text: unknown): text is string {
    return (
        typeof text === 'string' &&
        text.trim().length > 0 &&
        text.length <= MAX_CHAT_MESSAGE_CHARS &&
        !text.includes('\0') &&
        !text.split(/\r?\n/).some((line) => line.startsWith('📍PIN|') || line.startsWith('🍳RECIPE:'))
    );
}
