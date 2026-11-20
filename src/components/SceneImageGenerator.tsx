import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SignInWithFreebuff, useFreebuffUser } from '@freebuff/auth/react';
import { updateScene } from '../domain/storyboard';
import type { Project, Scene } from '../domain/types';
import { fetchGeneratedImage, submitImageJob } from '../images/api';
import {
  IMAGE_MODEL,
  IMAGE_MODEL_LABEL,
  IMAGE_PRICING_SOURCE,
  IMAGE_PROVIDER,
  IMAGE_PROVIDER_LABEL,
  IMAGE_SIZE,
  IMAGE_STEPS,
  IMAGE_STYLES,
  IMAGE_USD_ESTIMATE,
  MAX_PROMPT_CHARS,
  buildSceneImagePrompt,
  styleById,
} from '../images/provider';
import type { ImageStyleId } from '../images/provider';
import { deleteAsset } from '../media/mediaDb';
import { storeGeneratedSceneImage } from '../media/imageAssets';
import { Badge, Panel, SelectField, TextAreaField } from './ui';
import { Dialog } from './Dialog';

const MAX_BATCH = 4;

interface GenerationResult {
  jobId: string;
  sceneId: string;
  prompt: string;
  style: string;
  blob: Blob;
  url: string;
  width: number;
  height: number;
  inferenceSeconds: number | null;
}

function requestId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `ij_${cryptoApi.randomUUID()}`;
  }
  return `ij_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Something went wrong. Nothing was attached.';
}

function usd(amount: number): string {
  return `$${amount.toFixed(4)}`;
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
        description="Image generation runs on the app server with the Workers AI credentials. Sign in to generate; uploading your own images needs no account."
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
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<GenerationResult | null>(null);
  const [results, setResults] = useState<GenerationResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const editedPrompts = useRef<Set<string>>(new Set());
  const previewUrls = useRef<Set<string>>(new Set());

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

  const toggleScene = (sceneId: string) => {
    setSelectedIds((current) => {
      if (current.includes(sceneId)) return current.filter((id) => id !== sceneId);
      if (current.length >= MAX_BATCH) return current;
      return [...current, sceneId];
    });
  };

  const generate = async () => {
    setConfirmOpen(false);
    if (selectedScenes.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const failures: string[] = [];
    const created: GenerationResult[] = [];
    for (const [index, scene] of selectedScenes.entries()) {
      setProgress({ done: index, total: selectedScenes.length });
      const title = scene.title || 'Untitled scene';
      const prompt = (prompts[scene.id] ?? '').trim();
      if (prompt === '') {
        failures.push(`“${title}” has no prompt.`);
        continue;
      }
      try {
        const job = await submitImageJob({
          id: requestId(),
          sceneId: scene.id,
          projectId: project.id,
          prompt,
          style: styleId,
        });
        if (job.status !== 'completed') {
          throw new Error(job.error ?? 'The image was not generated.');
        }
        const blob = await fetchGeneratedImage(job.id);
        const url = URL.createObjectURL(blob);
        previewUrls.current.add(url);
        created.push({
          jobId: job.id,
          sceneId: scene.id,
          prompt,
          style: styleId,
          blob,
          url,
          width: job.width ?? IMAGE_SIZE,
          height: job.height ?? IMAGE_SIZE,
          inferenceSeconds: job.inferenceSeconds,
        });
      } catch (reason) {
        failures.push(`${title}: ${messageFor(reason)}`);
      }
    }
    setResults((current) => [...current, ...created]);
    setProgress(null);
    setBusy(false);
    if (failures.length > 0) setError(failures.join(' '));
    else
      setNotice(
        `${created.length} image${created.length === 1 ? '' : 's'} ready. Review ${
          created.length === 1 ? 'it' : 'them'
        } below before attaching.`,
      );
  };

  const discard = (result: GenerationResult) => {
    URL.revokeObjectURL(result.url);
    previewUrls.current.delete(result.url);
    setResults((current) => current.filter((candidate) => candidate.jobId !== result.jobId));
  };

  const requestAttach = (result: GenerationResult) => {
    const scene = scenes.find((candidate) => candidate.id === result.sceneId);
    if (!scene) {
      setError('That scene no longer exists. Discard this result.');
      return;
    }
    if (scene.locks.visuals) {
      setError('Visuals are locked on this scene. Unlock Visuals before replacing its image.');
      return;
    }
    if (scene.imageAssetId) {
      setReplaceTarget(result);
      return;
    }
    void attach(result);
  };

  const attach = async (result: GenerationResult) => {
    setReplaceTarget(null);
    const scene = scenes.find((candidate) => candidate.id === result.sceneId);
    if (!scene) return;
    setBusy(true);
    setError(null);
    try {
      const record = await storeGeneratedSceneImage(
        project.id,
        result.blob,
        {
          provider: IMAGE_PROVIDER,
          model: IMAGE_MODEL,
          prompt: result.prompt,
          width: result.width,
          height: result.height,
          outputFormat: 'jpeg',
          style: result.style,
          jobId: result.jobId,
          generatedAt: new Date().toISOString(),
          inferenceSeconds: result.inferenceSeconds,
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
      discard(result);
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
      description={`One provider: ${IMAGE_PROVIDER_LABEL} (${IMAGE_MODEL_LABEL}), called from the app server with the account's own Cloudflare credentials. Prompts start from each scene’s visual direction and the project preset, and you edit them before anything is sent. Uploaded images keep working exactly as before.`}
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
        {IMAGE_MODEL_LABEL} returns one {IMAGE_SIZE}×{IMAGE_SIZE} JPEG at {IMAGE_STEPS} steps.
        Text-to-image only: the prompt is the whole input, so no reference image is sent. Style,
        framing and subject come from the prompt. Use Fit or Fill on a scene to place the square
        frame in the vertical video, and upload your own image to any scene instead if you prefer.
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
              hint="Editable before submission. Cloudflare receives exactly this text."
            />
          ))}
        </div>
      )}

      {selectedScenes.length > 0 ? (
        <div className="stack">
          <p className="muted-small">
            {selectedScenes.length} image{selectedScenes.length === 1 ? '' : 's'} at{' '}
            {usd(IMAGE_USD_ESTIMATE)} each ({usd(IMAGE_USD_ESTIMATE * selectedScenes.length)}), the
            published Workers AI list price for {IMAGE_SIZE}×{IMAGE_SIZE} at {IMAGE_STEPS} steps,
            before your account's plan, its free daily allowance and taxes.{' '}
            <a href={IMAGE_PRICING_SOURCE} target="_blank" rel="noreferrer">
              Workers AI pricing
            </a>
            .
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => setConfirmOpen(true)}
            >
              {busy && progress
                ? `Generating ${progress.done + 1} of ${progress.total}…`
                : `Review and generate ${selectedScenes.length} image${
                    selectedScenes.length === 1 ? '' : 's'
                  }`}
            </button>
          </div>
        </div>
      ) : null}

      {results.length > 0 ? (
        <div className="stack">
          <h3 className="ai-proposal-title">Results</h3>
          <p className="muted-small">
            Previews are temporary. Attach the ones you want; until then they are not part of the
            project and are lost on reload.
          </p>
          {results.map((result) => {
            const scene = scenes.find((candidate) => candidate.id === result.sceneId);
            return (
              <div key={result.jobId} className="media-card">
                <img
                  className="media-thumb"
                  src={result.url}
                  alt={`Generated preview for ${sceneTitle(result.sceneId)}`}
                />
                <div className="media-meta">
                  <div className="row">
                    <Badge tone="ok">Ready to review</Badge>
                    <span>{sceneLabel(result.sceneId)}</span>
                  </div>
                  <span className="media-asset-id">Job {result.jobId.slice(0, 24)}…</span>
                  <span>
                    {result.width}×{result.height} · {IMAGE_MODEL_LABEL}
                    {result.inferenceSeconds !== null
                      ? ` · ${result.inferenceSeconds.toFixed(1)}s`
                      : ''}
                  </span>
                  <div className="media-actions">
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      disabled={busy || scene?.locks.visuals}
                      onClick={() => requestAttach(result)}
                    >
                      {scene?.imageAssetId ? 'Replace attached image' : 'Attach to scene'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy}
                      onClick={() => discard(result)}
                    >
                      Discard
                    </button>
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
          description={`This spends one Workers AI generation per scene on ${IMAGE_PROVIDER_LABEL} (${IMAGE_MODEL_LABEL}). At the published list price that is about ${usd(
            IMAGE_USD_ESTIMATE * selectedScenes.length,
          )}, before your account's plan, its free daily allowance and taxes.`}
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
                {scene.title || 'Untitled scene'} · {IMAGE_SIZE}×{IMAGE_SIZE} · {IMAGE_MODEL_LABEL}
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
