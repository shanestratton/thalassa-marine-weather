import React from 'react';
import ReactDOM from 'react-dom/client';
import { FeedbackPage } from './FeedbackPage';
import './feedback.css';

const rootElement = document.getElementById('root');
if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <FeedbackPage />
        </React.StrictMode>,
    );
}
