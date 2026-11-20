import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/App';
import { createProject } from '../src/domain/project';
import { createSampleProject } from '../src/domain/sample';
import { addScene, updateScene } from '../src/domain/storyboard';
import type { Project } from '../src/domain/types';
import { getAssets, getLatestRender, putRender } from '../src/media/mediaDb';
import type { MediaAssetRecord } from '../src/media/mediaDb';
import { ProjectRepository } from '../src/persistence/projectRepository';
import { RenderCanceledError } from '../src/render/mp4';
import {
  cancelRenderJob,
  getActiveRenderJob,
  getRenderJob,
  isRenderJobBusy,
  startRenderJob,
  useRenderJob,
} from '../src/render/renderManager';
import type { RenderJobState } from '../src/render/renderManager';
import { renderSnapshotToMp4 } from '../src/render/runRender';
import { StoreProvider } from '../src/state/StoreProvider';
import { ProjectStore } from '../src/state/store';
import { MemoryStorage } from './helpers';

// Keep every real media export; only control the image read, the latest-render
// lookup, and render storage, so jobs stay active without WebCodecs.
vi.mock('../src/media/mediaDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/media/mediaDb')>();
  return { ...actual, getAssets: vi.fn(), getLatestRender: vi.fn(), putRender: vi.fn() };
});
vi.mock('../src/render/runRender', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/render/runRender')>();
  return { ...actual, renderSnapshotToMp4: vi.fn() };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function holdAssets(): Deferred<Map<string, MediaAssetRecord>> {
  const assets = deferred<Map<string, MediaAssetRecord>>();
  vi.mocked(getAssets).mockReturnValue(assets.promise);
  return assets;
}

/** Cancel whichever job is active, release its media read, and wait for cleanup. */
async function finishRender(assets: Deferred<Map<string, MediaAssetRecord>>): Promise<void> {
  const active = getActiveRenderJob();
  if (active) cancelRenderJob(active.projectId);
  assets.resolve(new Map());
  await waitFor(() => expect(getActiveRenderJob()).toBeNull());
}

function board(): Project {
  const now = '2026-01-01T00:00:00.000Z';
  let project = addScene(
    createProject(
      {
        title: 'Manager regression test',
        mode: 'factual',
        targetDuration: 60,
        visualPreset: 'clean-educational',
      },
      { now, id: 'prj_manager_test' },
    ),
    { title: 'One', plannedDuration: 2, onScreenText: 'One' },
    now,
  );
  project = updateScene(project, project.storyboard.scenes[0].id, { imageAssetId: 'img_one' }, now);
  return project;
}

function JobProbe({
  projectId,
  observed,
}: {
  projectId: string;
  observed: { job: RenderJobState | null };
}) {
  const job = useRenderJob(projectId);
  useEffect(() => {
    observed.job = job;
  }, [job, observed]);
  return null;
}

function seedProject(storage: MemoryStorage, project: Project): string {
  const created = new ProjectRepository(storage).create(project);
  if (!created.ok) throw new Error(created.message);
  return created.project.id;
}

function renderApp(storage: MemoryStorage, hash: string) {
  window.location.hash = hash;
  const repository = new ProjectRepository(storage);
  const store = new ProjectStore(repository, { autosave: false });
  render(
    <StoreProvider store={store}>
      <App store={store} />
    </StoreProvider>,
  );
}

async function startExportRender(storage: MemoryStorage, projectId: string): Promise<void> {
  renderApp(storage, `#/projects/${projectId}/export`);
  const button = await screen.findByRole('button', { name: 'Render silent MP4' });
  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveProperty('disabled', true));
}

async function leaveExportForDashboard(): Promise<void> {
  fireEvent.click(screen.getByRole('link', { name: 'StoryFrame' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Leave screen' }));
}

function assetFor(projectId: string): MediaAssetRecord {
  return {
    id: 'img_one',
    projectId,
    name: 'one.png',
    mimeType: 'image/png',
    byteSize: 1024,
    width: 1080,
    height: 1920,
    createdAt: '2026-01-01T00:00:00.000Z',
    blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
  };
}

afterEach(() => {
  cleanup();
  window.location.hash = '#/';
});

describe('render job manager', () => {
  it('refuses a second start and keeps the same job across unmount/remount', async () => {
    const project = board();
    const assets = holdAssets();

    try {
      expect(startRenderJob(project).ok).toBe(true);
      const active = getActiveRenderJob();
      expect(active?.projectId).toBe(project.id);
      expect(active !== null && isRenderJobBusy(active.status)).toBe(true);
      const startedAt = active?.startedAt;

      const second = startRenderJob(project);
      expect(second.ok).toBe(false);
      expect(second.message).toContain('A render is already running');
      expect(getActiveRenderJob()?.startedAt).toBe(startedAt);

      // Leaving Export unmounts its subscription; returning mounts it again.
      const observed: { job: RenderJobState | null } = { job: null };
      const away = render(<JobProbe projectId={project.id} observed={observed} />);
      expect(observed.job?.startedAt).toBe(startedAt);
      away.unmount();

      expect(getRenderJob(project.id)?.startedAt).toBe(startedAt);
      const afterLeaving = getActiveRenderJob();
      expect(afterLeaving !== null && isRenderJobBusy(afterLeaving.status)).toBe(true);

      const back = render(<JobProbe projectId={project.id} observed={observed} />);
      expect(observed.job?.startedAt).toBe(startedAt);
      back.unmount();

      expect(startRenderJob(project).ok).toBe(false);
      expect(getActiveRenderJob()?.startedAt).toBe(startedAt);
    } finally {
      await finishRender(assets);
    }
  });
});

describe('render job UI', () => {
  beforeEach(() => {
    vi.mocked(getLatestRender).mockResolvedValue(null);
  });

  it('keeps the active job across leaving Export and blocks a duplicate start', async () => {
    const storage = new MemoryStorage();
    const projectId = seedProject(storage, createSampleProject());
    const assets = holdAssets();

    try {
      await startExportRender(storage, projectId);
      const started = getActiveRenderJob();
      expect(started?.projectId).toBe(projectId);

      fireEvent.click(screen.getByRole('link', { name: 'Storyboard' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Rendering in progress')).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Leave screen' }));

      expect(await screen.findByText(/Rendering “/)).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(getActiveRenderJob()?.startedAt).toBe(started?.startedAt);

      fireEvent.click(screen.getByRole('link', { name: 'Back to Export' }));
      expect(await screen.findByRole('heading', { name: 'Export', level: 1 })).toBeTruthy();

      const returnedButton = screen.getByRole('button', { name: 'Render silent MP4' });
      expect(returnedButton).toHaveProperty('disabled', true);
      expect(screen.getByRole('button', { name: 'Cancel render' })).toBeTruthy();
      expect(
        screen.getByText(/Validating project…|Preparing images…|Rendering frames…/),
      ).toBeTruthy();
      expect(getActiveRenderJob()?.startedAt).toBe(started?.startedAt);

      fireEvent.click(returnedButton);
      expect(getActiveRenderJob()?.startedAt).toBe(started?.startedAt);
    } finally {
      await finishRender(assets);
    }
  });

  it('cancels the job and stores no render when its project is deleted mid-render', async () => {
    const storage = new MemoryStorage();
    const projectId = seedProject(storage, board());
    const assets = holdAssets();

    try {
      await startExportRender(storage, projectId);
      expect(getActiveRenderJob()?.projectId).toBe(projectId);

      await leaveExportForDashboard();
      expect(await screen.findByRole('heading', { name: 'Projects', level: 1 })).toBeTruthy();
      const title = await screen.findByRole('heading', { name: 'Manager regression test', level: 2 });
      const card = title.closest('li');
      expect(card).not.toBeNull();
      fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Delete' }));

      const deleteDialog = await screen.findByRole('dialog');
      fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete project' }));
      await waitFor(() => expect(screen.queryByText('Manager regression test')).toBeNull());

      // The delete requested cancellation; release the media read so the job unwinds.
      assets.resolve(new Map());
      await waitFor(() => expect(getActiveRenderJob()).toBeNull());
      expect(getRenderJob(projectId)?.status).toBe('canceled');
      expect(putRender).not.toHaveBeenCalled();
    } finally {
      await finishRender(assets);
    }
  });

  it('keeps frame progress after leaving and returning to Export', async () => {
    const storage = new MemoryStorage();
    const projectId = seedProject(storage, board());

    const assets = deferred<Map<string, MediaAssetRecord>>();
    assets.resolve(new Map([['img_one', assetFor(projectId)]]));
    vi.mocked(getAssets).mockReturnValue(assets.promise);
    vi.mocked(renderSnapshotToMp4).mockImplementation(({ onProgress, signal, snapshot }) => {
      onProgress?.(15, snapshot.totalFrames);
      return new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new RenderCanceledError());
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });

    try {
      await startExportRender(storage, projectId);
      const total = getActiveRenderJob()?.progress.total ?? 0;
      expect(total).toBeGreaterThan(0);
      const progressText = new RegExp(`15 of ${total} frames encoded`);

      expect(await screen.findByText(progressText)).toBeTruthy();
      const startedAt = getActiveRenderJob()?.startedAt;
      expect(getActiveRenderJob()?.progress).toEqual({ encoded: 15, total });

      await leaveExportForDashboard();
      expect(await screen.findByText(progressText)).toBeTruthy();
      expect(getActiveRenderJob()?.startedAt).toBe(startedAt);
      expect(getActiveRenderJob()?.progress).toEqual({ encoded: 15, total });

      fireEvent.click(screen.getByRole('link', { name: 'Back to Export' }));
      expect(await screen.findByRole('heading', { name: 'Export', level: 1 })).toBeTruthy();
      expect(screen.getByText(progressText)).toBeTruthy();
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('15');
      expect(getActiveRenderJob()?.startedAt).toBe(startedAt);
      expect(getActiveRenderJob()?.progress).toEqual({ encoded: 15, total });
    } finally {
      await finishRender(assets);
    }
  });
});
