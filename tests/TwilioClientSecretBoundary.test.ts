import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

function clientSourceFiles(relativeRoot: string): string[] {
    const absoluteRoot = join(process.cwd(), relativeRoot);
    const files: string[] = [];

    const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
        }
    };

    walk(absoluteRoot);
    return files;
}

describe('Twilio client-secret boundary', () => {
    it('keeps every Twilio credential and service identifier out of the public Vite environment', () => {
        const boundary = read('scripts/check-client-secrets.mjs');

        expect(boundary).toContain("FORBIDDEN_CLIENT_SECRET_PREFIXES = ['VITE_TWILIO_']");
        expect(boundary).toContain('isForbiddenClientSecretName(name)');
        expect(boundary).toContain('Object.keys(process.env)');

        for (const serverOnlyName of [
            'VITE_TWILIO_ACCOUNT_SID',
            'VITE_TWILIO_API_KEY',
            'VITE_TWILIO_API_KEY_SECRET',
            'VITE_TWILIO_API_KEY_SID',
            'VITE_TWILIO_API_SECRET',
            'VITE_TWILIO_AUTH_TOKEN',
            'VITE_TWILIO_VERIFY_SERVICE_SID',
            'VITE_CREW_PHONE_HMAC_KEY',
        ]) {
            expect(boundary, `${serverOnlyName} must stay behind the Edge-function boundary`).toContain(serverOnlyName);
        }

        for (const rawServerName of [
            'TWILIO_ACCOUNT_SID',
            'TWILIO_API_KEY',
            'TWILIO_API_KEY_SID',
            'TWILIO_API_KEY_SECRET',
            'TWILIO_API_SECRET',
            'TWILIO_AUTH_TOKEN',
            'TWILIO_VERIFY_SERVICE_SID',
            'CREW_PHONE_HMAC_KEY',
        ]) {
            expect(boundary, `${rawServerName} must be rejected from generated client artifacts`).toContain(
                rawServerName,
            );
        }
    });

    it('does not reference Twilio credentials from browser source', () => {
        const browserSources = [
            ...clientSourceFiles('components'),
            ...clientSourceFiles('context'),
            ...clientSourceFiles('hooks'),
            ...clientSourceFiles('pages'),
            ...clientSourceFiles('services'),
            ...clientSourceFiles('stores'),
            join(process.cwd(), 'App.tsx'),
            join(process.cwd(), 'index.tsx'),
        ]
            .map((path) => readFileSync(path, 'utf8'))
            .join('\n');

        expect(browserSources).not.toMatch(/VITE_TWILIO_[A-Z0-9_]+/);
        expect(browserSources).not.toMatch(
            /(?:TWILIO_(?:ACCOUNT_SID|API_KEY|API_KEY_SID|API_KEY_SECRET|API_SECRET|AUTH_TOKEN|VERIFY_SERVICE_SID)|CREW_PHONE_HMAC_KEY)/,
        );
    });
});
