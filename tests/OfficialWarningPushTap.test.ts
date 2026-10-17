/**
 * A tap on an official warning push (129-06), in the foreground toast as well
 * as from the lock screen (tests/useAppBootstrap.test.ts), opens the Warnings
 * page, which leads with the warning in the issuer's words, and pins the
 * tapped one (tests/OfficialWarningsPage.test.tsx shows it on a page set to
 * another place). App.tsx is too heavy to render here, so its toast routing is
 * read from the source.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushToast, pushForegroundToast } from '../components/PushToast';
import { takeOfficialPushPin } from '../services/officialPushPin';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(async () => undefined),
}));
afterEach(() => {
    cleanup();
    takeOfficialPushPin();
});

describe('official warning push taps', () => {
    it('the foreground toast routes an official warning to the Warnings page', () => {
        const app = readFileSync('App.tsx', 'utf8');
        const toast = app.slice(app.indexOf('<PushToast'), app.indexOf('/>', app.indexOf('<PushToast')));
        expect(toast).toMatch(/case 'official_warning':\s*setPage\('warnings'\);\s*break;/);
    });

    it('the toast has its own style for it, not the forecast weather alert’s', () => {
        const toast = readFileSync('components/PushToast.tsx', 'utf8');
        const style = toast.slice(toast.indexOf('function getToastStyle'));
        expect(style).toMatch(/case 'official_warning':\s*return \{/);
    });

    it('the foreground toast pins the warning it shows, with its words, before routing', () => {
        const onTap = vi.fn();
        render(React.createElement(PushToast, { onTap }));
        act(() =>
            pushForegroundToast({
                title: 'Gale Warning',
                body: 'Gale Warning issued by NWS Zzharbor (fictional)\nWarnings: National Weather Service (NOAA)',
                data: {
                    notification_type: 'official_warning',
                    provider: 'nws',
                    identifier: 'urn:oid:2.49.0.1.840.0.zz0199.001.1',
                    basis: 'phone',
                    event: 'Gale Warning',
                },
            }),
        );
        fireEvent.click(screen.getByText('Gale Warning'));
        expect(onTap).toHaveBeenCalledWith(expect.objectContaining({ notification_type: 'official_warning' }));
        expect(takeOfficialPushPin()).toMatchObject({
            provider: 'nws',
            identifier: 'urn:oid:2.49.0.1.840.0.zz0199.001.1',
            title: 'Gale Warning',
            body: 'Gale Warning issued by NWS Zzharbor (fictional)\nWarnings: National Weather Service (NOAA)',
            basis: 'phone',
        });
    });
});
