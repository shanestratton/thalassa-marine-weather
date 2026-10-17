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
    const [model, setModel] = useState<WeatherModel>('dwd_icon');
    const [offshore, setOffshore] = useState<OffshoreModel>(resolveOffshoreModel('sg'));
    return (
        <main className="h-full overflow-hidden bg-slate-950 p-4 text-white">
            <button className="min-h-11 px-4" onClick={() => setVisible(true)}>
                Choose forecast model
            </button>
            <output aria-label="Selected model">{params.get('offshore') === '1' ? offshore : model}</output>
            <ModelPickerSheet
                visible={visible}
                currentModel={model}
                onClose={() => setVisible(false)}
                onRefresh={() => {}}
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
