/** Real local editor, generated sensor catalogue and simulated keyboard; no providers or boat. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { WakeRulesSection } from '../../components/settings/WakeRulesSection';
import { getAuthIdentityScope, setAuthIdentityScope } from '../../services/authIdentityScope';
import { publishWakeRuleSources } from '../../services/alarms/wakeRuleSources';
import { defaultWakeRules, WAKE_PRESETS } from '../../utils/wakeRule';
import { initGlobalKeyboardScroll } from '../../utils/keyboardScroll';
if (!import.meta.env.DEV) throw Error('Development fixture only');
setAuthIdentityScope('wake137-generated-owner');
const empty = new URLSearchParams(location.search).has('empty');
const publish = () =>
    publishWakeRuleSources(
        getAuthIdentityScope(),
        empty
            ? []
            : defaultWakeRules().map(({ preset }) => ({
                  preset,
                  selection: {
                      feedId: 'pi:generated:verified-vessel',
                      sensorId: `n2k.generated.physical.sender.${'x'.repeat(70)}`,
                      reference: WAKE_PRESETS[preset].reference,
                      ...(preset.startsWith('engine-') || preset === 'battery-below'
                          ? { instance: preset === 'battery-below' ? 'house_bank' : 'main_engine' }
                          : {}),
                  },
                  label: 'Generated physical sender / explicit reference',
                  measuredAt: Date.now(),
              })),
    );
publish();
setInterval(publish, 1000);

const viewport = new EventTarget();
Object.assign(viewport, { height: window.innerHeight, offsetTop: 0, scale: 1 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
window.addEventListener('test:keyboard', ((event: CustomEvent<number>) => {
    Object.assign(viewport, { height: window.innerHeight - event.detail });
    viewport.dispatchEvent(new Event('resize'));
}) as EventListener);
initGlobalKeyboardScroll();
createRoot(document.getElementById('root')!).render(
    <main className="min-h-screen bg-slate-950 p-3 text-white">
        <WakeRulesSection />
    </main>,
);
