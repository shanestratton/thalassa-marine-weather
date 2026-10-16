import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/weather/modelLiveness', () => ({ isModelLive: () => true, markModelUnavailable: vi.fn() }));
vi.mock('../services/weather/coastalModelSupport', () => ({
    refreshCoastalModelCapabilities: vi.fn(),
    supportedRegionalModel: () => ({
        id: 'ncep_hrrr_conus',
        name: 'HRRR',
        provider: 'NOAA',
        resolutionKm: 3,
        horizonHours: 48,
    }),
}));
import { ModelPickerSheet } from '../components/dashboard/ModelPickerSheet';
import { comparisonModelsFor } from '../services/weather/ModelSpreadService';
describe('coarse publisher coverage does not restrict finer forecast choices', () => {
    it('keeps verified IFS9km and GFS choices visible without storing wx2 aliases', () => {
        const pick = vi.fn();
        render(
            <ModelPickerSheet
                visible
                currentModel="dwd_icon"
                onPick={pick}
                onClose={vi.fn()}
                onRefresh={vi.fn()}
                publishedModels={['wx2:dwd_icon', 'dwd_icon']}
                samplingDescription="Weather from wx at the centre of a 0.25° cell."
            />,
        );
        expect(screen.getByText('Weather from wx at the centre of a 0.25° cell.')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Use the ECMWF 9 km forecast model' })).toBeVisible();
        const gfs = screen.getByRole('button', { name: 'Use the GFS forecast model' });
        expect(gfs).toHaveTextContent('15 days');
        fireEvent.click(gfs);
        expect(pick).toHaveBeenCalledWith('gfs_seamless');
    });
    it('keeps the supported regional comparison and removes duplicate GFS series', () => {
        const ids = comparisonModelsFor(37, -122).map((model) => model.id);
        expect(ids).toContain('ecmwf_ifs');
        expect(ids).toContain('ncep_hrrr_conus');
        expect(ids.filter((id) => id === 'gfs_seamless')).toHaveLength(1);
        expect(ids.every((id) => !id.startsWith('wx2:'))).toBe(true);
    });
});
