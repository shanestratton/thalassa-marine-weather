/**
 * The Preferences switch for the chart's passage strip — off by default.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { PassageStripSection } from '../components/settings/PassageStripSection';
import { __resetPassageHudForTests, isPassageHudEnabled } from '../stores/passageHudStore';

beforeEach(() => {
    localStorage.clear();
    __resetPassageHudForTests();
});
afterEach(cleanup);

describe('Settings → Preferences → Passage strip on the chart', () => {
    it('starts off, turns on with a tap, and is remembered on the device', () => {
        render(<PassageStripSection />);
        const toggle = screen.getByRole('switch', { name: 'Passage strip on the chart' });
        expect(toggle.getAttribute('aria-checked')).toBe('false');
        expect(isPassageHudEnabled()).toBe(false);
        fireEvent.click(toggle);
        expect(isPassageHudEnabled()).toBe(true);
        expect(localStorage.getItem('thalassa_passage_hud_enabled_v1')).toBe('1');
        __resetPassageHudForTests();
        expect(isPassageHudEnabled()).toBe(true);
    });

    it('says where it is not shown, so nobody hunts for it in landscape', () => {
        render(<PassageStripSection />);
        expect(
            screen.getByText(/Not shown in landscape on a phone, while planning, or while a storm card is up/),
        ).toBeTruthy();
    });
});
