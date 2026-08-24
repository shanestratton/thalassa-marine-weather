import React from 'react';
import ReactDOM from 'react-dom/client';
import { FoundingSkippersPage } from './FoundingSkippersPage';
import './founding-skippers.css';

const rootElement = document.getElementById('root');
if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <FoundingSkippersPage />
        </React.StrictMode>,
    );
}
