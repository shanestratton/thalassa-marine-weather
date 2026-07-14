import React from 'react';
import ReactDOM from 'react-dom/client';
import PlanDashboard from './PlanDashboard';

const rootElement = document.getElementById('root');
if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <PlanDashboard />
        </React.StrictMode>,
    );
}
