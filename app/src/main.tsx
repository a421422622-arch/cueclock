import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import './design.css';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';

createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
