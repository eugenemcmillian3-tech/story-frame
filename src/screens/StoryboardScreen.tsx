import { useEffect, useState } from 'react';
import { AiStoryboardPlanner } from '../components/AiPlanning';
import { Dialog } from '../components/Dialog';
import { MissingMediaNotice } from '../components/MissingMediaNotice';
import { SceneImageField } from '../components/SceneImageField';
import { SceneImageGenerator } from '../components/SceneImageGenerator';
import { Badge, Panel, SelectField, TextAreaField, TextField } from '../components/ui';
import {
  ASSET_TYPES,
  SCENE_LOCK_KEYS,
  SCENE_LOCK_LABELS,
  durationVarianceThreshold,
} from '../domain/constants';
import {
  durationVariance,
  formatDuration,
  isDurationVarianceMaterial,
  totalPlannedDuration,
} from '../domain/duration';
import { newId } from '../domain/ids';
import {
  addScene,
  deleteScene,
  duplicateScene,
  markStoryboardReviewed,
  moveScene,
  setSceneLocks,
  setSceneStatus,
  updateScene,
} from '../domain/storyboard';
import { getStoryboardReview } from '../domain/staleness';
import { cleanupProjectMedia } from '../media/cleanup';
import type { AssetType, Project, Scene, SceneLockKey } from '../domain/types';
import { formatTimestamp } from '../format';
import { useStore } from '../state/StoreProvider';

export function StoryboardScreen({ project }: { project: Project }) {
  const store = useStore();
  const scenes = project.storyboard.scenes;
  const [selectedId, setSelectedId] = useState<string | null>(scenes[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Scene | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const cleanupMedia = () => {
    void cleanupProjectMedia(store).catch(() => undefined);
  };

  const selected = scenes.find((scene) => scene.id === selectedId) ?? scenes[0] ?? null;
  const review = getStoryboardReview(project);
  const plannedTotal = totalPlannedDuration(project);
  const variance = durationVariance(project);
  const materialVariance = isDurationVarianceMaterial(project);

  useEffect(() => {
    if (selectedId !== null && scenes.some((scene) => scene.id === selectedId)) return;
    setSelectedId(scenes[0]?.id ?? null);
  }, [scenes, selectedId]);

  const run = (mutator: (current: Project) => Project) => {
    const result = store.mutate(mutator);
    setError(result.ok ? null : (result.message ?? 'That change was not applied.'));
    return result.ok;
  };

  const handleAddScene = () => {
    if (!run((current) => addScene(current))) return;
    const next = store.getSnapshot().active?.project.storyboard.scenes.at(-1);
    if (next) setSelectedId(next.id);
    setAnnouncement('Scene added at the end.');
  };

  const handleDuplicateScene = (scene: Scene) => {
    const position = scenes.findIndex((candidate) => candidate.id === scene.id);
    if (!run((current) => duplicateScene(current, scene.id))) return;
    const copy = store.getSnapshot().active?.project.storyboard.scenes[position + 1];
    if (copy) setSelectedId(copy.id);
    setAnnouncement(`Duplicated "${scene.title}" with a new scene ID.`);
  };

  const handleMove = (scene: Scene, direction: -1 | 1) => {
    const position = scenes.findIndex((candidate) => candidate.id === scene.id);
    if (!run((current) => moveScene(current, scene.id, direction))) return;
    setAnnouncement(
      `Moved "${scene.title}" to position ${position + direction + 1} of ${scenes.length}.`,
    );
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    const name = deleteTarget.title;
    setDeleteTarget(null);
    if (!run((current) => deleteScene(current, deleteTarget.id))) return;
    setAnnouncement(`Deleted "${name}".`);
    cleanupMedia();
  };

  return (
    <div className="stack">
      <header className="screen-head">
        <div>
          <h1>Storyboard</h1>
          <p className="screen-subtitle">
            {scenes.length} scene{scenes.length === 1 ? '' : 's'} · planned{' '}
            {formatDuration(plannedTotal)} against a {formatDuration(project.brief.targetDuration)}{' '}
            target
          </p>
        </div>
        <div className="row">
          <Badge tone={materialVariance ? 'warn' : 'neutral'}>
            {variance === 0
              ? 'On target'
              : `${variance > 0 ? '+' : ''}${Math.round(variance)}s vs target`}
          </Badge>
          <button type="button" className="btn btn-small" onClick={handleAddScene}>
            Add scene
          </button>
        </div>
      </header>

      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}

      <MissingMediaNotice project={project} />

      <AiStoryboardPlanner project={project} />

      {scenes.length > 0 ? (
        <SceneImageGenerator
          project={project}
          scenes={scenes}
          initialSceneId={selected?.id ?? null}
          onRun={run}
          onCleanupMedia={cleanupMedia}
        />
      ) : null}

      {materialVariance ? (
        <div className="review-banner is-stale" role="status">
          <div>
            <strong>Planned length differs materially from the brief target.</strong>
            <p>
              {formatDuration(plannedTotal)} planned, {formatDuration(project.brief.targetDuration)}{' '}
              target. A difference of more than{' '}
              {formatDuration(durationVarianceThreshold(project.brief.targetDuration))} is flagged.
            </p>
          </div>
        </div>
      ) : null}

      <div
        className={
          review.status === 'stale'
            ? 'review-banner is-stale'
            : review.status === 'current'
              ? 'review-banner is-current'
              : 'review-banner'
        }
      >
        <div>
          <strong>
            {review.status === 'current'
              ? 'Storyboard reviewed against the current script'
              : review.status === 'stale'
                ? 'The script changed after this storyboard was reviewed'
                : 'Storyboard not reviewed against the current script'}
          </strong>
          <p>
            {review.status === 'current'
              ? `Reviewed ${review.reviewedAt ? formatTimestamp(review.reviewedAt) : 'recently'}. Any later script edit invalidates this.`
              : review.status === 'stale'
                ? 'Scene content may be out of date. Marking review records your review only; it does not rewrite or synchronize any scene.'
                : 'Marking review records your review only. It does not rewrite or synchronize any scene.'}
          </p>
        </div>
        {review.status !== 'current' ? (
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={() => run((current) => markStoryboardReviewed(current))}
          >
            Mark storyboard reviewed against current script
          </button>
        ) : null}
      </div>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      {scenes.length === 0 ? (
        <Panel title="No scenes yet">
          <p className="muted">
            Add a scene, then split the narration across scenes. Scenes are independent and each
            keeps its own locks.
          </p>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={handleAddScene}>
              Add the first scene
            </button>
          </div>
        </Panel>
      ) : (
        <div className="storyboard-grid">
          <div className="stack">
            <Panel title="Scenes" description="Array order is the scene order. Select a scene to edit.">
              <ol className="scene-list">
                {scenes.map((scene, index) => {
                  const active = selected?.id === scene.id;
                  const lockedCount = SCENE_LOCK_KEYS.filter((key) => scene.locks[key]).length;
                  return (
                    <li key={scene.id} className="scene-item">
                      <button
                        type="button"
                        className={active ? 'scene-select is-current' : 'scene-select'}
                        onClick={() => setSelectedId(scene.id)}
                        aria-current={active ? 'true' : undefined}
                      >
                        <span className="scene-item-title">
                          {index + 1}. {scene.title || 'Untitled scene'}
                        </span>
                        <span className="scene-meta">
                          <span>{formatDuration(scene.plannedDuration)}</span>
                          <span>{scene.status === 'approved' ? 'Approved' : 'Draft'}</span>
                          <span>{scene.imageAssetId ? 'Image attached' : 'No image'}</span>
                          <span>{lockedCount} locked</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              <button type="button" className="btn btn-small" onClick={handleAddScene}>
                Add scene
              </button>
            </Panel>
          </div>

          {selected ? (
            <SceneEditor
              key={selected.id}
              project={project}
              scene={selected}
              index={scenes.findIndex((scene) => scene.id === selected.id)}
              total={scenes.length}
              onRun={run}
              onMove={handleMove}
              onDuplicate={handleDuplicateScene}
              onDelete={() => setDeleteTarget(selected)}
              onCleanupMedia={cleanupMedia}
            />
          ) : null}
        </div>
      )}

      {deleteTarget ? (
        <Dialog
          title="Delete scene?"
          description={`"${deleteTarget.title}" will be removed from the storyboard. This cannot be undone here.`}
          onDismiss={() => setDeleteTarget(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={handleDelete}>
                Delete scene
              </button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

function SceneEditor({
  project,
  scene,
  index,
  total,
  onRun,
  onMove,
  onDuplicate,
  onDelete,
  onCleanupMedia,
}: {
  project: Project;
  scene: Scene;
  index: number;
  total: number;
  onRun: (mutator: (current: Project) => Project) => boolean;
  onMove: (scene: Scene, direction: -1 | 1) => void;
  onDuplicate: (scene: Scene) => void;
  onDelete: () => void;
  onCleanupMedia: () => void;
}) {
  const narrationLocked = scene.locks.narration;
  const visualsLocked = scene.locks.visuals;
  const textLocked = scene.locks.text;
  const timingLocked = scene.locks.timing;
  const assetRefLabel = scene.assetRef?.label ?? '';

  return (
    <Panel
      title={`Scene ${index + 1} of ${total}`}
      description="Each component has its own lock. Locks are enforced in the project logic, so a locked component cannot be changed even by a direct mutation."
      actions={
        <>
          <Badge tone={scene.status === 'approved' ? 'ok' : 'neutral'}>
            {scene.status === 'approved' ? 'Approved' : 'Draft'}
          </Badge>
          <button
            type="button"
            className="btn btn-small"
            disabled={index === 0}
            onClick={() => onMove(scene, -1)}
          >
            Move up
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={index === total - 1}
            onClick={() => onMove(scene, 1)}
          >
            Move down
          </button>
          <button type="button" className="btn btn-small" onClick={() => onDuplicate(scene)}>
            Duplicate
          </button>
          <button type="button" className="btn btn-small btn-danger" onClick={onDelete}>
            Delete
          </button>
        </>
      }
    >
      <div className="lock-row" role="group" aria-label="Component locks">
        {SCENE_LOCK_KEYS.map((key: SceneLockKey) => (
          <button
            key={key}
            type="button"
            className={scene.locks[key] ? 'lock-chip is-locked' : 'lock-chip'}
            aria-pressed={scene.locks[key]}
            onClick={() =>
              onRun((current) =>
                setSceneLocks(current, scene.id, { [key]: !scene.locks[key] }),
              )
            }
          >
            {SCENE_LOCK_LABELS[key]} · {scene.locks[key] ? 'locked' : 'unlocked'}
          </button>
        ))}
      </div>

      <TextField
        id={`scene-title-${scene.id}`}
        label="Scene title"
        value={scene.title}
        onChange={(event) =>
          onRun((current) => updateScene(current, scene.id, { title: event.target.value }))
        }
        hint="Titles are metadata: they stay editable even when components are locked."
      />

      <TextAreaField
        id={`scene-narration-${scene.id}`}
        label="Narration"
        rows={4}
        value={scene.narration}
        disabled={narrationLocked}
        onChange={(event) =>
          onRun((current) => updateScene(current, scene.id, { narration: event.target.value }))
        }
        hint="The narration slice for this scene. The script above remains the single source of truth."
      />

      <TextAreaField
        id={`scene-visual-${scene.id}`}
        label="Visual direction"
        rows={3}
        value={scene.visualDirection}
        disabled={visualsLocked}
        onChange={(event) =>
          onRun((current) =>
            updateScene(current, scene.id, { visualDirection: event.target.value }),
          )
        }
      />

      <div className="form-grid">
        <SelectField
          id={`scene-asset-type-${scene.id}`}
          label="Suggested asset type"
          value={scene.assetType}
          disabled={visualsLocked}
          onChange={(event) =>
            onRun((current) =>
              updateScene(current, scene.id, { assetType: event.target.value as AssetType }),
            )
          }
        >
          {ASSET_TYPES.map((type) => (
            <option key={type.id} value={type.id}>
              {type.label}
            </option>
          ))}
        </SelectField>
        <TextField
          id={`scene-asset-ref-${scene.id}`}
          label="Asset reference (optional)"
          value={assetRefLabel}
          disabled={visualsLocked}
          placeholder="A note for the media you will use"
          onChange={(event) => {
            const label = event.target.value;
            onRun((current) =>
              updateScene(current, scene.id, {
                assetRef:
                  label.trim() === ''
                    ? null
                    : { id: scene.assetRef?.id ?? newId('ast'), label },
              }),
            );
          }}
          hint="A note for the media you plan to use. The actual image is attached below."
        />
      </div>

      <SceneImageField
        projectId={project.id}
        scene={scene}
        locked={visualsLocked}
        onChange={(patch) => onRun((current) => updateScene(current, scene.id, patch))}
        onCleanup={onCleanupMedia}
      />

      <TextAreaField
        id={`scene-text-${scene.id}`}
        label="On-screen text"
        rows={2}
        value={scene.onScreenText}
        disabled={textLocked}
        onChange={(event) =>
          onRun((current) => updateScene(current, scene.id, { onScreenText: event.target.value }))
        }
      />

      <TextField
        id={`scene-duration-${scene.id}`}
        label="Planned duration (seconds)"
        type="number"
        min={0}
        max={600}
        value={String(scene.plannedDuration)}
        disabled={timingLocked}
        onChange={(event) => {
          const value = Number(event.target.value);
          onRun((current) =>
            updateScene(current, scene.id, {
              plannedDuration: Number.isFinite(value) ? value : 0,
            }),
          );
        }}
        hint={`Planned timing only. The brief target is ${project.brief.targetDuration}s.`}
      />

      <div className="row">
        <button
          type="button"
          className={scene.status === 'approved' ? 'btn' : 'btn btn-primary'}
          onClick={() =>
            onRun((current) =>
              setSceneStatus(current, scene.id, scene.status === 'approved' ? 'draft' : 'approved'),
            )
          }
        >
          {scene.status === 'approved' ? 'Reopen scene' : 'Approve scene'}
        </button>
        <span className="muted-small">
          Editing an approved scene's content returns it to draft. Reopening never deletes content.
        </span>
      </div>
    </Panel>
  );
}
