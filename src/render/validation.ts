import type { RenderSnapshot } from './snapshot';
import { MAX_TOTAL_SECONDS } from './mp4';

export interface RenderAssetInfo {
  id: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
}

export interface RenderAudioInfo {
  id: string;
  mimeType: string;
  durationMs: number;
  byteSize: number;
}

export type SnapshotIssueCode =
  | 'no-scenes'
  | 'too-long'
  | 'zero-duration'
  | 'missing-image'
  | 'missing-asset'
  | 'unsupported-media'
  | 'invalid-dimensions'
  | 'missing-audio'
  | 'unsupported-audio'
  | 'invalid-audio'
  | 'narration-cutoff';

export interface SnapshotIssue {
  code: SnapshotIssueCode;
  message: string;
  sceneId?: string;
}

const SUPPORTED_MIME_TYPES = ['image/jpeg', 'image/png'];
const SUPPORTED_AUDIO_MIME_TYPES = [
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
];
export const NARRATION_CUTOFF_TOLERANCE_MS = 250;

/**
 * Validate a snapshot and the image metadata it depends on before any frame is
 * encoded. Every problem is reported together so the user can fix the board.
 */
export function validateRenderSnapshot(
  snapshot: RenderSnapshot,
  assets: Map<string, RenderAssetInfo>,
  audioAssets: Map<string, RenderAudioInfo> = new Map(),
): SnapshotIssue[] {
  const issues: SnapshotIssue[] = [];

  if (snapshot.scenes.length === 0) {
    issues.push({ code: 'no-scenes', message: 'The storyboard has no scenes to render.' });
    return issues;
  }

  const maxFrames = MAX_TOTAL_SECONDS * snapshot.output.fps;
  if (snapshot.totalFrames > maxFrames) {
    issues.push({
      code: 'too-long',
      message: `The render is ${(snapshot.totalFrames / snapshot.output.fps).toFixed(
        0,
      )} seconds long. The limit for one render is ${MAX_TOTAL_SECONDS} seconds.`,
    });
  }

  for (const track of snapshot.audio.tracks) {
    if (!track.included) continue;
    const label = track.role === 'narration' ? 'Narration' : 'Background music';
    const asset = audioAssets.get(track.assetId);
    if (!asset) {
      issues.push({
        code: 'missing-audio',
        message: `${label} audio “${track.fileName}” is missing from this browser. Re-attach it and render again.`,
      });
      continue;
    }
    if (!SUPPORTED_AUDIO_MIME_TYPES.includes(asset.mimeType)) {
      issues.push({
        code: 'unsupported-audio',
        message: `${label} uses ${asset.mimeType || 'an unknown file type'}. Use a WAV, MP3, M4A, AAC, OGG, WebM, or FLAC file.`,
      });
      continue;
    }
    if (asset.durationMs <= 0) {
      issues.push({
        code: 'invalid-audio',
        message: `${label} audio has no measurable duration. Replace it.`,
      });
    }
  }

  const narration = snapshot.audio.tracks.find(
    (track) => track.role === 'narration' && track.included,
  );
  if (
    narration?.sourceDurationMs !== null &&
    narration?.sourceDurationMs !== undefined &&
    narration.sourceDurationMs > snapshot.totalDurationMs + NARRATION_CUTOFF_TOLERANCE_MS &&
    !snapshot.audio.narrationCutoffAcknowledged
  ) {
    issues.push({
      code: 'narration-cutoff',
      message: `Narration is ${(narration.sourceDurationMs / 1000).toFixed(
        1,
      )} s but the storyboard is ${(snapshot.totalDurationMs / 1000).toFixed(
        1,
      )} s. Acknowledge that the ending will be cut off before rendering.`,
    });
  }

  for (const scene of snapshot.scenes) {
    const label = `Scene ${scene.index + 1} “${scene.title || 'Untitled scene'}”`;
    if (scene.plannedDurationMs <= 0) {
      issues.push({
        code: 'zero-duration',
        sceneId: scene.sceneId,
        message: `${label} has a planned duration of 0 seconds. Give it at least one second.`,
      });
      continue;
    }
    if (!scene.imageAssetId) {
      issues.push({
        code: 'missing-image',
        sceneId: scene.sceneId,
        message: `${label} has no image attached. Attach an image in the storyboard before rendering.`,
      });
      continue;
    }
    const asset = assets.get(scene.imageAssetId);
    if (!asset) {
      issues.push({
        code: 'missing-asset',
        sceneId: scene.sceneId,
        message: `${label} points at an image that is missing from this browser. Re-attach the image and render again.`,
      });
      continue;
    }
    if (!SUPPORTED_MIME_TYPES.includes(asset.mimeType)) {
      issues.push({
        code: 'unsupported-media',
        sceneId: scene.sceneId,
        message: `${label} uses ${asset.mimeType || 'an unknown file type'}. Only JPEG and PNG images can be rendered.`,
      });
      continue;
    }
    if (asset.width <= 0 || asset.height <= 0) {
      issues.push({
        code: 'invalid-dimensions',
        sceneId: scene.sceneId,
        message: `${label} has an image with invalid dimensions. Re-attach it.`,
      });
    }
  }

  return issues;
}
