import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelPickerSheet } from '../../components/dashboard/ModelPickerSheet';
import BuoyCard from '../../components/map/BuoyCard';
import ObsCreditsRollup from '../../components/map/ObsCreditsRollup';
import { SAT_IR_FULL_COVERAGE } from '../../components/map/satelliteImagery';
import {
    decodeEvidenceIndex,
    decodeEvidencePointer,
    decodeMeasuredBuoy,
} from '../../services/weather/evidenceContract';
import skillPointer from '../../tests/fixtures/weather-evidence141/pointer-skill.txt?raw';
import skillIndex from '../../tests/fixtures/weather-evidence141/index-skill.txt?raw';
import skillDetail from '../../tests/fixtures/weather-evidence141/detail-skill-ndbc.txt?raw';
import buoyPointer from '../../tests/fixtures/weather-evidence141/pointer-buoys.txt?raw';
import buoyIndex from '../../tests/fixtures/weather-evidence141/index-buoys.txt?raw';
import buoyDetail from '../../tests/fixtures/weather-evidence141/detail-buoys-qld-des.txt?raw';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
const params = new URLSearchParams(location.search);
const point = JSON.parse(skillPointer);
const index = JSON.parse(skillIndex);
const detail = JSON.parse(skillDetail);
const near = index.stations.find((row: { key: string }) => row.key === detail.key);
Object.defineProperty(Date, 'now', { value: () => point.generatedAt * 1000 + 1000 });
let requests = 0;
window.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const body = path.endsWith('/skill/issued-v1/latest.json')
        ? skillPointer
        : path.endsWith(`/${point.generation}/index.json`)
          ? skillIndex
          : path.endsWith(`/${near.detailSha256}.json`)
            ? skillDetail
            : null;
    if (body) {
        requests++;
        document.documentElement.dataset.evidenceReads = String(requests);
    }
    return new Response(body ?? 'Synthetic fixture: network disabled', {
        status: body ? 200 : 503,
        headers: { 'Content-Type': 'application/json' },
    });
};
const bp = JSON.parse(buoyPointer);
const bi = decodeEvidenceIndex(JSON.parse(buoyIndex), decodeEvidencePointer(bp, 'buoys', bp.generatedAt));
const bd = JSON.parse(buoyDetail);
const station = bi.stations.find((row) => row.key === bd.key)!;
const measured = decodeMeasuredBuoy(bd, station, bi.generatedAt);
document.documentElement.dataset.evidenceReads = '0';
document.documentElement.style.fontSize = params.get('large') === '1' ? '20.8px' : '16px';
document.body.style.cssText = 'height:100dvh;overflow:hidden;margin:0';
document.getElementById('root')!.style.height = '100%';
function Fixture() {
    const [open, setOpen] = useState(false);
    const buoy = params.get('kind') === 'buoy';
    const credits = params.get('kind') === 'credits';
    return (
        <main className="h-full overflow-hidden bg-slate-950 p-4 text-white">
            <p className="text-xs">Synthetic replay; public institutional fixtures, no account or provider calls.</p>
            {!credits && (
                <button className="min-h-11 px-4" onClick={() => setOpen(true)}>
                    {buoy ? 'Open buoy' : 'Choose forecast model'}
                </button>
            )}
            {credits && (
                <ObsCreditsRollup
                    rain="radar"
                    wind="Own-server atmospheric forecast"
                    cmems={[]}
                    lightning={false}
                    ais={false}
                    onToggleSatellite={() => {}}
                    satellite={{
                        status: 'off',
                        frameTimeMs: null,
                        frameCount: 0,
                        coverage: SAT_IR_FULL_COVERAGE,
                        playing: false,
                        following: false,
                    }}
                    atmosphere={Array.from({ length: 5 }, (_, i) => ({
                        key: String(i),
                        title: `Source ${i + 1}`,
                        warning: false,
                        text: 'Synthetic source credit, original issue and observation times remain attached. Missing measurements are unknown. Coverage is partial. This display supplies no chart, depth, clearance, route or alarm authority. '.repeat(
                            3,
                        ),
                    }))}
                />
            )}
            {!buoy && !credits && (
                <ModelPickerSheet
                    visible={open}
                    currentModel="dwd_icon"
                    coordinates={{ lat: near.lat, lon: near.lon }}
                    onPick={() => {}}
                    onClose={() => setOpen(false)}
                    onRefresh={() => {}}
                />
            )}
            {buoy && open && <BuoyCard station={station} detail={measured} message="" onClose={() => setOpen(false)} />}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
