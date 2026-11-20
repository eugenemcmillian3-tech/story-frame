import { useSyncExternalStore } from 'react';
import type { Project } from '../domain/types';
import { newId } from '../domain/ids';
import { getAssets, getAudioAssets, pruneRenders, putRender } from '../media/mediaDb';
import type { StoredRenderRecord } from '../media/mediaDb';
import { RenderCanceledError } from './mp4';
import { renderSnapshotToMp4 } from './runRender';
import { buildRenderSnapshot, collectAudioAssetIds, collectImageAssetIds } from './snapshot';
import type { RenderSnapshot } from './snapshot';
import { validateRenderSnapshot } from './validation';
import type { RenderAssetInfo, RenderAudioInfo, SnapshotIssue } from './validation';

export type RenderJobStatus =
  | 'validating'
  | 'preparing'
  | 'rendering'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface RenderJobState {
  projectId: string;
  projectTitle: string;
  status: RenderJobStatus;
  progress: { encoded: number; total: number };
  issues: SnapshotIssue[];
  error: string | null;
  snapshot: RenderSnapshot;
  /** The last stored render for this project, kept visible while a new job runs. */
  record: StoredRenderRecord | null;
  startedAt: string;
  finishedAt: string | null;
}

export const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

const jobs = new Map<string, RenderJobState>();
const listeners = new Set<() => void>();

let activeProjectId: string | null = null;
let activeController: AbortController | null = null;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
let timedOutProjectId: string | null = null;

export function isRenderJobBusy(status: RenderJobStatus): boolean {
  return (
    status === 'validating' ||
    status === 'preparing' ||
    status === 'rendering' ||
    status === 'finalizing'
  );
}

function emit(): void {
  for (const listener of listeners) listener();
}

function patch(projectId: string, changes: Partial<RenderJobState>): void {
  const current = jobs.get(projectId);
  if (!current) return;
  jobs.set(projectId, { ...current, ...changes });
  emit();
}

export function getRenderJob(projectId: string): RenderJobState | null {
  return jobs.get(projectId) ?? null;
}

export function getActiveRenderJob(): RenderJobState | null {
  return activeProjectId ? (jobs.get(activeProjectId) ?? null) : null;
}

export function subscribeRenderJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRenderJob(projectId: string): RenderJobState | null {
  return useSyncExternalStore(
    subscribeRenderJobs,
    () => getRenderJob(projectId),
    () => null,
  );
}

export function useActiveRenderJob(): RenderJobState | null {
  return useSyncExternalStore(subscribeRenderJobs, getActiveRenderJob, () => null);
}

/**
 * Start the one render this tab allows at a time. The job lives in this module,
 * not in a screen, so navigating away neither stops it nor loses its progress.
 * A second start is refused until the active job finishes or is canceled.
 */
export function startRenderJob(
  project: Project,
  options: { acknowledgeNarrationCutoff?: boolean } = {},
): { ok: boolean; message?: string } {
  if (activeProjectId !== null) {
    const active = jobs.get(activeProjectId);
    return {
      ok: false,
      message: `A render is already running${
        active ? ` for “${active.projectTitle}”` : ''
      }. Wait for it to finish or cancel it before starting another.`,
    };
  }

  const snapshot = buildRenderSnapshot(project, undefined, options);
  const previous = jobs.get(project.id);
  const controller = new AbortController();
  activeProjectId = project.id;
  activeController = controller;
  timedOutProjectId = null;

  jobs.set(project.id, {
    projectId: project.id,
    projectTitle: project.title,
    status: 'validating',
    progress: { encoded: 0, total: snapshot.totalFrames },
    issues: [],
    error: null,
    snapshot,
    record: previous?.record ?? null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
  emit();

  timeoutHandle = setTimeout(() => {
    timedOutProjectId = project.id;
    controller.abort();
  }, RENDER_TIMEOUT_MS);

  void executeJob(project.id, snapshot, controller);
  return { ok: true };
}

export function cancelRenderJob(projectId: string): void {
  if (activeProjectId === projectId) activeController?.abort();
}

async function executeJob(
  projectId: string,
  snapshot: RenderSnapshot,
  controller: AbortController,
): Promise<void> {
  try {
    const assetIds = collectImageAssetIds(snapshot);
    const audioAssetIds = collectAudioAssetIds(snapshot);

    patch(projectId, { status: 'preparing' });
    const [assets, audioAssets] = await Promise.all([
      getAssets(assetIds),
      getAudioAssets(audioAssetIds),
    ]);
    if (controller.signal.aborted) throw new RenderCanceledError();

    const assetInfo = new Map<string, RenderAssetInfo>();
    for (const id of assetIds) {
      const asset = assets.get(id);
      if (asset) {
        assetInfo.set(id, {
          id: asset.id,
          mimeType: asset.mimeType,
          width: asset.width,
          height: asset.height,
          byteSize: asset.byteSize,
        });
      }
    }

    const audioAssetInfo = new Map<string, RenderAudioInfo>();
    for (const id of audioAssetIds) {
      const asset = audioAssets.get(id);
      if (asset) {
        audioAssetInfo.set(id, {
          id: asset.id,
          mimeType: asset.mimeType,
          durationMs: asset.durationMs,
          byteSize: asset.byteSize,
        });
      }
    }

    const issues = validateRenderSnapshot(snapshot, assetInfo, audioAssetInfo);
    if (issues.length > 0) {
      patch(projectId, {
        status: 'failed',
        issues,
        error: 'Rendering did not start. Fix the issues above and try again.',
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    const blobs = new Map<string, Blob>();
    for (const [id, asset] of assets) blobs.set(id, asset.blob);
    const audioBlobs = new Map<string, Blob>();
    for (const [id, asset] of audioAssets) audioBlobs.set(id, asset.blob);

    patch(projectId, { status: 'rendering' });
    const encoded = await renderSnapshotToMp4({
      snapshot,
      assets: blobs,
      audioAssets: audioBlobs,
      signal: controller.signal,
      onProgress: (done, total) => patch(projectId, { progress: { encoded: done, total } }),
    });

    patch(projectId, { status: 'finalizing' });
    const record: StoredRenderRecord = {
      id: newId('rnd'),
      projectId,
      snapshot,
      blob: encoded.blob,
      mimeType: encoded.mimeType,
      byteSize: encoded.bytes,
      width: encoded.width,
      height: encoded.height,
      frameCount: encoded.frameCount,
      targetFps: encoded.targetFps,
      verifiedFps: encoded.verifiedFps,
      durationMs: encoded.durationMs,
      createdAt: new Date().toISOString(),
      audio: encoded.audio,
    };
    await putRender(record);
    await pruneRenders(projectId, 3).catch(() => 0);
    patch(projectId, {
      status: 'completed',
      record,
      error: null,
      finishedAt: new Date().toISOString(),
    });
  } catch (reason) {
    if (reason instanceof RenderCanceledError) {
      if (timedOutProjectId === projectId) {
        patch(projectId, {
          status: 'failed',
          error: 'Rendering took longer than 5 minutes and was stopped. No video was saved.',
          finishedAt: new Date().toISOString(),
        });
      } else {
        patch(projectId, {
          status: 'canceled',
          error: 'Rendering was canceled. No video was saved.',
          finishedAt: new Date().toISOString(),
        });
      }
    } else {
      patch(projectId, {
        status: 'failed',
        error: reason instanceof Error ? reason.message : 'Rendering failed.',
        finishedAt: new Date().toISOString(),
      });
    }
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    timedOutProjectId = null;
    activeController = null;
    activeProjectId = null;
    const job = jobs.get(projectId);
    if (job && job.finishedAt === null) {
      jobs.set(projectId, { ...job, finishedAt: new Date().toISOString() });
    }
    emit();
  }
}
