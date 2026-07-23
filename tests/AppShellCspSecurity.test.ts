import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const vercel = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as {
    headers: Array<{ headers: Array<{ key: string; value: string }> }>;
};
const deployedCsp = vercel.headers
    .flatMap((entry) => entry.headers)
    .find((header) => header.key.toLowerCase() === 'content-security-policy')?.value;

describe('application shell CSP', () => {
    it('does not permit runtime code generation or a redundant CDN import map', () => {
        expect(indexHtml).not.toContain("'unsafe-eval'");
        expect(indexHtml).not.toContain('type="importmap"');
        expect(indexHtml).not.toContain('https://esm.sh');
        expect(deployedCsp).not.toContain("'unsafe-eval'");
        expect(deployedCsp).not.toContain('https://esm.sh');
    });

    it('does not reconnect the deployed client to server-proxied paid providers', () => {
        expect(deployedCsp).not.toContain('customer-api.open-meteo.com');
        expect(indexHtml).not.toContain('customer-api.open-meteo.com');
        expect(deployedCsp).not.toContain('api.stormglass.io');
        expect(indexHtml).not.toContain('api.stormglass.io');
        expect(deployedCsp).not.toContain('generativelanguage.googleapis.com');
        expect(indexHtml).not.toContain('generativelanguage.googleapis.com');
        expect(deployedCsp).not.toContain('api.spoonacular.com');
        expect(indexHtml).not.toContain('api.spoonacular.com');
        expect(deployedCsp).toContain("object-src 'none'");
    });
});
