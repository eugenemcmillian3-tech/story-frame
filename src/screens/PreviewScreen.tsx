import { useEffect, useState } from 'react';
import { Badge, Panel } from '../components/ui';
import { ASSET_TYPE_LABELS, VISUAL_PRESET_LABELS } from '../domain/constants';
import { formatDuration, totalPlannedDuration } from '../domain/duration';
import type { Project } from '../domain/types';
import { getAsset } from '../media/mediaDb';
import { routeToHash } from '../router';

export function PreviewScreen({ project }: { project: Project }) {
  const scenes = project.storyboard.scenes;
  const sceneCount = scenes.length;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const safeIndex = sceneCount === 0 ? 0 : Math.min(index, sceneCount - 1);
  const scene = scenes[safeIndex] ?? null;
  const imageAssetId = scene?.imageAssetId ?? null;

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;
    setImageUrl(null);
    if (!imageAssetId) return;

    getAsset(imageAssetId)
      .then((asset) => {
        if (!active || !asset) return;
        createdUrl = URL.createObjectURL(asset.blob);
        setImageUrl(createdUrl);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [imageAssetId]);

  useEffect(() => {
    if (!playing || sceneCount === 0 || !scene) return;
    const delay = Math.max(1, scene.plannedDuration) * 1000;
    const timer = window.setTimeout(() => {
      setIndex((current) => (current + 1) % sceneCount);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [playing, safeIndex, scene, sceneCount]);

  return (
    <div className="stack">
      <header className="screen-head">
        <div>
          <h1>Storyboard preview</h1>
          <p className="screen-subtitle">
            {sceneCount} scene{sceneCount === 1 ? '' : 's'} ·{' '}
            {formatDuration(totalPlannedDuration(project))} planned ·{' '}
            {VISUAL_PRESET_LABELS[project.brief.visualPreset]}
          </p>
        </div>
        <Badge>{project.brief.mode === 'factual' ? 'Factual' : 'Fiction'}</Badge>
      </header>

      <div className="preview-badge-banner">
        <strong>Storyboard preview — not the rendered video.</strong>
        <p>
          This steps through the storyboard with any attached still frames and your written
          direction. This preview has no motion or audio playback. The MP4 is produced in Export,
          where optional uploaded narration and music are mixed.
        </p>
        <div className="provider-row">
          <span className="provider-chip">AI narration not connected.</span>
          <span className="provider-chip">AI media generation not connected.</span>
          <span className="provider-chip">MP4 rendering and uploaded audio on the Export screen.</span>
        </div>
      </div>

      {sceneCount === 0 || !scene ? (
        <Panel title="This storyboard has no scenes yet.">
          <p className="muted">
            Add scenes in the storyboard workspace, then come back to step through them here.
          </p>
          <div className="row">
            <a
              className="btn btn-primary"
              href={routeToHash({ name: 'project', id: project.id, stage: 'storyboard' })}
            >
              Go to storyboard
            </a>
          </div>
        </Panel>
      ) : (
        <div className="preview-layout">
          <Panel title="Scenes" description="Jump to any scene. Playback is not audible.">
            <ol className="scene-list">
              {scenes.map((candidate, position) => (
                <li key={candidate.id} className="scene-item">
                  <button
                    type="button"
                    className={
                      position === safeIndex ? 'scene-select is-current' : 'scene-select'
                    }
                    aria-current={position === safeIndex ? 'true' : undefined}
                    onClick={() => {
                      setIndex(position);
                      setPlaying(false);
                    }}
                  >
                    <span className="scene-item-title">
                      {position + 1}. {candidate.title || 'Untitled scene'}
                    </span>
                    <span className="scene-meta">
                      <span>{formatDuration(candidate.plannedDuration)}</span>
                      <span>{candidate.status === 'approved' ? 'Approved' : 'Draft'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </Panel>

          <div className="preview-stage">
            <div
              className={`preview-canvas preview-${project.brief.visualPreset}`}
              aria-label={`Preview of scene ${safeIndex + 1}: ${scene.title}`}
            >
              <div className="preview-canvas-inner">
                <span className="preview-scene-index">
                  Scene {safeIndex + 1} / {sceneCount}
                </span>
                <div className={imageUrl ? 'preview-visual has-image' : 'preview-visual'}>
                  {imageUrl ? (
                    <>
                      <img
                        className={`preview-image preview-image-${scene.imageFraming}`}
                        src={imageUrl}
                        alt=""
                      />
                      <span className="preview-image-note">
                        Attached image · {scene.imageFraming === 'fit' ? 'fit' : 'fill'}
                      </span>
                    </>
                  ) : (
                    <>
                      <p className="preview-visual-label">
                        {scene.assetRef
                          ? `Reference: ${scene.assetRef.label}`
                          : 'Placeholder visual — no image attached'}
                      </p>
                      <p className="preview-visual-direction">
                        {scene.visualDirection ||
                          'No visual direction written for this scene yet.'}
                      </p>
                      <p className="preview-visual-meta">
                        Suggested asset: {ASSET_TYPE_LABELS[scene.assetType]}
                      </p>
                    </>
                  )}
                </div>
                {scene.onScreenText ? (
                  <p className="preview-caption">{scene.onScreenText}</p>
                ) : null}
                <p className="preview-narration">
                  {scene.narration || 'No narration written for this scene yet.'}
                </p>
              </div>
            </div>

            <div className="preview-controls">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setPlaying(false);
                  setIndex((current) => (current - 1 + sceneCount) % sceneCount);
                }}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn btn-small btn-primary"
                onClick={() => setPlaying((current) => !current)}
              >
                {playing ? 'Pause timed slides' : 'Play timed slides'}
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setPlaying(false);
                  setIndex((current) => (current + 1) % sceneCount);
                }}
              >
                Next
              </button>
            </div>
            <p className="muted-small">
              Timed slide playback advances using planned scene durations only. There is no audio,
              transition, or rendering.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
