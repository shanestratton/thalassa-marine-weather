/**
 * Polar truth, in words (build 125, package 125-08).
 *
 *  - The yacht search's tables are GENERATED from length and type
 *    (data/polarDatabase.ts says so): the search no longer credits them to ORC
 *    or a sail designer (gap register #44, polar-library-editor).
 *  - The look-ahead's speed dialog names the polar the HUD sails — the
 *    routers' own, through services/routingPolar — and whether it is scaled.
 *  - The HUD and Plan Your Day read that polar through useRoutingPolar, never
 *    `settings.polarData ?? DEFAULT_CRUISING_POLAR` again.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { YachtDatabaseSearch } from '../components/settings/YachtDatabaseSearch';
import { PassageModelModal } from '../components/passage/PassageModelModal';
import { POLAR_DATABASE } from '../data/polarDatabase';
import { setPassageSpeedPref } from '../stores/passageHudStore';

afterEach(cleanup);

describe('the yacht search says what its polars are', () => {
    it('generated from length and type: never ORC or designer data', () => {
        render(<YachtDatabaseSearch onSelect={vi.fn()} />);
        const credit = screen.getByTestId('yacht-database-credit');
        expect(credit.textContent).toBe(
            `${POLAR_DATABASE.length} boats available • Generated from length and type: not ORC or designer data`,
        );
        expect(credit.textContent).not.toMatch(/Data from ORC|designer estimates/);
    });

    it('the same words with a boat chosen, and in the embedded Vessel Profile form', () => {
        render(<YachtDatabaseSearch onSelect={vi.fn()} selectedModel="Hallberg-Rassy 42" embedded />);
        expect(screen.getByTestId('yacht-database-credit').textContent).toMatch(
            /Generated from length and type: not ORC or designer data$/,
        );
    });
});

describe("the look-ahead's speed dialog names the polar the HUD sails", () => {
    const open = (polar: React.ComponentProps<typeof PassageModelModal>['polar']) => {
        setPassageSpeedPref('polar');
        render(<PassageModelModal visible onClose={vi.fn()} cruiseKts={6.5} isSail polar={polar} />);
        return screen.getByTestId('passage-speed-polar').textContent ?? '';
    };

    it('her own figures: named, unscaled, the polar her routes sail', () => {
        const text = open({ source: 'imported', label: 'Fair Wind 2025.pol (imported)' });
        expect(text).toContain('Fair Wind 2025.pol (imported), unscaled: the polar her routes sail.');
        expect(text).not.toContain('scaled so a fair reaching breeze');
        expect(text).toContain('less than 60% of her 6.5 kn cruising speed');
    });

    it('a learned polar says how much it has learned, and never calls itself both scaled and unscaled', () => {
        const text = open({
            source: 'learned',
            label: 'Learned (10 of 42 cells), the rest from Beneteau Oceanis 38.1 (shape scaled to 6.5 kn)',
        });
        expect(text).toContain(
            'Learned (10 of 42 cells), the rest from Beneteau Oceanis 38.1 (shape scaled to 6.5 kn): the polar her routes sail, her learned speeds as she sailed them.',
        );
        expect(text).not.toContain('unscaled');
        cleanup();
        const generic = open({
            source: 'learned',
            label: 'Learned (10 of 42 cells), the rest from Generic cruising polar',
        });
        expect(generic).toContain(
            'Learned (10 of 42 cells), the rest from Generic cruising polar: the polar her routes sail, her learned speeds as she sailed them.',
        );
    });

    it('a yacht-database shape: its label already says it is scaled', () => {
        const text = open({ source: 'database-scaled', label: 'Beneteau Oceanis 38.1 (shape scaled to 6.5 kn)' });
        expect(text).toContain('Beneteau Oceanis 38.1 (shape scaled to 6.5 kn): the polar her routes sail.');
    });

    it('still learning, on the generic shape: says so, and how it is scaled', () => {
        const text = open({ source: 'default', label: 'Learning (7 of 42 cells), sailing on Generic cruising polar' });
        expect(text).toContain(
            'Learning (7 of 42 cells), sailing on Generic cruising polar, scaled so a fair reaching breeze gives her 6.5 kn.',
        );
    });

    it('no polar chosen: the generic polar, as before', () => {
        const text = open({ source: 'default', label: 'Generic cruising polar' });
        expect(text).toContain('A generic cruising polar, scaled so a fair reaching breeze gives her 6.5 kn.');
        fireEvent.click(screen.getByTestId('passage-speed-cruise'));
    });
});

describe('guard: the HUD and Plan Your Day read the routers’ polar', () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const file of ['components/passage/PassageHudPane.tsx', 'components/dayPlanner/TodaySheet.tsx']) {
        it(`${file} sails useRoutingPolar's polar, not polarData ?? DEFAULT_CRUISING_POLAR`, () => {
            const code = read(file);
            expect(code).toContain('useRoutingPolar(');
            expect(code).toContain('routingSpeedModel(');
            expect(code).not.toMatch(/polarData\s*\?\?\s*DEFAULT_CRUISING_POLAR/);
            expect(code).not.toContain('DEFAULT_CRUISING_POLAR');
        });
    }
});
