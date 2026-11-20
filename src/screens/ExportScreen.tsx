import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioTracksPanel } from '../components/AudioTracksPanel';
import { Badge, Panel } from '../components/ui';
import { ASSET_TYPE_LABELS } from '../domain/constants';
import { formatDuration, totalPlannedDuration } from '../domain/duration';
import {
  PROJECT_DATA_DISCLAIMER,
  projectDataFilename,
  serializeProjectDataExport,
} from '../domain/exportData';
import type { Project } from '../domain/types';
import { downloadTextFile } from '../download';
import { formatBytes, formatTimestamp } from '../format';
import { getLatestRender } from '../media/mediaDb';
import type { StoredRenderRecord } from '../media/mediaDb';
import {
  cancelRenderJob,
  isRenderJobBusy,
  startRenderJob,
  useActiveRenderJob,
  useRenderJob,
} from '../render/renderManager';
import type { RenderJobStatus } from '../render/renderManager';
import { buildRenderSnapshot } from '../render/snapshot';
import { NARRATION_CUTOFF_TOLERANCE_MS } from '../render/validation';
import { useStore } from '../state/StoreProvider';

const STATE_LABELS: Record<RenderJobStatus | 'idle', string> = {
  idle: 'Ready to render',
  validating: 'Validating project…',
  preparing: 'Preparing images…',
  rendering: 'Rendering frames…',
  finalizing: 'Finalizing MP4…',
  completed: 'Render completed',
  failed: 'Render failed',
  canceled: 'Render canceled',
};

interface MeasuredVideo {
  duration: number;
  width: number;
  height: number;
}

function videoFilename(project: Project, hasAudio: boolean): string {
  const slug = project.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'storyframe'}-${hasAudio ? 'with-audio' : 'silent'}-720x1280.mp4`;
}

export function ExportScreen({ project }: { project: Project }) {
  const store = useStore();
  const planned = totalPlannedDuration(project);
  const approved = project.storyboard.scenes.filter((scene) => scene.status === 'approved').length;
  const narration = project.audio.narration;
  const audioIncluded = [narration, project.audio.music].some(
    (track) => track.assetId !== null && !track.muted,
  );
  const plannedMs = planned * 1000;
  const narrationCutoff =
    narration.assetId !== null &&
    !narration.muted &&
    narration.durationMs !== null &&
    narration.durationMs > plannedMs + NARRATION_CUTOFF_TOLERANCE_MS;
  const narrationShortfall =
    narration.assetId !== null &&
    !narration.muted &&
    narration.durationMs !== null &&
    narration.durationMs < plannedMs - NARRATION_CUTOFF_TOLERANCE_MS;
  const [acknowledgedCutoff, setAcknowledgedCutoff] = useState(false);

  const job = useRenderJob(project.id);
  const activeJob = useActiveRenderJob();

  const [loadedRecord, setLoadedRecord] = useState<StoredRenderRecord | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [measured, setMeasured] = useState<MeasuredVideo | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  const status: RenderJobStatus | 'idle' = job?.status ?? 'idle';
  const busy = job !== null && isRenderJobBusy(job.status);
  const progress = job?.progress ?? { encoded: 0, total: 0 };
  const issues = job?.issues ?? [];
  const error = job?.error ?? null;
  const displayRecord = job?.record ?? loadedRecord;
  const activeElsewhere = activeJob !== null && activeJob.projectId !== project.id;

  useEffect(() => {
    setAcknowledgedCutoff(false);
  }, [project.id, narration.assetId, narration.durationMs, planned]);

  const currentSnapshot = useMemo(() => buildRenderSnapshot(project), [project]);
  const changedSinceRender =
    displayRecord !== null &&
    displayRecord.snapshot.contentFingerprint !== currentSnapshot.contentFingerprint;

  useEffect(() => {
    let active = true;
    setLoadedRecord(null);
    setStorageError(null);

    getLatestRender(project.id)
      .then((record) => {
        if (active && record) setLoadedRecord(record);
      })
      .catch((reason: unknown) => {
        if (active) {
          setStorageError(
            reason instanceof Error ? reason.message : 'Saved renders could not be read.',
          );
        }
      });

    return () => {
      active = false;
    };
  }, [project.id]);

  useEffect(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setResultUrl(null);
    setMeasured(null);
    if (!displayRecord) return;

    const url = URL.createObjectURL(displayRecord.blob);
    urlRef.current = url;
    setResultUrl(url);
  }, [displayRecord]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const percent =
    progress.total > 0 ? Math.min(100, Math.round((progress.encoded / progress.total) * 100)) : 0;

  const handleStart = () => {
    setStartError(null);
    const outcome = startRenderJob(project, {
      acknowledgeNarrationCutoff: acknowledgedCutoff,
    });
    if (!outcome.ok) setStartError(outcome.message ?? 'A render is already running.');
  };

  return (
    <div className="stack">
      <header className="screen-head">
        <div>
          <h1>Export</h1>
          <p className="screen-subtitle">
            Vertical 9:16 · {formatDuration(project.brief.targetDuration)} target ·{' '}
            {formatDuration(planned)} planned · {approved} of {project.storyboard.scenes.length}{' '}
            scenes approved
          </p>
        </div>
        <Badge tone="accent">{audioIncluded ? 'MP4 · uploaded audio' : 'Silent MP4 · no audio'}</Badge>
      </header>

      <AudioTracksPanel project={project} />

      <div className="export-grid">
        <Panel
          title="Rendered video"
          description="A real MP4 built from the storyboard order, planned durations, attached images, fit/fill framing, on-screen text, and the optional uploaded audio tracks. Hard cuts only."
        >
          <p className="muted-small">
            Output: 720×1280 · 30 fps target · H.264 video ·{' '}
            {audioIncluded ? 'Opus audio mixed from your tracks' : 'no audio track'} · silent
            export is still available when no audio is included. Rendering happens in this browser;
            nothing is uploaded.
          </p>

          <p className="render-state" role="status" aria-live="polite">
            {STATE_LABELS[status]}
            {busy && status === 'rendering' && progress.total > 0
              ? ` — ${progress.encoded} of ${progress.total} frames encoded (${percent}%)`
              : ''}
          </p>

          {busy ? (
            <div className="render-progress">
              {status === 'rendering' && progress.total > 0 ? (
                <div
                  className="render-progress-bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.encoded}
                  aria-label="Frames encoded"
                >
                  <span style={{ width: `${percent}%` }} />
                </div>
              ) : (
                <div className="render-progress-bar is-indeterminate" aria-hidden="true">
                  <span />
                </div>
              )}
            </div>
          ) : null}

          <div className="row render-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleStart}
              disabled={busy || activeJob !== null || (narrationCutoff && !acknowledgedCutoff)}
            >
              {audioIncluded ? 'Render MP4 with audio' : 'Render silent MP4'}
            </button>
            {busy ? (
              <button type="button" className="btn" onClick={() => cancelRenderJob(project.id)}>
                Cancel render
              </button>
            ) : null}
          </div>

          {narrationShortfall ? (
            <div className="notice" role="status">
              Narration ends {((plannedMs - (narration.durationMs ?? 0)) / 1000).toFixed(2)} s
              before the storyboard. The remaining video will be silent for narration; music, if
              included, still plays. The storyboard is not retimed.
            </div>
          ) : null}

          {narrationCutoff ? (
            <div className="notice audio-cutoff-notice" role="status">
              <p>
                Narration is {((narration.durationMs ?? 0) / 1000).toFixed(2)} s but the storyboard
                is {(plannedMs / 1000).toFixed(2)} s. The final{' '}
                {(((narration.durationMs ?? 0) - plannedMs) / 1000).toFixed(2)} s of audible
                narration would be cut off.
              </p>
              <label className="audio-ack">
                <input
                  type="checkbox"
                  checked={acknowledgedCutoff}
                  onChange={(event) => setAcknowledgedCutoff(event.target.checked)}
                />
                I understand the narration ending will be cut off.
              </label>
            </div>
          ) : null}

          {activeElsewhere && activeJob ? (
            <p className="notice" role="status">
              A render is already running for “{activeJob.projectTitle}”. Wait for it to finish or
              cancel it there before starting another.
            </p>
          ) : null}

          {issues.length > 0 ? (
            <ul className="render-issues" role="alert">
              {issues.map((issue) => (
                <li key={`${issue.code}-${issue.sceneId ?? 'project'}`}>{issue.message}</li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <p className="notice" role="alert">
              {error}
            </p>
          ) : null}

          {startError ? (
            <p className="notice" role="alert">
              {startError}
            </p>
          ) : null}

          {storageError ? (
            <p className="notice" role="alert">
              {storageError}
            </p>
          ) : null}

          {status === 'completed' ? (
            <p className="notice" role="status">
              {displayRecord?.audio ? 'MP4 with audio rendered and saved in this browser.' : 'Silent MP4 rendered and saved in this browser.'}
            </p>
          ) : null}

          {displayRecord && resultUrl ? (
            <div className="render-result">
              <video
                className="render-video"
                src={resultUrl}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  setMeasured({
                    duration: video.duration,
                    width: video.videoWidth,
                    height: video.videoHeight,
                  });
                }}
              />

              <div className="row render-actions">
                <a
                  className="btn btn-primary"
                  href={resultUrl}
                  download={videoFilename(project, displayRecord.audio !== null && displayRecord.audio !== undefined)}
                >
                  Download MP4
                </a>
                <span className="muted-small">
                  Rendered {formatTimestamp(displayRecord.createdAt)}
                </span>
              </div>

              <dl className="render-details">
                <div>
                  <dt>File type</dt>
                  <dd>{displayRecord.mimeType}</dd>
                </div>
                <div>
                  <dt>File size</dt>
                  <dd>{formatBytes(displayRecord.byteSize)}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>
                    {measured
                      ? `${measured.duration.toFixed(2)} s (measured by the player)`
                      : `${(displayRecord.durationMs / 1000).toFixed(2)} s (encoded timestamps)`}
                  </dd>
                </div>
                <div>
                  <dt>Dimensions</dt>
                  <dd>
                    {measured
                      ? `${measured.width} × ${measured.height} (measured by the player)`
                      : `${displayRecord.width} × ${displayRecord.height} (reported by the encoder)`}
                  </dd>
                </div>
                <div>
                  <dt>Frame rate</dt>
                  <dd>
                    Target {displayRecord.targetFps} fps · verified{' '}
                    {displayRecord.verifiedFps.toFixed(2)} fps from encoded timestamps
                  </dd>
                </div>
                <div>
                  <dt>Frames encoded</dt>
                  <dd>{displayRecord.frameCount}</dd>
                </div>
                <div>
                  <dt>Audio</dt>
                  <dd>
                    {displayRecord.audio
                      ? `${displayRecord.audio.codec.toUpperCase()} · ${
                          displayRecord.audio.sampleRate / 1000
                        } kHz · ${displayRecord.audio.channels} ch · ${
                          displayRecord.snapshot.audio?.bitrate
                            ? `${displayRecord.snapshot.audio.bitrate / 1000} kbps · `
                            : ''
                        }${displayRecord.audio.trackCount} mixed track${
                          displayRecord.audio.trackCount === 1 ? '' : 's'
                        } · ${(displayRecord.audio.durationMs / 1000).toFixed(
                          2,
                        )} s · peak protection ${(
                          displayRecord.audio.peakGain * 100
                        ).toFixed(0)}%`
                      : 'None — the MP4 has no audio track'}
                  </dd>
                </div>
              </dl>

              <details className="render-snapshot">
                <summary>
                  Project snapshot · revision {displayRecord.snapshot.projectRevision} ·{' '}
                  {displayRecord.snapshot.scenes.length} scenes ·{' '}
                  {(displayRecord.snapshot.totalDurationMs / 1000).toFixed(2)} s
                </summary>
                <p className="muted-small">
                  Captured {formatTimestamp(displayRecord.snapshot.capturedAt)} · fingerprint{' '}
                  <code>{displayRecord.snapshot.contentFingerprint}</code> · 720×1280 at{' '}
                  {displayRecord.snapshot.output.fps} fps ·{' '}
                  {displayRecord.snapshot.audio?.tracks.filter((track) => track.included).length
                    ? `${displayRecord.snapshot.audio.tracks.filter((track) => track.included).length} included audio track(s)`
                    : 'no audio'}.
                </p>
                {displayRecord.snapshot.audio?.tracks.length ? (
                  <ul className="plain-list muted-small">
                    {displayRecord.snapshot.audio.tracks.map((track) => (
                      <li key={track.role}>
                        {track.role === 'narration' ? 'Narration' : 'Music'}: {track.fileName} ·{' '}
                        {track.included ? 'included' : 'excluded/muted'} · volume{' '}
                        {Math.round(track.volume * 100)}% ·{' '}
                        {track.included
                          ? `applied ${((track.appliedDurationMs ?? 0) / 1000).toFixed(2)} s, trimmed ${(
                              (track.trimmedMs ?? 0) / 1000
                            ).toFixed(2)} s`
                          : 'not encoded or trimmed'}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <ol className="render-snapshot-scenes">
                  {displayRecord.snapshot.scenes.map((scene) => (
                    <li key={scene.sceneId}>
                      {scene.index + 1}. {scene.title || 'Untitled scene'} —{' '}
                      {(scene.durationMs / 1000).toFixed(2)} s · {scene.framing} ·{' '}
                      {scene.onScreenText.trim() === ''
                        ? 'no on-screen text'
                        : `“${scene.onScreenText}”`}
                    </li>
                  ))}
                </ol>
              </details>

              {changedSinceRender ? (
                <p className="notice" role="status">
                  The project has changed since this MP4 was rendered. Render again to include the
                  current edits; this result stays tied to the snapshot above.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="muted">No rendered video yet. Attach an image to every scene, then render.</p>
          )}
        </Panel>

        <Panel title="Project data">
          <p>
            Export a readable JSON file containing the brief, script, source or story notes,
            storyboard, and audio settings.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                downloadTextFile(
                  projectDataFilename(project),
                  serializeProjectDataExport(project),
                )
              }
            >
              Export project data
            </button>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const saved = await store.flush();
                if (!saved.ok) setStorageError(saved.message ?? 'Saving failed.');
              }}
            >
              Save now
            </button>
          </div>
          <p className="muted-small">{PROJECT_DATA_DISCLAIMER}</p>
          <p className="muted-small">
            Metadata-only JSON is not a complete media backup: uploaded images, narration audio
            binaries, music audio binaries, and rendered videos are stored separately in this
            browser and are not included in this JSON file.
          </p>
        </Panel>
      </div>

      <Panel
        title="What this milestone does not include"
        description="Listed so nothing here is mistaken for a working integration."
      >
        <ul className="plain-list">
          <li>AI script and storyboard generation</li>
          <li>Generated images or video clips</li>
          <li>AI voice generation or generated music (you upload your own audio)</li>
          <li>Waveform editing, fades, ducking, or per-scene audio placement</li>
          <li>Synchronized captions or subtitle tracks (scene text is not a subtitle track)</li>
          <li>Transitions, motion, or effects (the render uses hard cuts)</li>
          <li>Accounts, cloud storage, and cross-device sync</li>
          <li>Usage tracking and billing</li>
        </ul>
        <p className="muted-small">
          Every project, uploaded image, uploaded audio file, and rendered video on this screen is
          stored in this browser only. Clearing site data removes them.
        </p>
      </Panel>

      <Panel
        title="Storyboard summary"
        description="Useful when checking a project before the render."
      >
        {project.storyboard.scenes.length === 0 ? (
          <p className="muted">No scenes yet.</p>
        ) : (
          <table className="summary-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Scene</th>
                <th scope="col">Asset type</th>
                <th scope="col">Image</th>
                <th scope="col">Framing</th>
                <th scope="col">Planned</th>
                <th scope="col">Status</th>
                <th scope="col">Locks</th>
              </tr>
            </thead>
            <tbody>
              {project.storyboard.scenes.map((scene, position) => (
                <tr key={scene.id}>
                  <td>{position + 1}</td>
                  <td>{scene.title || 'Untitled scene'}</td>
                  <td>{ASSET_TYPE_LABELS[scene.assetType]}</td>
                  <td>{scene.imageAssetId ? 'Attached' : 'Missing'}</td>
                  <td>{scene.imageFraming}</td>
                  <td>{formatDuration(scene.plannedDuration)}</td>
                  <td>{scene.status === 'approved' ? 'Approved' : 'Draft'}</td>
                  <td>
                    {[
                      scene.locks.narration ? 'narration' : null,
                      scene.locks.visuals ? 'visuals' : null,
                      scene.locks.text ? 'text' : null,
                      scene.locks.timing ? 'timing' : null,
                    ]
                      .filter(Boolean)
                      .join(', ') || 'none'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
