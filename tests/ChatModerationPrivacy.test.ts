import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

function directMessageBody(source: string): string {
    const file = ts.createSourceFile('ChatService.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const methods: ts.MethodDeclaration[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'sendDMForScope')
            methods.push(node);
        ts.forEachChild(node, visit);
    };
    visit(file);
    expect(methods).toHaveLength(1);
    expect(methods[0].body).toBeDefined();
    return methods[0].body!.getText(file);
}

describe('chat moderation privacy boundary', () => {
    it('does not export private direct-message content to automatic AI moderation', () => {
        const source = readFileSync(resolve(process.cwd(), 'services/ChatService.ts'), 'utf8');
        const directMessageSendPath = directMessageBody(source);
        expect(directMessageSendPath).not.toContain('moderateMessage(');
    });

    it('requires the actual complete method and catches a moderation call beyond nested braces', () => {
        expect(() => directMessageBody('class Missing {}')).toThrow();
        const body = directMessageBody(
            'class Fixture { private async sendDMForScope() { if (true) { const nested = {}; } moderateMessage(secret); } }',
        );
        expect(body).toContain('moderateMessage(secret)');
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
