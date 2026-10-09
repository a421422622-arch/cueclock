import { createRoot } from 'react-dom/client';
import { applyHintsPreference } from './components/fields.tsx';
import { App } from './App.tsx';
import './styles.css';
import './design.css';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';

applyHintsPreference();
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
