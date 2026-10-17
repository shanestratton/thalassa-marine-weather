import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelComparisonMatrix } from '../../components/dashboard/ModelComparisonMatrix';
import { reduceEnsemble } from '../../utils/ensembleForecast';
import { ensembleFixture, ENSEMBLE_FIXTURE_NOW } from '../../tests/fixtures/ensemble142';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
Object.defineProperty(Date, 'now', { value: () => ENSEMBLE_FIXTURE_NOW });
document.documentElement.style.fontSize = new URLSearchParams(location.search).get('scale') === '130' ? '130%' : '100%';
document.body.style.cssText = 'height:100dvh;overflow:hidden;margin:0';
document.getElementById('root')!.style.height = '100%';
document.documentElement.dataset.ensembleReads = '0';
window.fetch = async (input, init) => {
    if (String(input).endsWith('/functions/v1/ensemble-forecast')) {
        const request = JSON.parse(String(init?.body));
        document.documentElement.dataset.ensembleReads = String(
            Number(document.documentElement.dataset.ensembleReads) + 1,
        );
        return new Response(
            JSON.stringify(
                reduceEnsemble(
                    ensembleFixture(),
                    request.product,
                    request.latitude,
                    request.longitude,
                    ENSEMBLE_FIXTURE_NOW,
                    'a'.repeat(64),
                ),
            ),
            { headers: { 'Content-Type': 'application/json' } },
        );
    }
    return new Response('Fictional fixture: external traffic disabled', { status: 503 });
};
function Fixture() {
    const [open, setOpen] = useState(true);
    return (
        <main style={{ height: '100%', overflow: 'hidden', background: '#020617' }}>
            <p className="text-xs text-white">Fictional members; no provider/account acceptance.</p>
            <ModelComparisonMatrix
                visible={open}
                onClose={() => setOpen(false)}
                selectedModel="ecmwf_ifs025"
                coordinates={{ lat: -27, lon: 153 }}
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
