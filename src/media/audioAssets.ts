import { newId } from '../domain/ids';
import type { NarrationTake } from '../domain/types';
import { getAudioAsset, putAudioAsset } from './mediaDb';
import type { AudioAssetRecord } from './mediaDb';

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_DURATION_SECONDS = 600;
export const ACCEPTED_AUDIO_MIME_TYPES = [
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
] as const;

export interface AudioFileMeta {
  name: string;
  type: string;
  size: number;
}

/** Cheap checks before decoding; decoding is the real format validation. */
export function validateAudioFileMeta(file: AudioFileMeta): string | null {
  if (!(ACCEPTED_AUDIO_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'That file type is not supported. Try a WAV, MP3, M4A, AAC, OGG, WebM, or FLAC audio file.';
  }
  if (file.size <= 0) return 'That audio file is empty.';
  if (file.size > MAX_AUDIO_BYTES) {
    return `That audio file is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is ${
      MAX_AUDIO_BYTES / (1024 * 1024)
    } MB per track.`;
  }
  return null;
}

export interface DecodedAudio {
  durationMs: number;
  sampleRate: number;
  channels: number;
}

/**
 * Decode the actual audio samples. A file with a plausible type but corrupt
 * bytes is rejected here, before anything is written to the media store.
 */
export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const metaError = validateAudioFileMeta(file);
  if (metaError) throw new Error(metaError);
  if (typeof AudioContext === 'undefined') {
    throw new Error('This browser cannot decode audio uploads.');
  }

  const context = new AudioContext({ sampleRate: 48_000 });
  try {
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new Error(
        'That file could not be decoded as audio. It may be damaged or use a codec this browser cannot read.',
      );
    }
    if (buffer.duration <= 0 || buffer.length === 0) {
      throw new Error('That audio file has no measurable duration.');
    }
    if (buffer.duration > MAX_AUDIO_DURATION_SECONDS) {
      throw new Error(
        `That audio is ${buffer.duration.toFixed(0)} seconds long. The limit is ${
          MAX_AUDIO_DURATION_SECONDS / 60
        } minutes per track.`,
      );
    }
    return {
      durationMs: Math.round(buffer.duration * 1000),
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
    };
  } finally {
    await context.close();
  }
}

/** Validate, decode, then store the original bytes under a stable audio id. */
export async function storeAudioFile(
  projectId: string,
  file: File,
): Promise<AudioAssetRecord> {
  const decoded = await decodeAudioFile(file);
  const record: AudioAssetRecord = {
    id: newId('aud'),
    projectId,
    name: file.name.slice(0, 160) || 'Uploaded audio',
    mimeType: file.type,
    byteSize: file.size,
    durationMs: decoded.durationMs,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    createdAt: new Date().toISOString(),
    blob: file,
    source: 'upload',
    generation: null,
    replacesAssetId: null,
  };
  await putAudioAsset(record);
  return record;
}

/**
 * Point an existing take at the one it now replaces. Restoring an older
 * narration uses this so the take being swapped out stays reachable from the
 * restored one, and the two can be swapped again later.
 */
export async function linkAudioAssetReplacement(
  assetId: string,
  replacesAssetId: string,
): Promise<void> {
  const record = await getAudioAsset(assetId);
  if (!record) throw new Error('That narration is no longer stored in this browser.');
  await putAudioAsset({ ...record, replacesAssetId });
}

/**
 * Store generated narration exactly like an upload, but keep its provenance and
 * the take it replaces. The duration is decoded from the returned bytes, never
 * taken from the provider's word.
 */
export async function storeGeneratedNarration(
  projectId: string,
  blob: Blob,
  take: NarrationTake,
  replacesAssetId: string | null,
): Promise<AudioAssetRecord> {
  const fileName = `narration-${take.voice}-${take.jobId.slice(-6)}.mp3`;
  const file = new File([blob], fileName, { type: blob.type || 'audio/mpeg' });
  const decoded = await decodeAudioFile(file);
  const record: AudioAssetRecord = {
    id: newId('aud'),
    projectId,
    name: fileName,
    mimeType: file.type,
    byteSize: file.size,
    durationMs: decoded.durationMs,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    createdAt: new Date().toISOString(),
    blob: file,
    source: 'generated',
    generation: take,
    replacesAssetId,
  };
  await putAudioAsset(record);
  return record;
}
