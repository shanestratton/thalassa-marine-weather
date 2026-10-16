import React, { StrictMode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { stageOpenedGpx, peekOpenedGpx } from '../services/openedGpxQueue';
import { GpxImportPage } from '../components/vessel/GpxImportPage';
const calls = vi.hoisted(() => ({ save: vi.fn(), planner: vi.fn(), page: vi.fn() }));
vi.mock('../services/ShipLogService', () => ({ ShipLogService: { importGPXVoyage: calls.save } }));
vi.mock('../context/UIContext', () => ({ useUI: () => ({ setPage: calls.page, previousView: 'vessel' }) }));
vi.mock('../services/passageHandoff', () => ({ stagePassageRequest: calls.planner, requestPassageMode: vi.fn() }));
vi.mock('../components/ui/PageHeader', () => ({ PageHeader: () => <div>Import GPX</div> }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
const XML =
    '<gpx version="1.1"><metadata><name>Private fixture route</name></metadata><rte><rtept lat="30" lon="-60"><name>Start</name></rtept><rtept lat="31" lon="-60"><name>End</name></rtept></rte></gpx>';
beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('preview-a');
});
afterEach(cleanup);
it('keeps an opened file through a StrictMode preview remount without saving or sending it', async () => {
    const scope = setAuthIdentityScope('preview-a');
    stageOpenedGpx(new File([XML], 'opened.gpx'), scope);
    render(
        <StrictMode>
            <GpxImportPage onBack={() => undefined} />
        </StrictMode>,
    );
    expect(await screen.findByRole('button', { name: /Route to Passage Planner/i })).toBeInTheDocument();
    expect(calls.save).not.toHaveBeenCalled();
    expect(calls.planner).not.toHaveBeenCalled();
    expect(peekOpenedGpx()).toBeNull();
});
it('retires an already visible private GPX preview immediately when the account changes', async () => {
    render(<GpxImportPage onBack={() => undefined} />);
    act(() => stageOpenedGpx(new File([XML], 'opened.gpx'), setAuthIdentityScope('preview-a')));
    await screen.findByRole('button', { name: /Route to Passage Planner/i });
    act(() => {
        setAuthIdentityScope('preview-b');
    });
    expect(screen.queryByRole('button', { name: /Route to Passage Planner/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Private fixture route');
    expect(calls.save).not.toHaveBeenCalled();
    expect(calls.planner).not.toHaveBeenCalled();
});
