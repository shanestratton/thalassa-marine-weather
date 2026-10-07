/** Dedicated Research page only. The ordinary app never imports this entry. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PrivateMessageResearchApp } from './PrivateMessageResearchApp';
import './style.css';

const element = document.getElementById('root');
if (!element) throw new Error('Private message research interface unavailable');
createRoot(element).render(<PrivateMessageResearchApp />);
