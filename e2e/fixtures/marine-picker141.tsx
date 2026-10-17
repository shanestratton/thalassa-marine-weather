import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelPickerSheet } from '../../components/dashboard/ModelPickerSheet';
import { resolveOffshoreModel } from '../../services/weather/forecastModels';
import type { OffshoreModel, WeatherModel } from '../../types';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
window.fetch = async () => new Response('Fictional fixture: network disabled', { status: 503 });
const params = new URLSearchParams(location.search);
document.documentElement.style.fontSize = params.get('large') === '1' ? '20.8px' : '16px';
document.body.style.cssText = 'height:100dvh;overflow:hidden;margin:0';
document.getElementById('root')!.style.height = '100%';
function Fixture() {
    const [visible, setVisible] = useState(false);
    const regional = params.get('regional') === '1';
    const [model, setModel] = useState<WeatherModel>(regional ? 'best_local' : 'dwd_icon');
    const [offshore, setOffshore] = useState<OffshoreModel>(resolveOffshoreModel('sg'));
    return (
        <main className="h-full overflow-hidden bg-slate-950 p-4 text-white">
            <button className="min-h-11 px-4" onClick={() => setVisible(true)}>
                Choose forecast model
            </button>
            <output aria-label="Selected model">{params.get('offshore') === '1' ? offshore : model}</output>
            {regional && (
                <p>
                    Fictional regional source:{' '}
                    {params.get('state') === 'fallback' ? 'named global fallback' : 'qualified native'}
                </p>
            )}
            <ModelPickerSheet
                visible={visible}
                currentModel={model}
                onClose={() => setVisible(false)}
                onRefresh={() => {}}
                coordinates={regional ? { lat: -20, lon: 166 } : undefined}
                servedTag={
                    regional
                        ? params.get('state') === 'fallback'
                            ? 'om:dwd_icon+marine-v2'
                            : 'arome:thalassa_arome_om_ncaled_025+context+marine-v2'
                        : undefined
                }
                samplingDescription={
                    regional
                        ? params.get('state') === 'fallback'
                            ? 'Local source unavailable; showing ICON. The regional preference is unchanged.'
                            : 'Original 2.5 km AROME sea cell. The forecast ends 48 hours after its original run; absent fields stay unknown. UV/visibility are independent supplements.'
                        : undefined
                }
                onPick={(value) => {
                    setModel(value);
                    setVisible(false);
                }}
                offshore={
                    params.get('offshore') === '1'
                        ? {
                              currentModel: offshore,
                              onPick: (value) => {
                                  setOffshore(value);
                                  setVisible(false);
                              },
                          }
                        : undefined
                }
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
