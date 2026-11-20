import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { parseRoute } from '../router';
import type { Route } from '../router';
import type { AppState, ProjectStore } from './store';

const StoreContext = createContext<ProjectStore | null>(null);

export function StoreProvider({
  store,
  children,
}: {
  store: ProjectStore;
  children: ReactNode;
}) {
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      // A null key means another tab cleared this origin's storage.
      store.notifyStorageEvent(event.key, event.newValue);
    };
    // Ask before leaving a tab that holds edits this browser cannot save
    // (conflict, deletion, full storage). A successful flush needs no prompt.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (store.flushSync().ok) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [store]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): ProjectStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside StoreProvider');
  return store;
}

export function useAppState(): AppState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return route;
}
