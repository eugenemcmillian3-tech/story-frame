import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SignInWithFreebuff, useFreebuffUser } from '@freebuff/auth/react';
import { updateScene } from '../domain/storyboard';
import type { Project, Scene } from '../domain/types';
import {
  cancelImageJob,
  fetchGeneratedImage,
  getImageJob,
  submitImageJob,
} from '../images/api';
import type { ImageJobStatus, ImageJobView } from '../images/api';
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  IMAGE_PROVIDER_LABELS,
  IMAGE_STYLES,
  MAX_PROMPT_CHARS,
  buildSceneImagePrompt,
  imageModel,
  styleById,
} from '../images/provider';
import type { ImageModelId, ImageModelSpec, ImageStyleId } from '../images/provider';
import { deleteAsset } from '../media/mediaDb';
import { storeGeneratedSceneImage } from '../media/imageAssets';
import { Badge, Panel, SelectField, TextAreaField } from './ui';
import { Dialog } from './Dialog';

const MAX_BATCH = 4;
const POLL_INTERVAL_MS = 2_500;
const JOB_TIMEOUT_MS = 8 * 60_000;

type RunStatus = ImageJobStatus | 'timed_out';

interface SceneRun {
  jobId: string;
  sceneId: string;
  status: RunStatus;
  prompt: string;
  style: string;
  modelId: ImageModelId;
  model: string;
  provider: string;
  startedAt: number;
  width: number;
  height: number;
  inferenceSeconds: number | null;
  providerCreditCost: number | null;
  preview: { blob: Blob; url: string } | null;
  error: string | null;
}

function requestId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `ij_${cryptoApi.randomUUID()}`;
  }
  return `ij_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isTerminal(status: RunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timed_out'
  );
}

function runLabel(status: RunStatus): string {
  if (status === 'submitting') return 'Submitting';
  if (status === 'queued') return 'Queued at provider';
  if (status === 'in_progress') return 'Generating';
  if (status === 'completed') return 'Ready to review';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'timed_out') return 'Still running';
  return 'Failed';
}

function runTone(status: RunStatus): 'ok' | 'warn' | 'danger' | 'neutral' | 'accent' {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'neutral';
  if (status === 'timed_out') return 'warn';
  return 'accent';
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Something went wrong. Nothing was attached.';
}

function usd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

/** What spending on this model means, before the user confirms it. */
function costLine(spec: ImageModelSpec, count: number): string {
  if (spec.usdEstimate !== null) {
    return `${count} image${count === 1 ? '' : 's'} at about ${usd(spec.usdEstimate)} each (~${usd(
      spec.usdEstimate * count,
    )}), the published Workers AI list price before the account's free daily allowance, its plan and taxes.`;
  }
  return `${count} image${count === 1 ? '' : 's'} on ${spec.label}. Leonardo publishes no fixed per-image price: each generation draws from the API balance, and the API credit cost it reports is recorded with the image. Taxes are not included.`;
}

export function SceneImageGenerator({
  project,
  scenes,
  initialSceneId,
  onRun,
  onCleanupMedia,
}: {
  project: Project;
  scenes: Scene[];
  initialSceneId: string | null;
  onRun: (mutator: (current: Project) => Project) => boolean;
  onCleanupMedia: () => void;
}) {
  return (
    <SignedIn>
      <Generator
        project={project}
        scenes={scenes}
        initialSceneId={initialSceneId}
        onRun={onRun}
        onCleanupMedia={onCleanupMedia}
      />
    </SignedIn>
  );
}

function SignedIn({ children }: { children: ReactNode }) {
  const { user, isLoading } = useFreebuffUser();
  if (isLoading) {
    return (
      <Panel title="Generate scene images">
        <p className="muted-small">Checking sign-in…</p>
      </Panel>
    );
  }
  if (!user) {
    return (
      <Panel
        title="Generate scene images"
        description="Image generation runs on the app server with the providers' own keys. Sign in to generate; uploading your own images needs no account."
      >
        <div className="row">
          <SignInWithFreebuff
            returnTo={`${window.location.pathname}${window.location.search}${window.location.hash}`}
          >
            Sign in to generate images
          </SignInWithFreebuff>
        </div>
      </Panel>
    );
  }
  return <>{children}</>;
}

function Generator({
  project,
  scenes,
  initialSceneId,
  onRun,
  onCleanupMedia,
}: {
  project: Project;
  scenes: Scene[];
  initialSceneId: string | null;
  onRun: (mutator: (current: Project) => Project) => boolean;
  onCleanupMedia: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const first = initialSceneId ?? scenes[0]?.id ?? null;
    return first ? [first] : [];
  });
  const [styleId, setStyleId] = useState<ImageStyleId>('preset');
  const [modelId, setModelId] = useState<ImageModelId>(DEFAULT_IMAGE_MODEL);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<SceneRun | null>(null);
  const [runs, setRuns] = useState<Record<string, SceneRun>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const editedPrompts = useRef<Set<string>>(new Set());
  const previewUrls = useRef<Set<string>>(new Set());
  const runsRef = useRef(runs);
  runsRef.current = runs;

  const spec = imageModel(modelId) ?? IMAGE_MODELS[0];
  const selectedScenes = useMemo(
    () => scenes.filter((scene) => selectedIds.includes(scene.id)),
    [scenes, selectedIds],
  );

  useEffect(() => {
    setSelectedIds((current) => {
      const alive = current.filter((id) => scenes.some((scene) => scene.id === id));
      if (alive.length > 0) return alive;
      return scenes[0] ? [scenes[0].id] : [];
    });
  }, [scenes]);

  useEffect(() => {
    setPrompts((current) => {
      const next: Record<string, string> = {};
      for (const scene of scenes) {
        next[scene.id] =
          editedPrompts.current.has(scene.id) && current[scene.id]
            ? current[scene.id]
            : buildSceneImagePrompt({ scene, brief: project.brief, styleId });
      }
      return next;
    });
  }, [scenes, project.brief, styleId]);

  useEffect(
    () => () => {
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      previewUrls.current.clear();
    },
    [],
  );

  const updateRun = (jobId: string, patch: (run: SceneRun) => Partial<SceneRun>) => {
    setRuns((current) => {
      const run = current[jobId];
      if (!run) return current;
      return { ...current, [jobId]: { ...run, ...patch(run) } };
    });
  };

  const pendingKey = Object.values(runs)
    .filter((run) => !isTerminal(run.status))
    .map((run) => run.jobId)
    .sort()
    .join(',');

  // Only an asynchronous provider leaves a job to check; a synchronous image is
  // already in the run when it is created.
  useEffect(() => {
    if (pendingKey === '') return;
    let stopped = false;
    let timer: number | undefined;
    const ids = pendingKey.split(',');

    const poll = async () => {
      for (const id of ids) {
        if (stopped) return;
        const run = runsRef.current[id];
        if (!run || isTerminal(run.status)) continue;
        if (Date.now() - run.startedAt > JOB_TIMEOUT_MS) {
          updateRun(id, () => ({ status: 'timed_out' }));
          continue;
        }
        try {
          const job: ImageJobView = await getImageJob(id);
          if (stopped) return;
          if (job.status === 'completed') {
            const blob = await fetchGeneratedImage(id);
            if (stopped) return;
            const url = URL.createObjectURL(blob);
            previewUrls.current.add(url);
            updateRun(id, () => ({
              status: 'completed',
              preview: { blob, url },
              width: job.width ?? run.width,
              height: job.height ?? run.height,
              inferenceSeconds: job.inferenceSeconds,
              providerCreditCost: job.providerCreditCost,
              error: null,
            }));
          } else if (job.status === 'failed' || job.status === 'cancelled') {
            updateRun(id, () => ({
              status: job.status,
              error:
                job.error ??
                (job.status === 'cancelled'
                  ? 'Cancelled at Leonardo. Whether a cancelled generation is charged is Leonardo’s decision.'
                  : 'The image could not be generated.'),
            }));
          } else {
            updateRun(id, () => ({ status: job.status }));
          }
        } catch (reason) {
          if (stopped) return;
          updateRun(id, (current) => ({ error: messageFor(reason), status: current.status }));
        }
      }
      if (stopped) return;
      const stillPending = ids.some((id) => {
        const run = runsRef.current[id];
        return run && !isTerminal(run.status);
      });
      if (stillPending) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [pendingKey]);

  const toggleScene = (sceneId: string) => {
    setSelectedIds((current) => {
      if (current.includes(sceneId)) return current.filter((id) => id !== sceneId);
      if (current.length >= MAX_BATCH) return current;
      return [...current, sceneId];
    });
  };

  /** Shows a finished image immediately instead of waiting for the poll loop. */
  const showPreview = async (job: ImageJobView) => {
    const blob = await fetchGeneratedImage(job.id);
    const url = URL.createObjectURL(blob);
    previewUrls.current.add(url);
    return { blob, url };
  };

  const generate = async () => {
    setConfirmOpen(false);
    if (selectedScenes.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const failures: string[] = [];
    let submitted = 0;
    for (const scene of selectedScenes) {
      const title = scene.title || 'Untitled scene';
      const prompt = (prompts[scene.id] ?? '').trim();
      if (prompt === '') {
        failures.push(`“${title}” has no prompt.`);
        continue;
      }
      const id = requestId();
      try {
        const job = await submitImageJob({
          id,
          sceneId: scene.id,
          projectId: project.id,
          prompt,
          style: styleId,
          modelId,
        });
        const preview = job.status === 'completed' ? await showPreview(job) : null;
        setRuns((current) => ({
          ...current,
          [job.id]: {
            jobId: job.id,
            sceneId: scene.id,
            status: job.status,
            prompt,
            style: styleId,
            modelId: spec.id,
            model: job.model,
            provider: job.provider,
            startedAt: Date.now(),
            width: job.width ?? spec.width,
            height: job.height ?? spec.height,
            inferenceSeconds: job.inferenceSeconds,
            providerCreditCost: job.providerCreditCost,
            preview,
            error: job.status === 'failed' ? (job.error ?? 'The image could not be generated.') : null,
          },
        }));
        submitted += 1;
      } catch (reason) {
        failures.push(`${title}: ${messageFor(reason)}`);
      }
    }
    setBusy(false);
    if (failures.length > 0) setError(failures.join(' '));
    if (submitted > 0)
      setNotice(
        `${submitted} image${submitted === 1 ? '' : 's'} requested. Review each result before attaching it.`,
      );
  };

  const discard = (run: SceneRun) => {
    if (run.preview) {
      URL.revokeObjectURL(run.preview.url);
      previewUrls.current.delete(run.preview.url);
    }
    setRuns((current) => {
      const next = { ...current };
      delete next[run.jobId];
      return next;
    });
  };

  const cancel = async (run: SceneRun) => {
    setError(null);
    try {
      const job = await cancelImageJob(run.jobId);
      updateRun(run.jobId, () => ({
        status: job.status,
        error:
          job.status === 'cancelled'
            ? 'Cancelled at Leonardo. Whether a cancelled generation is charged is Leonardo’s decision.'
            : job.error,
      }));
    } catch (reason) {
      setError(messageFor(reason));
    }
  };

  const requestAttach = (run: SceneRun) => {
    const scene = scenes.find((candidate) => candidate.id === run.sceneId);
    if (!scene) {
      setError('That scene no longer exists. Discard this result.');
      return;
    }
    if (scene.locks.visuals) {
      setError('Visuals are locked on this scene. Unlock Visuals before replacing its image.');
      return;
    }
    if (scene.imageAssetId) {
      setReplaceTarget(run);
      return;
    }
    void attach(run);
  };

  const attach = async (run: SceneRun) => {
    setReplaceTarget(null);
    const scene = scenes.find((candidate) => candidate.id === run.sceneId);
    if (!scene || !run.preview) return;
    setBusy(true);
    setError(null);
    try {
      const record = await storeGeneratedSceneImage(
        project.id,
        run.preview.blob,
        {
          provider: run.provider,
          model: run.model,
          prompt: run.prompt,
          width: run.width,
          height: run.height,
          outputFormat: 'jpeg',
          style: run.style,
          jobId: run.jobId,
          generatedAt: new Date().toISOString(),
          inferenceSeconds: run.inferenceSeconds,
        },
        scene.imageAssetId,
      );
      const applied = onRun((current) =>
        updateScene(current, scene.id, { imageAssetId: record.id }),
      );
      if (!applied) {
        await deleteAsset(record.id).catch(() => undefined);
        setError('The image was not attached because the scene could not be changed.');
        return;
      }
      discard(run);
      onCleanupMedia();
      setNotice(
        `Attached the generated image to “${scene.title || 'Untitled scene'}”. The previous image is kept and can be restored from the scene's image field.`,
      );
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  };

  const sceneTitle = (sceneId: string) =>
    scenes.find((scene) => scene.id === sceneId)?.title || 'Deleted scene';
  const scenePosition = (sceneId: string) => scenes.findIndex((scene) => scene.id === sceneId) + 1;
  const sceneLabel = (sceneId: string) => {
    const position = scenePosition(sceneId);
    return position > 0 ? `${position}. ${sceneTitle(sceneId)}` : sceneTitle(sceneId);
  };

  return (
    <Panel
      title="Generate scene images"
      description="Two providers: Cloudflare Workers AI (FLUX.1 Schnell, on the account's free daily allowance first) and Leonardo.Ai (Phoenix 1.0 and Lucid Origin). Prompts start from each scene’s visual direction and the project preset, and you edit them before anything is sent. Uploaded images keep working exactly as before."
    >
      {error ? (
        <p className="notice notice-warn" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice notice-ok" role="status">
          {notice}
        </p>
      ) : null}

      <fieldset className="field">
        <legend>Scenes to generate</legend>
        <p className="field-hint">
          Only the scenes you tick are generated, up to {MAX_BATCH} at once. Nothing is generated
          for the rest of the storyboard.
        </p>
        <ul className="plain-list">
          {scenes.map((scene, index) => {
            const checked = selectedIds.includes(scene.id);
            const atLimit = !checked && selectedIds.length >= MAX_BATCH;
            return (
              <li key={scene.id}>
                <label className="row">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy || atLimit}
                    onChange={() => toggleScene(scene.id)}
                  />
                  <span>
                    {index + 1}. {scene.title || 'Untitled scene'}
                  </span>
                  {scene.locks.visuals ? <Badge tone="warn">Visuals locked</Badge> : null}
                  {scene.imageAssetId ? <Badge>Image attached</Badge> : null}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="form-grid">
        <SelectField
          id={`image-model-${project.id}`}
          label="Provider and model"
          value={modelId}
          onChange={(event) => {
            setModelId(event.target.value as ImageModelId);
            editedPrompts.current.clear();
          }}
          hint={spec.note}
        >
          <optgroup label={IMAGE_PROVIDER_LABELS['workers-ai']}>
            {IMAGE_MODELS.filter((option) => option.provider === 'workers-ai').map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
          <optgroup label={IMAGE_PROVIDER_LABELS.leonardo}>
            {IMAGE_MODELS.filter((option) => option.provider === 'leonardo').map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
        </SelectField>
        <SelectField
          id={`image-style-${project.id}`}
          label="Style setting"
          value={styleId}
          onChange={(event) => {
            const next = event.target.value as ImageStyleId;
            editedPrompts.current.clear();
            setStyleId(next);
          }}
          hint={`Preset style: ${styleById('preset').label}. Changing this rewrites prompts you have not edited.`}
        >
          {IMAGE_STYLES.map((style) => (
            <option key={style.id} value={style.id}>
              {style.label}
            </option>
          ))}
        </SelectField>
      </div>

      <p className="muted-small">
        {spec.width}×{spec.height} on this model. Text-to-image only: the prompt is the whole input,
        so no reference image is sent. Style, framing and subject come from the prompt; use Fit or
        Fill on a scene to place the frame in the vertical video, or upload your own image instead.
      </p>

      {selectedScenes.length === 0 ? (
        <p className="muted-small">Tick at least one scene to build a prompt.</p>
      ) : (
        <div className="stack">
          {selectedScenes.map((scene) => (
            <TextAreaField
              key={scene.id}
              id={`image-prompt-${scene.id}`}
              label={`Prompt · scene ${scenePosition(scene.id)}: ${scene.title || 'Untitled'}`}
              rows={7}
              maxLength={MAX_PROMPT_CHARS}
              value={prompts[scene.id] ?? ''}
              onChange={(event) => {
                editedPrompts.current.add(scene.id);
                setPrompts((current) => ({ ...current, [scene.id]: event.target.value }));
              }}
              hint="Editable before submission. The provider receives exactly this text."
            />
          ))}
        </div>
      )}

      {selectedScenes.length > 0 ? (
        <div className="stack">
          <p className="muted-small">{costLine(spec, selectedScenes.length)}</p>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => setConfirmOpen(true)}
            >
              Review and generate {selectedScenes.length} image
              {selectedScenes.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      ) : null}

      {Object.values(runs).length > 0 ? (
        <div className="stack">
          <h3 className="ai-proposal-title">Results</h3>
          <p className="muted-small">
            Previews are temporary. Attach the ones you want; until then they are not part of the
            project and are lost on reload.
          </p>
          {Object.values(runs).map((run) => {
            const scene = scenes.find((candidate) => candidate.id === run.sceneId);
            const runSpec = imageModel(run.modelId);
            return (
              <div key={run.jobId} className="media-card">
                {run.preview ? (
                  <img
                    className="media-thumb"
                    src={run.preview.url}
                    alt={`Generated preview for ${sceneTitle(run.sceneId)}`}
                  />
                ) : null}
                <div className="media-meta">
                  <div className="row">
                    <Badge tone={runTone(run.status)}>{runLabel(run.status)}</Badge>
                    <span>{sceneLabel(run.sceneId)}</span>
                  </div>
                  <span className="media-asset-id">Job {run.jobId.slice(0, 24)}…</span>
                  <span>
                    {run.width}×{run.height} · {runSpec?.label ?? run.model} ·{' '}
                    {IMAGE_PROVIDER_LABELS[runSpec?.provider ?? 'workers-ai']}
                    {run.inferenceSeconds !== null
                      ? ` · ${run.inferenceSeconds.toFixed(1)}s`
                      : ''}
                  </span>
                  {run.providerCreditCost !== null ? (
                    <span>Provider-reported cost: {run.providerCreditCost} API credits</span>
                  ) : null}
                  {run.error ? (
                    <span className="field-error" role="alert">
                      {run.error}
                    </span>
                  ) : null}
                  <div className="media-actions">
                    {run.status === 'completed' && run.preview ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-small btn-primary"
                          disabled={busy || scene?.locks.visuals}
                          onClick={() => requestAttach(run)}
                        >
                          {scene?.imageAssetId ? 'Replace attached image' : 'Attach to scene'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={busy}
                          onClick={() => discard(run)}
                        >
                          Discard
                        </button>
                      </>
                    ) : null}
                    {!isTerminal(run.status) && runSpec?.lifecycle === 'async' ? (
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={busy}
                        onClick={() => void cancel(run)}
                      >
                        Cancel
                      </button>
                    ) : null}
                    {run.status === 'timed_out' ? (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() =>
                          updateRun(run.jobId, () => ({
                            status: 'queued',
                            startedAt: Date.now(),
                            error: null,
                          }))
                        }
                      >
                        Check again
                      </button>
                    ) : null}
                    {isTerminal(run.status) && run.status !== 'completed' ? (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => discard(run)}
                      >
                        Dismiss
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {confirmOpen ? (
        <Dialog
          title={`Generate ${selectedScenes.length} image${selectedScenes.length === 1 ? '' : 's'}?`}
          description={`This runs ${selectedScenes.length} paid generation${
            selectedScenes.length === 1 ? '' : 's'
          } on ${spec.label} through ${IMAGE_PROVIDER_LABELS[spec.provider]}. ${costLine(
            spec,
            selectedScenes.length,
          )}`}
          onDismiss={() => setConfirmOpen(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setConfirmOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void generate()}>
                Generate now
              </button>
            </>
          }
        >
          <ul className="plain-list">
            {selectedScenes.map((scene) => (
              <li key={scene.id}>
                {scene.title || 'Untitled scene'} · {spec.width}×{spec.height} · {spec.label}
              </li>
            ))}
          </ul>
        </Dialog>
      ) : null}

      {replaceTarget ? (
        <Dialog
          title="Replace this scene's image?"
          description="The generated image replaces the attached one. The previous image is kept and can be restored from the scene's image field."
          onDismiss={() => setReplaceTarget(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setReplaceTarget(null)}>
                Keep current image
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void attach(replaceTarget)}
              >
                Replace image
              </button>
            </>
          }
        />
      ) : null}
    </Panel>
  );
}
