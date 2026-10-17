/**
 * A tap on a cyclone push (129-09), in the foreground toast as well as from
 * the lock screen (tests/useAppBootstrap.test.ts), opens the chart, where the
 * storm card names the issuer and links the official centre. App.tsx is too
 * heavy to render here, so its toast routing is read from the source.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('cyclone push taps', () => {
    it('the foreground toast routes both cyclone types to the chart', () => {
        const app = readFileSync('App.tsx', 'utf8');
        const toast = app.slice(app.indexOf('<PushToast'), app.indexOf('/>', app.indexOf('<PushToast')));
        expect(toast).toMatch(/case 'cyclone_notice':\s*case 'cyclone_urgent':\s*setPage\('map'\);\s*break;/);
    });
});
