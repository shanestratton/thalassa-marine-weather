import React from 'react';
import ReactDOM from 'react-dom/client';
import ThalassaDashboard from './ThalassaDashboard';

const rootElement = document.getElementById('root');
if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <ThalassaDashboard />
        </React.StrictMode>,
    );
}
