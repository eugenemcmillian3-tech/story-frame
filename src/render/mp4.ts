import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import {
  AUDIO_BITRATE,
  AUDIO_CHANNELS,
  AUDIO_CODEC,
  AUDIO_SAMPLE_RATE,
  mixAudioSources,
} from './audioMixing';
import type { AudioSource, MixedAudio } from './audioMixing';

/**
 * Silent, hard-cut MP4 encoding with WebCodecs + mp4-muxer.
 *
 * This is real H.264 in an MP4 container. It never renames a WebM or a JSON
 * file: if the browser cannot configure an AVC encoder, encoding fails with an
 * explicit error instead of producing a mislabeled artifact.
 */
export const OUTPUT_WIDTH = 720;
export const OUTPUT_HEIGHT = 1280;
export const OUTPUT_FPS = 30;
export const OUTPUT_MIME = 'video/mp4';
export const MAX_TOTAL_SECONDS = 300;

/** Level 4.0 then 3.1, both widely supported by desktop Chromium. */
const AVC_CODECS = ['avc1.420028', 'avc1.4d0028', 'avc1.640028'] as const;

export class RenderCanceledError extends Error {
  constructor() {
    super('Rendering was canceled.');
    this.name = 'RenderCanceledError';
  }
}

export type DrawFrame = (
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frameIndex: number,
) => void;

export interface SilentMp4Options {
  width: number;
  height: number;
  fps: number;
  bitrate?: number;
  totalFrames: number;
  draw: DrawFrame;
  signal?: AbortSignal;
  onProgress?: (encodedFrames: number, totalFrames: number) => void;
  audio?: { sources: AudioSource[]; durationSeconds: number };
}

export interface SilentMp4Result {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  frameCount: number;
  targetFps: number;
  /** Measured from the encoded chunks' timestamps, not assumed from the target. */
  verifiedFps: number;
  durationMs: number;
  bytes: number;
  codec: string;
  audio: {
    codec: typeof AUDIO_CODEC;
    sampleRate: number;
    channels: number;
    trackCount: number;
    durationMs: number;
    peakGain: number;
    sourcePeak: number;
  } | null;
}

export async function pickAvcCodec(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<string> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error(
      'This browser has no WebCodecs VideoEncoder, so MP4 cannot be encoded here.',
    );
  }
  for (const codec of AVC_CODECS) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        framerate: fps,
        bitrate,
      });
      if (support.supported) return codec;
    } catch {
      // Try the next level/codec string.
    }
  }
  throw new Error(
    'This browser cannot configure an H.264 (AVC) encoder, so a real MP4 cannot be produced here.',
  );
}

/**
 * Yield to the event loop without a timer. A hidden tab clamps chained
 * `setTimeout` callbacks to once per second, and once per minute after five
 * minutes, so a timer-based yield stalls an encode the user has switched away
 * from. Message events are not throttled that way, so the encoder's own
 * callbacks keep running and the frame loop keeps advancing.
 */
const yieldChannel = new MessageChannel();
const yieldQueue: Array<() => void> = [];
yieldChannel.port1.onmessage = () => {
  yieldQueue.shift()?.();
};

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    yieldQueue.push(resolve);
    yieldChannel.port2.postMessage(null);
  });
}

function createCanvas(width: number, height: number): {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not create a 2D render surface.');
    return { canvas, context };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser could not create a 2D render surface.');
  return { canvas, context };
}

/**
 * Encode `totalFrames` silent frames at a fixed rate and return a finalized MP4
 * blob. Frames are produced one at a time; the canvas is reused, and encoder
 * backpressure bounds how many frames are in flight.
 */
async function encodeAudioTrack(
  mixed: MixedAudio,
  muxer: Muxer<ArrayBufferTarget>,
  signal?: AbortSignal,
): Promise<{ chunks: number; durationMs: number }> {
  if (typeof AudioEncoder === 'undefined') {
    throw new Error('This browser has no WebCodecs AudioEncoder, so the uploaded audio cannot be encoded.');
  }
  const support = await AudioEncoder.isConfigSupported({
    codec: AUDIO_CODEC,
    sampleRate: mixed.sampleRate,
    numberOfChannels: mixed.channels,
    bitrate: AUDIO_BITRATE,
  });
  if (!support.supported) {
    throw new Error('This browser cannot configure an Opus audio encoder, so the uploaded audio cannot be included.');
  }

  let chunks = 0;
  let encoderError: Error | null = null;
  let firstTimestamp: number | null = null;
  let lastEnd = 0;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      chunks += 1;
      if (firstTimestamp === null) firstTimestamp = chunk.timestamp;
      lastEnd = chunk.timestamp + (chunk.duration ?? Math.round(1_000_000 / 50));
      muxer.addAudioChunk(chunk, meta);
    },
    error: (error) => {
      encoderError = error instanceof Error ? error : new Error(String(error));
    },
  });
  try {
    encoder.configure({
      codec: AUDIO_CODEC,
      sampleRate: mixed.sampleRate,
      numberOfChannels: mixed.channels,
      bitrate: AUDIO_BITRATE,
    });
    const blockSize = 960;
    for (let offset = 0; offset < mixed.totalSamples; offset += blockSize) {
      if (signal?.aborted) throw new RenderCanceledError();
      if (encoderError) throw encoderError;
      const frames = Math.min(blockSize, mixed.totalSamples - offset);
      const data = new Float32Array(frames * mixed.channels);
      data.set(mixed.left.subarray(offset, offset + frames), 0);
      data.set(mixed.right.subarray(offset, offset + frames), frames);
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: mixed.sampleRate,
        numberOfFrames: frames,
        numberOfChannels: mixed.channels,
        timestamp: Math.round((offset / mixed.sampleRate) * 1_000_000),
        data,
      });
      encoder.encode(audioData);
      audioData.close();
      while (encoder.encodeQueueSize > 4) {
        await yieldToMain();
        if (signal?.aborted) throw new RenderCanceledError();
        if (encoderError) throw encoderError;
      }
    }
    await encoder.flush();
    if (encoderError) throw encoderError;
    if (signal?.aborted) throw new RenderCanceledError();
    if (chunks === 0) throw new Error('Audio encoding produced no data. Nothing was saved.');
    return {
      chunks,
      durationMs:
        firstTimestamp === null ? 0 : Math.max(0, (lastEnd - firstTimestamp) / 1000),
    };
  } finally {
    try {
      if (encoder.state !== 'closed') encoder.close();
    } catch {
      // Already closed.
    }
  }
}

export async function encodeSilentMp4(options: SilentMp4Options): Promise<SilentMp4Result> {
  const { width, height, fps, totalFrames, draw, signal, onProgress } = options;
  if (totalFrames <= 0) throw new Error('A render needs at least one frame.');
  const bitrate = options.bitrate ?? 2_500_000;
  const codec = await pickAvcCodec(width, height, fps, bitrate);

  const sources = options.audio?.sources ?? [];
  const mixed =
    sources.length > 0
      ? await mixAudioSources(sources, options.audio?.durationSeconds ?? totalFrames / fps)
      : null;
  if (signal?.aborted) throw new RenderCanceledError();

  const { canvas, context } = createCanvas(width, height);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    ...(mixed
      ? {
          audio: {
            codec: AUDIO_CODEC,
            numberOfChannels: AUDIO_CHANNELS,
            sampleRate: AUDIO_SAMPLE_RATE,
          },
        }
      : {}),
    fastStart: 'in-memory',
  });
  const encodedAudio = mixed ? await encodeAudioTrack(mixed, muxer, signal) : null;

  let firstTimestamp: number | null = null;
  let lastTimestamp = 0;
  let encodedChunks = 0;
  let encoderError: Error | null = null;

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (firstTimestamp === null) firstTimestamp = chunk.timestamp;
      lastTimestamp = chunk.timestamp;
      encodedChunks += 1;
      muxer.addVideoChunk(chunk, metadata);
    },
    error: (error) => {
      encoderError = error instanceof Error ? error : new Error(String(error));
    },
  });

  encoder.configure({
    codec,
    width,
    height,
    framerate: fps,
    bitrate,
    latencyMode: 'quality',
    avc: { format: 'avc' },
  });

  let canceled = false;
  const onAbort = () => {
    canceled = true;
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) canceled = true;

  try {
    const frameDurationUs = Math.round(1_000_000 / fps);
    for (let index = 0; index < totalFrames; index += 1) {
      if (canceled) throw new RenderCanceledError();
      if (encoderError) throw encoderError;

      draw(context, index);
      const frame = new VideoFrame(canvas as CanvasImageSource, {
        timestamp: Math.round((index * 1_000_000) / fps),
        duration: frameDurationUs,
      });
      encoder.encode(frame, { keyFrame: index % (fps * 2) === 0 });
      frame.close();

      while (encoder.encodeQueueSize > 6) {
        await yieldToMain();
        if (canceled) throw new RenderCanceledError();
        if (encoderError) throw encoderError;
      }

      if (index % 5 === 0) {
        onProgress?.(index + 1, totalFrames);
        await yieldToMain();
      }
    }

    onProgress?.(totalFrames, totalFrames);
    await encoder.flush();
    if (encoderError) throw encoderError;
    if (canceled) throw new RenderCanceledError();
    muxer.finalize();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      if (encoder.state !== 'closed') encoder.close();
    } catch {
      // Already closed.
    }
  }

  const buffer = (muxer.target as ArrayBufferTarget).buffer;
  if (!buffer || buffer.byteLength === 0) {
    throw new Error('Encoding produced no MP4 data. Nothing was saved.');
  }
  const durationMs =
    encodedChunks > 0
      ? ((lastTimestamp - (firstTimestamp ?? 0)) / 1000) + 1000 / fps
      : (totalFrames / fps) * 1000;
  const verifiedFps = durationMs > 0 ? (encodedChunks / durationMs) * 1000 : 0;

  return {
    blob: new Blob([buffer], { type: OUTPUT_MIME }),
    mimeType: OUTPUT_MIME,
    width,
    height,
    frameCount: encodedChunks,
    targetFps: fps,
    verifiedFps,
    durationMs,
    bytes: buffer.byteLength,
    codec,
    audio: encodedAudio
      ? {
          codec: AUDIO_CODEC,
          sampleRate: AUDIO_SAMPLE_RATE,
          channels: AUDIO_CHANNELS,
          trackCount: sources.length,
          durationMs: encodedAudio.durationMs,
          peakGain: mixed?.peakGain ?? 1,
          sourcePeak: mixed?.sourcePeak ?? 0,
        }
      : null,
  };
}
