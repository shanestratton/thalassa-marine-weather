import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import OffshoreComparisonSheet from '../../components/passage/OffshoreComparisonSheet';
import { OFFSHORE_COMPARISON_MODELS } from '../../services/routing/offshoreModelComparison';
import type { OffshoreComparisonView } from '../../components/map/useOffshoreComparison';

if (!import.meta.env.DEV) throw new Error('Development fixture only.');

function Fixture() {
    const [open, setOpen] = useState(true);
    const [selected, setSelected] = useState<string | null>(null);
    const comparison: OffshoreComparisonView = {
        ready: true,
        open,
        busy: false,
        checking: null,
        selected,
        message: null,
        verified: {},
        start: async () => setOpen(true),
        close: () => setOpen(false),
        select: async (id) => setSelected(id),
        rows: OFFSHORE_COMPARISON_MODELS.map((model, index) => ({
            model,
            status: index < 2 ? 'candidate' : 'unavailable',
            message: index < 2 ? undefined : 'Model forecast unavailable.',
            ...(index < 2
                ? {
                      candidate: {
                          verification: 'unverified-public-data' as const,
                          maxWindKts: 24 + index,
                          maxGustKts: index === 0 ? null : 32,
                          upwindPercent: index === 0 ? null : 12,
                          result: {
                              route: [],
                              routeCoordinates: [
                                  [-30, 0],
                                  [-29, 0],
                              ],
                              shallowFlags: [false, false],
                              totalDistanceNM: 1180 + index * 20,
                              totalDurationHours: 180 + index * 12,
                              arrivalTime: '2026-10-24T20:35:00Z',
                              motorHours: index === 0 ? null : 14,
                              isochrones: [],
                          },
                      },
                  }
                : {}),
        })),
    };
    return (
        <div className="fixed inset-0 bg-slate-950 text-white">
            <button type="button" onClick={() => setOpen(true)}>
                Open model comparison
            </button>
            <OffshoreComparisonSheet comparison={comparison} />
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
