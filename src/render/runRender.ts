import { RenderCanceledError, encodeSilentMp4 } from './mp4';
import type { SilentMp4Result } from './mp4';
import { drawSceneFrame } from './draw';
import { collectImageAssetIds } from './snapshot';
import type { RenderSnapshot } from './snapshot';

export interface RenderVideoInput {
  snapshot: RenderSnapshot;
  /** Original image bytes keyed by asset id. */
  assets: Map<string, Blob>;
  /** Included narration/music bytes keyed by audio asset id. */
  audioAssets?: Map<string, Blob>;
  signal?: AbortSignal;
  onProgress?: (encodedFrames: number, totalFrames: number) => void;
}

interface FrameRange {
  start: number;
  end: number;
  sceneIndex: number;
}

/**
 * Decode the attached images, then stream frames through the MP4 encoder.
 * Bitmaps and encoder state are released on success, failure, and cancellation.
 */
export async function renderSnapshotToMp4(input: RenderVideoInput): Promise<SilentMp4Result> {
  const { snapshot, assets, audioAssets, signal, onProgress } = input;
  const uniqueIds = collectImageAssetIds(snapshot);

  const bitmaps = new Map<string, ImageBitmap>();
  try {
    for (const id of uniqueIds) {
      if (signal?.aborted) throw new RenderCanceledError();
      const blob = assets.get(id);
      if (!blob) {
        throw new Error('An attached image is missing from this browser. Re-attach it and try again.');
      }
      try {
        bitmaps.set(id, await createImageBitmap(blob));
      } catch {
        throw new Error('An attached image could not be decoded. Replace it with a valid JPEG or PNG.');
      }
      if (signal?.aborted) throw new RenderCanceledError();
    }

    const audioSources = (snapshot.audio?.tracks ?? [])
      .filter((track) => track.included)
      .map((track) => {
        const blob = audioAssets?.get(track.assetId);
        if (!blob) {
          throw new Error(`The ${track.role} audio is missing from this browser. Re-attach it and try again.`);
        }
        return { role: track.role, blob, volume: track.volume };
      });

    const ranges: FrameRange[] = [];
    let frameCursor = 0;
    snapshot.scenes.forEach((scene, sceneIndex) => {
      ranges.push({ start: frameCursor, end: frameCursor + scene.frameCount, sceneIndex });
      frameCursor += scene.frameCount;
    });

    let rangeIndex = 0;
    return await encodeSilentMp4({
      width: snapshot.output.width,
      height: snapshot.output.height,
      fps: snapshot.output.fps,
      totalFrames: snapshot.totalFrames,
      signal,
      onProgress,
      audio:
        audioSources.length > 0
          ? { sources: audioSources, durationSeconds: snapshot.totalDurationMs / 1000 }
          : undefined,
      draw: (context, frameIndex) => {
        while (rangeIndex < ranges.length - 1 && frameIndex >= ranges[rangeIndex].end) {
          rangeIndex += 1;
        }
        const range = ranges[rangeIndex];
        const scene = snapshot.scenes[range.sceneIndex];
        const bitmap = scene.imageAssetId ? bitmaps.get(scene.imageAssetId) : undefined;
        if (!bitmap) throw new Error('An attached image is missing from this render.');
        drawSceneFrame(
          context,
          { bitmap, framing: scene.framing, text: scene.onScreenText },
          snapshot.output.width,
          snapshot.output.height,
        );
      },
    });
  } finally {
    for (const bitmap of bitmaps.values()) bitmap.close();
  }
}
