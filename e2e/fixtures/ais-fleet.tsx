import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AisCoverageNotice } from '../../components/map/AisCoverageNotice';
import { AisTargetsSheet } from '../../components/map/AisTargetsSheet';
import { normaliseInternetAisFeature } from '../../components/map/useAisStreamLayer';
import { publishAisCoverage } from '../../services/ais/aisCoverage';
import { publishAisTargetPicture } from '../../services/ais/aisTargetCache';
import { useSettingsStore } from '../../stores/settingsStore';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Development fixture only');
// Generated worldwide fixture, with no receiver recording or provider requests.
const stamp = new Date(Date.now() - 6 * 60000).toISOString();
const params = new URLSearchParams(location.search);
const coverage = params.has('held') ? { state: 'held' } : { state: 'recent', polledAt: new Date().toISOString() };
publishAisCoverage(coverage);
useSettingsStore.setState((state) => ({
    settings: {
        ...state.settings,
        aisDisplayFilters: { vesselType: 'all', hideMoored: false, minSpeedKn: 0, source: 'all' },
    },
}));
publishAisTargetPicture(
    params.has('held')
        ? []
        : Array.from(
              { length: 24 },
              (_, i) =>
                  normaliseInternetAisFeature({
                      type: 'Feature',
                      geometry: { type: 'Point', coordinates: [179.5, -17 + i / 100] },
                      properties: {
                          mmsi: i === 0 ? 970111111 : 123456700 + i,
                          name: i === 0 ? 'FICTIONAL RELAYED SART' : `FICTIONAL LONG VESSEL NAME ${i}`,
                          source: 'cloud',
                          dataSource: 'AISHub',
                          informational: true,
                          navStatus: i === 0 ? 14 : 0,
                          sog: 4,
                          cog: 90,
                          updatedAt: stamp,
                      },
                  })!,
          ).filter(Boolean),
);
function Fixture() {
    const [open, setOpen] = useState(false),
        [selected, setSelected] = useState('');
    return (
        <main className="h-screen overflow-hidden bg-slate-900 text-white">
            <div className="absolute left-1/2 top-[62px] z-510 w-[calc(100%-120px)] max-w-[240px] -translate-x-1/2">
                <AisCoverageNotice compact />
            </div>
            <button className="absolute right-3 top-[200px] min-h-[44px] px-3" onClick={() => setOpen(true)}>
                Targets
            </button>
            <p role="status" className="absolute bottom-4">
                {selected}
            </p>
            {open && (
                <AisTargetsSheet
                    onClose={() => setOpen(false)}
                    onSelect={(feature) => {
                        setSelected(`Selected actual MMSI ${feature.properties?.mmsi}`);
                        setOpen(false);
                    }}
                />
            )}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
