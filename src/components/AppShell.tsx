import { useEffect, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { PRODUCT } from '../brand';
import { Dialog } from './Dialog';
import { downloadTextFile } from '../download';
import { STAGE_LABELS, STAGES } from '../domain/constants';
import { projectDataFilename, serializeProjectDataExport } from '../domain/exportData';
import { routeToHash } from '../router';
import type { Route } from '../router';
import { useAppState, useStore } from '../state/StoreProvider';
import type { SaveStatus } from '../state/store';
import { isRenderJobBusy, useActiveRenderJob } from '../render/renderManager';

const SAVE_LABELS: Record<SaveStatus, string> = {
  clean: 'All changes saved',
  dirty: 'Unsaved changes',
  saved: 'All changes saved',
  error: 'Save failed',
  conflict: 'Newer copy in another tab',
  deleted: 'Deleted in another tab',
};

export function AppShell({ route, children }: { route: Route; children: ReactNode }) {
  const state = useAppState();
  const store = useStore();
  const [discarding, setDiscarding] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<string | null>(null);
  const renderJob = useActiveRenderJob();
  const renderBusy = renderJob !== null && isRenderJobBusy(renderJob.status);
  const active = state.active;

  useEffect(() => {
    if (!renderBusy) return;
    // Reloading or closing the tab discards the in-browser encoder job.
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [renderBusy]);
  const project = active && route.name === 'project' ? active.project : null;
  const saveStatus = active?.saveStatus ?? 'clean';
  const needsAttention =
    active !== null &&
    (active.saveStatus === 'error' ||
      active.saveStatus === 'conflict' ||
      active.saveStatus === 'deleted');

  const rescueDownload = () => {
    if (!active) return;
    downloadTextFile(
      projectDataFilename(active.project),
      serializeProjectDataExport(active.project),
    );
  };

  const saveAsNew = () => {
    if (!active) return;
    const result = store.saveAsNewProject();
    if (!result.ok || !result.id) return;
    // The store now has the copy open, so the route has to follow it.
    window.location.hash = routeToHash({
      name: 'project',
      id: result.id,
      stage: route.name === 'project' ? route.stage : 'brief',
    });
  };

  const discardAndClose = () => {
    setDiscarding(false);
    store.discardActiveEdits();
    window.location.hash = routeToHash({ name: 'dashboard' });
  };

  const handleShellClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!renderBusy || renderJob === null) return;
    if (route.name !== 'project' || route.stage !== 'export') return;
    if (renderJob.projectId !== route.id) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLAnchorElement>('a[href^="#"]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href === routeToHash(route)) return;

    // Leaving is allowed, but never silent: the render keeps running in this tab.
    event.preventDefault();
    setPendingLeave(href);
  };

  return (
    <div className="app-shell" onClick={handleShellClick}>
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark" aria-hidden="true" />
          {PRODUCT.name}
        </a>
        {project ? (
          <span className="topbar-crumb" title={project.title}>
            {project.title}
          </span>
        ) : null}
        <div className="topbar-meta">
          {active ? (
            <span className={`save-dot save-${saveStatus}`} aria-hidden="true" />
          ) : null}
          <span className="save-label" role="status" aria-live="polite">
            {active ? SAVE_LABELS[saveStatus] : 'Projects'}
          </span>
          <span className="chip chip-quiet">Saved on this browser only</span>
        </div>
      </header>

      {!store.storageAvailable ? (
        <div className="save-banner save-banner-error" role="alert">
          <div>
            <strong>Browser storage is unavailable.</strong>
            <p>
              This browser is blocking local storage, so projects cannot be saved or reopened here.
              Nothing will be written anywhere else.
            </p>
          </div>
        </div>
      ) : null}

      {needsAttention && active ? (
        <div className={`save-banner save-banner-${active.saveStatus}`} role="alert">
          <div>
            <strong>
              {active.saveStatus === 'error'
                ? 'Your latest changes are not saved.'
                : active.saveStatus === 'conflict'
                  ? 'A newer copy of this project exists in browser storage.'
                  : 'This project was deleted in another tab.'}
            </strong>
            <p>{active.message}</p>
          </div>
          <div className="row">
            {active.saveStatus === 'conflict' ? (
              <button type="button" className="btn" onClick={() => store.reloadActive()}>
                Discard my edits and reload saved copy
              </button>
            ) : null}
            <button type="button" className="btn" onClick={saveAsNew}>
              Save as a new project
            </button>
            <button type="button" className="btn" onClick={rescueDownload}>
              Export my current project data
            </button>
            {active.saveStatus === 'error' ? (
              <button type="button" className="btn btn-primary" onClick={() => void store.flush()}>
                Try saving again
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => setDiscarding(true)}>
              Discard my edits
            </button>
          </div>
        </div>
      ) : null}

      {project && route.name === 'project' ? (
        <nav className="stage-nav" aria-label="Project stages">
          {STAGES.map((stage) => {
            const current = route.stage === stage;
            return (
              <a
                key={stage}
                className={current ? 'stage-link is-current' : 'stage-link'}
                href={routeToHash({ name: 'project', id: project.id, stage })}
                aria-current={current ? 'page' : undefined}
              >
                {STAGE_LABELS[stage]}
                {stage === 'export' ? <span className="stage-flag">not yet</span> : null}
              </a>
            );
          })}
        </nav>
      ) : null}

      {renderBusy &&
      renderJob !== null &&
      !(route.name === 'project' && route.stage === 'export' && route.id === renderJob.projectId) ? (
        <div className="render-away-banner" role="status">
          <div>
            <strong>Rendering “{renderJob.projectTitle}” in this tab.</strong>
            <p>
              {renderJob.progress.encoded > 0 && renderJob.progress.total > 0
                ? `${renderJob.progress.encoded} of ${renderJob.progress.total} frames encoded (${Math.round(
                    (renderJob.progress.encoded / renderJob.progress.total) * 100,
                  )}%). `
                : 'Preparing frames. '}
              It keeps running when you change screens; Export shows its progress.
            </p>
          </div>
          <a
            className="btn btn-small"
            href={routeToHash({
              name: 'project',
              id: renderJob.projectId,
              stage: 'export',
            })}
          >
            Back to Export
          </a>
        </div>
      ) : null}

      <main className="screen">{children}</main>

      <footer className="app-footer">
        <span>
          {PRODUCT.name} · {PRODUCT.tagline}
        </span>
        <span>Projects are stored in this browser only.</span>
      </footer>

      {pendingLeave ? (
        <Dialog
          title="Rendering in progress"
          description="A silent MP4 is still encoding in this tab. It keeps running if you leave this screen, and Export will show its progress when you return. Leave this screen now?"
          onDismiss={() => setPendingLeave(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setPendingLeave(null)}>
                Stay on Export
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const href = pendingLeave;
                  setPendingLeave(null);
                  if (href) window.location.hash = href;
                }}
              >
                Leave screen
              </button>
            </>
          }
        />
      ) : null}

      {discarding && active ? (
        <Dialog
          title="Close without saving?"
          description="The open copy in this tab is forgotten. Anything already saved in this browser stays exactly as it is, and nothing else is deleted."
          onDismiss={() => setDiscarding(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setDiscarding(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={discardAndClose}>
                Close without saving
              </button>
            </>
          }
        />
      ) : null}
    </div>
  );
}
