/**
 * Settings → System & Cloud says one plain line about charts (126-20).
 *
 * The card used to offer Publish and "Keep new charts published", which sent
 * decrypted licensed charts to the skipper's cloud folder. o-charts says no
 * unencrypted chart data in the cloud, so the card now says where charts live
 * and offers nothing to press. It must not even ask the cloud what is there:
 * no supabase (and the personal-shelf module is gone since 127).
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const cloud = vi.hoisted(() => ({ touched: vi.fn() }));
vi.mock('../services/supabase', () => {
    cloud.touched();
    return {};
});

import { EncPersonalCloudPanel } from '../components/vessel/EncPersonalCloudPanel';

/** What Thalassa itself does, which 126 makes true. Not "never copied to the
 *  cloud": until 127 moves the chart store out of Documents and excludes it
 *  from device backup, iCloud Backup can still copy it, and the card must not
 *  promise what the phone does not yet keep. */
const LINE = "Licensed charts stay on this device and your boat's Pi. Thalassa never uploads them to its servers.";

describe('the charts line in Settings → System & Cloud', () => {
    it('says where licensed charts live, in one plain line', () => {
        render(<EncPersonalCloudPanel />);
        expect(screen.getByText(LINE)).toBeInTheDocument();
    });

    it('promises only what Thalassa does, never that no copy reaches any cloud', () => {
        const { container } = render(<EncPersonalCloudPanel />);
        expect(container.textContent).not.toMatch(/never (copied|stored|backed up)|not in (the|any) cloud/i);
    });

    it('offers no Publish and no Auto-publish, and nothing else to press', () => {
        const { container } = render(<EncPersonalCloudPanel />);
        expect(screen.queryAllByRole('button')).toEqual([]);
        expect(container.querySelectorAll('button, input, [role="switch"]')).toHaveLength(0);
        expect(screen.queryByText(/publish/i)).toBeNull();
        expect(screen.queryByText(/keep new charts/i)).toBeNull();
    });

    it('never loads the cloud client to draw itself, and names no chart shelf module', () => {
        render(<EncPersonalCloudPanel />);
        expect(cloud.touched).not.toHaveBeenCalled();
        const source = readFileSync('components/vessel/EncPersonalCloudPanel.tsx', 'utf8');
        expect(source).not.toMatch(/from '[^']*(personalCellSync|supabase)'/);
        expect(source).not.toMatch(/AutoPublish|getPublishPlan|publishPersonalCells/);
    });
});
