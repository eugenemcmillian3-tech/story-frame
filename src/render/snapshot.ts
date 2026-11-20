import { fingerprintText } from '../domain/fingerprint';
import type { ImageFraming, Project } from '../domain/types';
import { OUTPUT_FPS, OUTPUT_HEIGHT, OUTPUT_MIME, OUTPUT_WIDTH } from './mp4';

export const SNAPSHOT_VERSION = 2 as const;

export interface SnapshotScene {
  sceneId: string;
  index: number;
  title: string;
  imageAssetId: string | null;
  framing: ImageFraming;
  plannedDurationMs: number;
  /** Frames are the unit that is actually encoded for this scene. */
  frameCount: number;
  /** Encoded duration after rounding the planned duration to whole frames. */
  durationMs: number;
  onScreenText: string;
}

export interface SnapshotAudioTrack {
  role: 'narration' | 'music';
  assetId: string;
  fileName: string;
  volume: number;
  muted: boolean;
  /** False for muted tracks: they are neither encoded nor trimmed. */
  included: boolean;
  sourceDurationMs: number | null;
  appliedDurationMs: number | null;
  trimmedMs: number | null;
}

export interface RenderSnapshotAudio {
  codec: 'opus';
  sampleRate: number;
  channels: number;
  bitrate: number;
  narrationCutoffAcknowledged: boolean;
  tracks: SnapshotAudioTrack[];
}

export interface RenderSnapshot {
  version: typeof SNAPSHOT_VERSION;
  projectId: string;
  projectTitle: string;
  projectRevision: number;
  capturedAt: string;
  output: {
    width: number;
    height: number;
    fps: number;
    container: 'mp4';
    codec: 'h264';
    mimeType: string;
    audio: boolean;
  };
  audio: RenderSnapshotAudio;
  scenes: SnapshotScene[];
  totalFrames: number;
  totalDurationMs: number;
  contentFingerprint: string;
}

/** Every distinct image a snapshot needs, in first-use order. */
export function collectImageAssetIds(snapshot: RenderSnapshot): string[] {
  return [
    ...new Set(
      snapshot.scenes
        .map((scene) => scene.imageAssetId)
        .filter((id): id is string => id !== null),
    ),
  ];
}

/**
 * Immutable description of exactly what a render will encode. Order, ids,
 * durations, framing, text, and image ids are copied; later edits to the
 * project cannot change a job that is already running.
 */
export function collectAudioAssetIds(snapshot: RenderSnapshot): string[] {
  return [
    ...new Set(
      snapshot.audio.tracks.filter((track) => track.included).map((track) => track.assetId),
    ),
  ];
}

export function buildRenderSnapshot(
  project: Project,
  capturedAt: string = new Date().toISOString(),
  options: { acknowledgeNarrationCutoff?: boolean } = {},
): RenderSnapshot {
  const fps = OUTPUT_FPS;
  const scenes: SnapshotScene[] = project.storyboard.scenes.map((scene, index) => {
    const plannedDurationMs = Math.max(0, Math.round(scene.plannedDuration * 1000));
    const frameCount = Math.max(1, Math.round((plannedDurationMs / 1000) * fps));
    return {
      sceneId: scene.id,
      index,
      title: scene.title,
      imageAssetId: scene.imageAssetId,
      framing: scene.imageFraming,
      plannedDurationMs,
      frameCount,
      durationMs: (frameCount * 1000) / fps,
      onScreenText: scene.onScreenText,
    };
  });
  const totalFrames = scenes.reduce((total, scene) => total + scene.frameCount, 0);
  const totalDurationMs = (totalFrames * 1000) / fps;
  const tracks: SnapshotAudioTrack[] = [];
  for (const role of ['narration', 'music'] as const) {
    const track = project.audio[role];
    if (!track.assetId) continue;
    const included = !track.muted;
    const sourceDurationMs = track.durationMs;
    tracks.push({
      role,
      assetId: track.assetId,
      fileName: track.fileName ?? 'Uploaded audio',
      volume: track.volume,
      muted: track.muted,
      included,
      sourceDurationMs,
      appliedDurationMs:
        included && sourceDurationMs !== null
          ? Math.min(sourceDurationMs, totalDurationMs)
          : null,
      trimmedMs:
        included && sourceDurationMs !== null
          ? Math.max(0, sourceDurationMs - totalDurationMs)
          : null,
    });
  }
  const audio: RenderSnapshotAudio = {
    codec: 'opus',
    sampleRate: 48_000,
    channels: 2,
    bitrate: 128_000,
    narrationCutoffAcknowledged: options.acknowledgeNarrationCutoff === true,
    tracks,
  };
  const output = {
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    fps,
    container: 'mp4' as const,
    codec: 'h264' as const,
    mimeType: OUTPUT_MIME,
    audio: tracks.some((track) => track.included),
  };
  const contentFingerprint = fingerprintText(
    JSON.stringify({
      projectId: project.id,
      output,
      audio: audio.tracks.map((track) => ({
        role: track.role,
        assetId: track.assetId,
        volume: track.volume,
        muted: track.muted,
        durationMs: track.sourceDurationMs,
      })),
      scenes: scenes.map((scene) => ({
        id: scene.sceneId,
        image: scene.imageAssetId,
        framing: scene.framing,
        frames: scene.frameCount,
        text: scene.onScreenText,
      })),
    }),
  );

  return {
    version: SNAPSHOT_VERSION,
    projectId: project.id,
    projectTitle: project.title,
    projectRevision: project.contentRevision,
    capturedAt,
    output,
    audio,
    scenes,
    totalFrames,
    totalDurationMs,
    contentFingerprint,
  };
}
