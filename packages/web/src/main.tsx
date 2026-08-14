import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ToastViewport } from './components/Toasts';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // The SSE stream is the live channel; refetching on every mount would only
      // add noise for a local API.
      refetchOnMount: 'always',
      gcTime: 5 * 60_000,
    },
    mutations: { retry: 0 },
  },
});

/**
 * Marks the document while the tab is in the background so CSS can disable
 * animations there — see the `data-hidden` rule in index.css. Set before the
 * first render so a page that loads in a background tab paints its final state.
 */
function trackVisibility(): void {
  const apply = () => {
    document.documentElement.dataset.hidden = String(document.visibilityState !== 'visible');
  };
  apply();
  document.addEventListener('visibilitychange', apply);
  window.addEventListener('pageshow', apply);
}

trackVisibility();

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <ToastViewport />
    </QueryClientProvider>
  </StrictMode>,
);
