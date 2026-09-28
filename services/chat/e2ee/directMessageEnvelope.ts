/**
 * Experimental transport boundary; deliberately NOT connected to live chat.
 * This validates framing, not encryption, authenticity or ratchet negotiation.
 * Only a reviewed crypto provider may supply ciphertext or consume this frame.
 */
export const DM_ENVELOPE_PROTOCOL = 'signal-triple-ratchet' as const;

// Provisional abuse bounds. Confirm against the selected provider before rollout.
export const MAX_DM_CIPHERTEXT_BYTES = 256 * 1024;
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_DM_CIPHERTEXT_BYTES / 3);
// Three bounded ASCII IDs plus ample JSON framing room; also bound parser input.
export const MAX_DM_ENVELOPE_CHARS = MAX_BASE64_CHARS + 3 * 128 + 1024;
const DEVICE_OR_MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FIELDS = ['version', 'protocol', 'clientMessageId', 'senderDeviceId', 'recipientDeviceId', 'ciphertext'];

/** Thalassa framing proposal, not Signal's own wire format. No key material. */
export interface DirectMessageEnvelope {
    readonly version: 1;
    readonly protocol: typeof DM_ENVELOPE_PROTOCOL;
    /** Stable across retries of this logical message; server uniqueness is per recipient device. */
    readonly clientMessageId: string;
    readonly senderDeviceId: string;
    readonly recipientDeviceId: string;
    /** Base64 of provider-produced message bytes, including its protocol headers. */
    readonly ciphertext: string;
}

export class InvalidDirectMessageEnvelopeError extends Error {
    constructor() {
        // Never echo input: malformed frames may contain private text or secrets.
        super('Unsupported or invalid encrypted direct-message envelope');
        this.name = 'InvalidDirectMessageEnvelopeError';
    }
}

function isIdentifier(value: unknown): value is string {
    return typeof value === 'string' && DEVICE_OR_MESSAGE_ID.test(value);
}

function validate(value: unknown): DirectMessageEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidDirectMessageEnvelopeError();
    const frame = value as Record<string, unknown>;
    const keys = Object.keys(frame);
    if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key))) {
        throw new InvalidDirectMessageEnvelopeError();
    }
    if (
        frame.version !== 1 ||
        frame.protocol !== DM_ENVELOPE_PROTOCOL ||
        !isIdentifier(frame.clientMessageId) ||
        !isIdentifier(frame.senderDeviceId) ||
        !isIdentifier(frame.recipientDeviceId) ||
        typeof frame.ciphertext !== 'string' ||
        frame.ciphertext.length === 0 ||
        frame.ciphertext.length > MAX_BASE64_CHARS ||
        !BASE64.test(frame.ciphertext)
    ) {
        throw new InvalidDirectMessageEnvelopeError();
    }
    const bytes = atob(frame.ciphertext);
    if (bytes.length > MAX_DM_CIPHERTEXT_BYTES || btoa(bytes) !== frame.ciphertext) {
        throw new InvalidDirectMessageEnvelopeError();
    }
    // Copy only approved fields. A valid frame is NOT evidence of valid encryption.
    return {
        version: 1,
        protocol: DM_ENVELOPE_PROTOCOL,
        clientMessageId: frame.clientMessageId,
        senderDeviceId: frame.senderDeviceId,
        recipientDeviceId: frame.recipientDeviceId,
        ciphertext: frame.ciphertext,
    };
}

/** No compatibility path accepting legacy message text. */
export function decodeDirectMessageEnvelope(serialized: string): DirectMessageEnvelope {
    if (typeof serialized !== 'string' || serialized.length > MAX_DM_ENVELOPE_CHARS) {
        throw new InvalidDirectMessageEnvelopeError();
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized);
    } catch {
        throw new InvalidDirectMessageEnvelopeError();
    }
    return validate(parsed);
}

/** Reject unexpected plaintext/debug fields instead of silently uploading them. */
export function encodeDirectMessageEnvelope(envelope: DirectMessageEnvelope): string {
    return JSON.stringify(validate(envelope));
}
