export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BITRATE = 128_000;
export const AUDIO_CODEC = 'opus' as const;
export const AUDIO_CODEC_STRING = 'opus' as const;

export interface AudioSource {
  role: 'narration' | 'music';
  blob: Blob;
  volume: number;
}

export interface MixedAudio {
  sampleRate: number;
  channels: number;
  totalSamples: number;
  left: Float32Array;
  right: Float32Array;
  /** Peak scaling applied to the whole mix to prevent clipping. */
  peakGain: number;
  /** Worst-case summed source peak before protection. */
  sourcePeak: number;
}

function sampleAt(buffer: AudioBuffer, channel: number, outputIndex: number, ratio: number): number {
  const index = outputIndex * ratio;
  const lower = Math.floor(index);
  if (lower >= buffer.length) return 0;
  const upper = Math.min(buffer.length - 1, lower + 1);
  const fraction = index - lower;
  const data = buffer.getChannelData(channel);
  return data[lower] * (1 - fraction) + data[upper] * fraction;
}

/**
 * Decode and mix every included track from t=0 for exactly `durationSeconds`.
 * Longer tracks are truncated by the output length; shorter tracks are followed
 * by silence. Music never loops and narration is never time-stretched.
 *
 * Clipping protection is conservative: the summed worst-case peak of all tracks
 * is measured, and if it exceeds 0.98 the whole mix is scaled down so the sum
 * cannot clip. This is not sample-peak normalization of the final mix.
 */
export async function mixAudioSources(
  sources: AudioSource[],
  durationSeconds: number,
): Promise<MixedAudio> {
  if (sources.length === 0) throw new Error('No audio tracks were selected for mixing.');
  const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  try {
    const buffers: Array<{ buffer: AudioBuffer; volume: number }> = [];
    let sourcePeak = 0;
    for (const source of sources) {
      const buffer = await context.decodeAudioData(await source.blob.arrayBuffer());
      buffers.push({ buffer, volume: source.volume });
      let peak = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let index = 0; index < data.length; index += 1) {
          const value = Math.abs(data[index]);
          if (value > peak) peak = value;
        }
      }
      sourcePeak += peak * source.volume;
    }

    const totalSamples = Math.max(1, Math.round(durationSeconds * AUDIO_SAMPLE_RATE));
    const peakGain = sourcePeak > 0.98 ? 0.98 / sourcePeak : 1;
    const left = new Float32Array(totalSamples);
    const right = new Float32Array(totalSamples);

    for (const { buffer, volume } of buffers) {
      const gain = volume * peakGain;
      const ratio = buffer.sampleRate / AUDIO_SAMPLE_RATE;
      const rightChannel = buffer.numberOfChannels > 1 ? 1 : 0;
      for (let index = 0; index < totalSamples; index += 1) {
        left[index] += sampleAt(buffer, 0, index, ratio) * gain;
        right[index] += sampleAt(buffer, rightChannel, index, ratio) * gain;
      }
    }

    return {
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      totalSamples,
      left,
      right,
      peakGain,
      sourcePeak,
    };
  } finally {
    await context.close();
  }
}
