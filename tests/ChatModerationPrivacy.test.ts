import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat moderation privacy boundary', () => {
    it('does not export private direct-message content to automatic AI moderation', () => {
        const source = readFileSync(resolve(process.cwd(), 'services/ChatService.ts'), 'utf8');
        const start = source.indexOf('private async sendDMForScope');
        const end = source.indexOf('// ─── PIN DROPS', start);
        const directMessageSendPath = source.slice(start, end);

        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        expect(directMessageSendPath).not.toContain('moderateMessage(');
    });

    it('keeps user reports on the moderator-review path rather than re-exporting reported text', () => {
        const source = readFileSync(resolve(process.cwd(), 'components/ChatPage.tsx'), 'utf8');
        const start = source.indexOf('const handleReport');
        const end = source.indexOf('// Proposals, private channels', start);
        const reportPath = source.slice(start, end);

        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        expect(reportPath).toContain('reportMessage(');
        expect(reportPath).not.toContain('moderateMessage(');
    });
});
