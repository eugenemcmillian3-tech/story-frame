import { useEffect } from 'react';
import { PRODUCT } from './brand';
import { AppShell } from './components/AppShell';
import { Panel } from './components/ui';
import type { Route } from './router';
import { BriefScreen } from './screens/BriefScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { ExportScreen } from './screens/ExportScreen';
import { PreviewScreen } from './screens/PreviewScreen';
import { ScriptScreen } from './screens/ScriptScreen';
import { StoryboardScreen } from './screens/StoryboardScreen';
import { useAppState, useHashRoute } from './state/StoreProvider';
import type { ProjectStore } from './state/store';

export function App({ store }: { store: ProjectStore }) {
  const state = useAppState();
  const route = useHashRoute();

  useEffect(() => {
    store.syncRoute(route);
  }, [store, route]);

  useEffect(() => {
    document.title =
      route.name === 'project' && state.active
        ? `${PRODUCT.name} — ${state.active.project.title}`
        : PRODUCT.name;
  }, [route.name, state.active]);

  return (
    <AppShell route={route}>
      {route.name === 'dashboard' ? <DashboardScreen /> : <ProjectStage route={route} />}
    </AppShell>
  );
}

function ProjectStage({ route }: { route: Extract<Route, { name: 'project' }> }) {
  const state = useAppState();

  if (state.openError) {
    return (
      <Panel title="This project cannot be opened">
        <p className="muted">{state.openError}</p>
        <p className="muted-small">
          Nothing was overwritten. You can go back to the project list and remove the unreadable
          record from this browser if you no longer need it.
        </p>
        <div className="row">
          <a className="btn" href="#/">
            Back to projects
          </a>
        </div>
      </Panel>
    );
  }

  const active = state.active;
  if (!active || active.project.id !== route.id) {
    return <p className="muted">Opening project…</p>;
  }

  const project = active.project;
  switch (route.stage) {
    case 'brief':
      return <BriefScreen key={project.id} project={project} />;
    case 'script':
      return <ScriptScreen project={project} />;
    case 'storyboard':
      return <StoryboardScreen project={project} />;
    case 'preview':
      return <PreviewScreen project={project} />;
    case 'export':
      return <ExportScreen project={project} />;
    default:
      return null;
  }
}
