import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/reset.css';
import './styles/theme-vars.css';
import './styles/responsive.css';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(<App />);
