/**
 * The ENC layer has an off switch — with a writer, and now inside the map-base
 * menu rather than floating on the chart.
 *
 * WHY IT EXISTS. On 2026-09-04 a jetsam report showed
 * com.apple.WebKit.WebContent killed at exactly 2048.0 MB with reason
 * "per-process-limit" — the webview hitting iOS's hard 2 GB ceiling, twice,
 * while the native process sat at 93 MB. That session's flight recorder is
 * dominated by enc:merge-start (9 cells, 25.3 MB per merge) and
 * enc:merge-breathe backing off under pressure. A layer that can allocate at
 * that scale must be switchable off — so a skipper can rescue their own
 * session, and so the layer can be ruled in or out without a rebuild.
 *
 * WHERE IT LIVES. Shane, 2026-09-05: "move the enc button up into that drop
 * down box on the obs page... put it at the bottom after ocean". Two
 * properties have to survive that move, and both are asserted below: it must
 * still be offered when the charts are ALREADY OFF (or it is a one-way door),
 * and it must be reachable by keyboard like every other item in the menu.
 *
 * It is a CHECKBOX, not a fourth radio. Hybrid/Satellite/Ocean are one
 * exclusive choice of raster; ENC is a separate stack drawn above whichever of
 * those is showing. As a menuitemradio it would tell a screen reader that
 * turning charts on turns the base map off.
 */
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapBaseSelector, type MapBaseKind } from '../components/map/MapBaseSelector';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
const hubCode = hub.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function Harness({ encCellCount = 9, startOn = true }: { encCellCount?: number; startOn?: boolean }) {
    const [base, setBase] = useState<MapBaseKind>('hybrid');
    const [enc, setEnc] = useState(startOn);
    return (
        <MapBaseSelector
            visible
            value={base}
            onChange={setBase}
            encCellCount={encCellCount}
            encVisible={enc}
            onToggleEnc={() => setEnc((on) => !on)}
        />
    );
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /^Map base:/ }));

describe('the ENC master switch', () => {
    it('is persisted state with a real writer, not a hardcoded true', () => {
        expect(hubCode).toMatch(/usePersistedState\('thalassa_map_enc_visible', true\)/);
        expect(hubCode).toMatch(/setEncVisible\(\(on\) => !on\)/);
        expect(hubCode).not.toMatch(/const encVisible = true;/);
    });

    it('is wired to the map-base menu, not left floating on the chart', () => {
        const call = hubCode.slice(hubCode.indexOf('<MapBaseSelector'));
        const props = call.slice(0, call.indexOf('/>'));
        expect(props).toContain('encCellCount={encCellCount}');
        expect(props).toContain('encVisible={encVisible}');
        expect(props).toContain('onToggleEnc={() => setEncVisible((on) => !on)}');
        // And the old home no longer carries it.
        const controls = readFileSync('components/map/ChartDepthControls.tsx', 'utf8');
        expect(controls).not.toContain('onToggleEncVisible');
    });

    it('sits at the bottom, after Ocean', () => {
        render(<Harness />);
        openMenu();
        const menu = screen.getByRole('menu', { name: 'Map base' });
        const items = Array.from(menu.querySelectorAll('[role^="menuitem"]'));
        expect(items).toHaveLength(4);
        expect(items[items.length - 2]).toHaveTextContent('Ocean');
        expect(items[items.length - 1]).toHaveAttribute('role', 'menuitemcheckbox');
        expect(items[items.length - 1]).toHaveTextContent('ENC charts');
    });

    it('renders and toggles', () => {
        render(<Harness />);
        openMenu();
        fireEvent.click(screen.getByLabelText('Turn ENC charts off'));
        openMenu();
        expect(screen.getByLabelText('Turn ENC charts on')).toBeInTheDocument();
    });

    it('is STILL offered once the charts are off — or it would be a one-way door', () => {
        render(<Harness startOn={false} />);
        openMenu();
        expect(screen.getByLabelText('Turn ENC charts on')).toBeInTheDocument();
    });

    it('says which state it is in, rather than only what tapping does', () => {
        render(<Harness />);
        openMenu();
        expect(screen.getByRole('menuitemcheckbox')).toHaveTextContent('ON');
        expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(screen.getByLabelText('Turn ENC charts off'));
        openMenu();
        expect(screen.getByRole('menuitemcheckbox')).toHaveTextContent('OFF');
        expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'false');
    });

    it('is a checkbox, not a fourth base-map radio', () => {
        render(<Harness />);
        openMenu();
        // Three rasters, one exclusive choice; ENC is not one of them.
        expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
        expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(1);
    });

    it('is reachable with the arrow keys, like every other item', () => {
        // The switch a skipper reaches for under memory pressure must not be
        // the one item keyboard navigation skips. Down from Hybrid (index 0)
        // three times lands on the ENC row.
        render(<Harness />);
        openMenu();
        const menu = screen.getByRole('menu', { name: 'Map base' });
        fireEvent.keyDown(menu, { key: 'ArrowDown' });
        fireEvent.keyDown(menu, { key: 'ArrowDown' });
        fireEvent.keyDown(menu, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox'));
        // And it wraps back round to the first raster rather than sticking.
        fireEvent.keyDown(menu, { key: 'ArrowDown' });
        expect(document.activeElement).toHaveTextContent('Hybrid');
    });

    it('stays out of the way when there are no charts to switch', () => {
        render(<Harness encCellCount={0} />);
        openMenu();
        expect(screen.queryByLabelText(/Turn ENC charts/)).toBeNull();
        expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
    });
});
