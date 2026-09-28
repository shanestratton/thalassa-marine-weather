import { describe, expect, it } from 'vitest';
import { ENC_DELIVERY_MAX_TEXT, parseEncChartDelivery } from '../services/encChartDelivery';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const first = 'https://charts.example/private-token-one/download';
const second = 'https://charts.example/private-token-two/download';
const actualLayout = (url: string, chart: string, checksum?: string, envelope = 'Hi Test Skipper,') =>
    `${envelope}\n\nYour chart has been successfully processed.\n\nDownload link\n\n${url}\n\nOrder reference: TEST-ORDER\nChart: ${chart}\nSystem: TEST-SYSTEM\nFile size: 100 MB\n${checksum ? `SHA256: ${checksum}\n` : ''}\nThanks,\nChart shop\nhttps://charts.example/`;

describe('local chart delivery parsing', () => {
    it('accepts a single copied delivery body beginning at Download link', () => {
        const result = parseEncChartDelivery(
            `Download link\n\n${first}\n\nOrder reference: TEST-ORDER\nChart: New Caledonia2026\nSystem: TEST-SYSTEM\nFile size: 100 MB\nSHA256: ${digestA}`,
        );
        expect(result.errors).toEqual([]);
        expect(result.packages).toEqual([{ url: first, label: 'New Caledonia2026', expectedSha256: digestA }]);
    });
    it.each([false, true])(
        'binds the following Chart title and optional rendered-email checksum to the preceding URL (checksum: %s)',
        (withChecksum) => {
            const result = parseEncChartDelivery(
                actualLayout(first, 'New Caledonia2026', withChecksum ? digestA : undefined),
            );
            expect(result.errors).toEqual([]);
            expect(result.packages).toEqual([
                { url: first, label: 'New Caledonia2026', ...(withChecksum ? { expectedSha256: digestA } : {}) },
            ]);
        },
    );

    it.each([
        'Hi Test Skipper,',
        'Chart successfully processed',
        'From: Chart shop\nSubject: Chart successfully processed',
    ])('separates two concatenated actual-layout deliveries by %s', (envelope) => {
        const result = parseEncChartDelivery(
            [
                actualLayout(first, 'New Caledonia2026', digestA, envelope),
                actualLayout(second, 'Test Islands2026', digestB, envelope),
            ].join('\n\n'),
        );
        expect(result.errors).toEqual([]);
        expect(result.packages).toEqual([
            { url: first, label: 'New Caledonia2026', expectedSha256: digestA },
            { url: second, label: 'Test Islands2026', expectedSha256: digestB },
        ]);
    });

    it('accepts two concatenated actual plaintext emails without inventing a checksum', () => {
        const result = parseEncChartDelivery(
            `${actualLayout(first, 'New Caledonia2026')}\n\n${actualLayout(second, 'Test Islands2026')}`,
        );
        expect(result.errors).toEqual([]);
        expect(result.packages).toEqual([
            { url: first, label: 'New Caledonia2026' },
            { url: second, label: 'Test Islands2026' },
        ]);
    });

    it('handles HTML email fields and greetings without cutting Chart metadata away from its preceding href', () => {
        const html = (url: string, title: string, digest: string) =>
            `<div><p>Hi Test Skipper,</p><p>Chart successfully processed</p><p>Download link</p><p><a href="${url}">${url}</a></p><table><tr><td>Order reference:</td><td>TEST-ORDER</td></tr><tr><td><strong>Chart:</strong></td><td>${title}</td></tr><tr><td>System:</td><td>TEST-SYSTEM</td></tr><tr><td>SHA256:</td><td>${digest}</td></tr></table></div>`;
        const result = parseEncChartDelivery(
            `${html(first, 'New Caledonia2026', digestA)}\n${html(second, 'Test Islands2026', digestB)}`,
        );
        expect(result.errors).toEqual([]);
        expect(result.packages).toEqual([
            { url: first, label: 'New Caledonia2026', expectedSha256: digestA },
            { url: second, label: 'Test Islands2026', expectedSha256: digestB },
        ]);
    });

    it('does not use Chart metadata alone to guess which of two download links owns a checksum', () => {
        const result = parseEncChartDelivery(
            `Download link\n\n${first}\n\n${second}\n\nChart: Unclear delivery\nSystem: TEST-SYSTEM\nSHA256: ${digestA}`,
        );
        expect(result.packages).toEqual([]);
        expect(result.errors.join(' ')).toMatch(/cannot be matched safely/);
    });

    it('accepts two full plain-text o-charts-style deliveries without requiring checksums', () => {
        const result = parseEncChartDelivery(
            `From: Chart shop\nSubject: Chart ready\n\nChart: Test Coast\nYour download is ready:\n${first}\n\nHelp: https://charts.example/help\n\nFrom: Chart shop\nSubject: Update ready\n\nChart: Test Islands\n${second}\nShop: https://charts.example/`,
        );
        expect(result.errors).toEqual([]);
        expect(result.packages).toEqual([
            { url: first, label: 'Test Coast' },
            { url: second, label: 'Test Islands' },
        ]);
    });

    it('accepts direct links, preserves signed queries and keeps secrets out of labels', () => {
        const url = 'https://charts.example/private/path/test-coast.zip?token=private-token&signature=secret';
        const result = parseEncChartDelivery(url);
        expect(result.errors).toEqual([]);
        expect(result.packages[0]).toMatchObject({ url, filename: 'test-coast.zip' });
        expect(result.packages[0].label).not.toMatch(/private|token|secret|charts\.example/);
    });

    it('leaves opaque download filenames unset and hides token-like archive names', () => {
        const result = parseEncChartDelivery(`${first}\nhttps://charts.example/${'abcdef12'.repeat(8)}.zip`);
        expect(result.packages.map((entry) => entry.filename)).toEqual([undefined, undefined]);
        expect(result.packages.map((entry) => entry.label)).toEqual(['Chart package 1', 'Chart package 2']);
    });

    it('uses a generic label for an unsafe email title', () => {
        const result = parseEncChartDelivery(`Chart: https://private.example/token\n${first}`);
        expect(result.packages[0].label).toBe('Chart package 1');
    });

    it('extracts a single email checksum across blank lines and normalizes hexadecimal case', () => {
        const result = parseEncChartDelivery(`Chart: Test Coast\n${first}\n\nSHA-256:\n${digestA.toUpperCase()}`);
        expect(result.errors).toEqual([]);
        expect(result.packages[0].expectedSha256).toBe(digestA);
    });

    it('pairs two separate URL/checksum blocks without guessing from a hash list', () => {
        const result = parseEncChartDelivery(`${first}\nSHA256: ${digestA}\n\n${second}\nSHA256: ${digestB}`);
        expect(result.errors).toEqual([]);
        expect(result.packages.map((entry) => entry.expectedSha256)).toEqual([digestA, digestB]);
    });

    it('pairs checksums explicitly naming archive files regardless of their order', () => {
        const result = parseEncChartDelivery(
            `https://charts.example/coast.zip\nhttps://charts.example/islands.zip\n\nSHA256 (islands.zip) = ${digestB}\n${digestA}  coast.zip`,
        );
        expect(result.errors).toEqual([]);
        expect(result.packages.map((entry) => entry.expectedSha256)).toEqual([digestA, digestB]);
    });

    it('handles pasted HTML hrefs, entity separators and duplicate visible links', () => {
        const result = parseEncChartDelivery(
            `<p><a href="${first}?a=1&amp;token=secret">${first}?a=1&amp;token=secret</a></p><p>SHA256: ${digestA}</p>`,
        );
        expect(result.errors).toEqual([]);
        expect(result.packages).toHaveLength(1);
        expect(result.packages[0].url).toBe(`${first}?a=1&token=secret`);
        expect(result.packages[0].expectedSha256).toBe(digestA);
    });

    it('does not mistake a hexadecimal URL token for a checksum', () => {
        const result = parseEncChartDelivery(`${first}?key=${digestA}`);
        expect(result.packages[0].expectedSha256).toBeUndefined();
    });

    it('preserves signed query punctuation and accepts surrounding prose brackets', () => {
        const url = `${first}?signature=signed.value;`;
        expect(parseEncChartDelivery(url).packages[0].url).toBe(url);
        expect(parseEncChartDelivery(`(${url})`).packages[0].url).toBe(url);
    });

    it.each([
        `${first}\n${second}\n\nSHA256: ${digestA}\nSHA256: ${digestB}`,
        `${first}\nSHA256: ${digestA}\nSHA256: ${digestB}`,
        `${first}\nSHA256: abc123`,
        `${first}\nSHA256: ${'a'.repeat(63)}`,
        `${first}\nSHA256: ${'a'.repeat(65)}`,
        `${first}\nSHA256: ${digestA}\nSHA256: incomplete`,
        `https://charts.example/coast.zip\nSHA256 (islands.zip) = ${digestB}`,
    ])('fails closed for ambiguous, conflicting or malformed supplied digests', (text) => {
        const result = parseEncChartDelivery(text);
        expect(result.packages).toEqual([]);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.join(' ')).not.toContain('private-token');
    });

    it('deduplicates repeated links before enforcing the four-package bound', () => {
        expect(parseEncChartDelivery(Array(6).fill(first).join('\n')).packages).toHaveLength(1);
        const four = Array.from({ length: 4 }, (_, index) => `https://charts.example/package-${index}.zip`);
        expect(parseEncChartDelivery(four.join('\n')).packages).toHaveLength(4);
        expect(parseEncChartDelivery([...four, second].join('\n')).packages).toEqual([]);
    });

    it.each([
        'ftp://charts.example/secret.zip',
        'file:///secret.zip',
        'javascript:alert(1)',
        'https://username:private-password@charts.example/package.zip',
        'https://username@charts.example/package.zip',
        'https://charts.example/%ZZ.zip',
        'https://',
        '',
    ])('rejects unsupported or invalid input with non-secret diagnostics', (text) => {
        const result = parseEncChartDelivery(text);
        expect(result.packages).toEqual([]);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.join(' ')).not.toMatch(/private-password|charts\.example|secret\.zip/);
    });

    it('bounds pasted text and individual links', () => {
        expect(parseEncChartDelivery('a'.repeat(ENC_DELIVERY_MAX_TEXT + 1)).packages).toEqual([]);
        expect(parseEncChartDelivery(`${first}?token=${'x'.repeat(4096)}`).packages).toEqual([]);
    });
});
