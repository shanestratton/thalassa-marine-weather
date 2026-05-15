import React from 'react';
import ReactDOM from 'react-dom/client';
import ThalassaDashboard from './ThalassaDashboard';
import { BandwidthModeProvider } from './bandwidthMode';

const rootElement = document.getElementById('root');
if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <BandwidthModeProvider>
                <ThalassaDashboard />
            </BandwidthModeProvider>
        </React.StrictMode>,
    );
}
