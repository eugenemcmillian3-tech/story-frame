import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PRODUCT } from './brand';
import { ProjectRepository } from './persistence/projectRepository';
import { browserStorage } from './persistence/storage';
import { StoreProvider } from './state/StoreProvider';
import { ProjectStore } from './state/store';
import './styles/global.css';

document.title = PRODUCT.name;

const repository = new ProjectRepository(browserStorage());
const store = new ProjectStore(repository);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element is missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App store={store} />
    </StoreProvider>
  </StrictMode>,
);
