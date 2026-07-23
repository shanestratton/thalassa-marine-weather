import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_CHAT_MESSAGE_CHARS, normalizeChatMessage } from '../services/chat/messagePolicy';

describe('chat message payload policy', () => {
    it('normalizes ordinary content and rejects blank, null, and oversized payloads', () => {
        expect(normalizeChatMessage('  Fair winds  ')).toBe('Fair winds');
        expect(normalizeChatMessage('e\u0301')).toBe('é');
        expect(normalizeChatMessage(' \n\t ')).toBeNull();
        expect(normalizeChatMessage(`safe\u0000hidden`)).toBeNull();
        expect(normalizeChatMessage('x'.repeat(MAX_CHAT_MESSAGE_CHARS))).toHaveLength(MAX_CHAT_MESSAGE_CHARS);
        expect(normalizeChatMessage('x'.repeat(MAX_CHAT_MESSAGE_CHARS + 1))).toBeNull();
    });

    it('pins the same bounds into channel and direct-message database policies', () => {
        const migration = readFileSync(
            resolve(process.cwd(), 'supabase/migrations/20260724091000_chat_payload_bounds.sql'),
            'utf8',
        );
        expect(migration.match(/char_length\(message\) BETWEEN 1 AND 4000/g)).toHaveLength(4);
        expect(migration.match(/char_length\((?:display_name|sender_name)\) BETWEEN 1 AND 120/g)).toHaveLength(4);
        expect(migration).toContain('chat_messages_message_length');
        expect(migration).toContain('chat_direct_messages_message_length');
    });
});
