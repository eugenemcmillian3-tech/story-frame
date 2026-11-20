import { afterEach, describe, expect, it, vi } from 'vitest';
import { mixAudioSources } from '../src/render/audioMixing';

const decoded = new Map<number, AudioBuffer>();
let closed = 0;

function fakeBuffer(frames: number, amplitude: number): AudioBuffer {
  const data = new Float32Array(frames);
  data.fill(amplitude);
  return {
    sampleRate: 48_000,
    length: frames,
    numberOfChannels: 1,
    duration: frames / 48_000,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

class FakeAudioContext {
  constructor(public options?: AudioContextOptions) {}

  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    const id = new Uint8Array(data)[0]!;
    const buffer = decoded.get(id);
    if (!buffer) throw new Error('Undecodable test blob.');
    return buffer;
  }

  async close(): Promise<void> {
    closed += 1;
  }
}

function blob(id: number): Blob {
  return {
    arrayBuffer: async () => new Uint8Array([id]).buffer,
  } as Blob;
}

afterEach(() => {
  decoded.clear();
  closed = 0;
  vi.unstubAllGlobals();
});

describe('audio mixing', () => {
  it('trims longer audio to the storyboard duration and leaves silence after shorter audio', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    decoded.set(1, fakeBuffer(960, 0.5));

    const trimmed = await mixAudioSources([{ role: 'music', blob: blob(1), volume: 1 }], 0.01);
    expect(trimmed.totalSamples).toBe(480);
    expect(trimmed.left).toHaveLength(480);
    expect(trimmed.left[479]).toBeCloseTo(0.5, 5);
    expect(trimmed.peakGain).toBe(1);

    const padded = await mixAudioSources([{ role: 'narration', blob: blob(1), volume: 1 }], 0.03);
    expect(padded.left).toHaveLength(1440);
    expect(padded.left[479]).toBeCloseTo(0.5, 5);
    expect(padded.left[1000]).toBe(0);
    expect(padded.right[1000]).toBe(0);
    expect(closed).toBe(2);
  });

  it('applies volume and conservative gain when summed peaks would clip', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    decoded.set(1, fakeBuffer(480, 0.8));
    decoded.set(2, fakeBuffer(480, 0.8));

    const mixed = await mixAudioSources(
      [
        { role: 'narration', blob: blob(1), volume: 1 },
        { role: 'music', blob: blob(2), volume: 0.5 },
      ],
      0.01,
    );
    expect(mixed.sourcePeak).toBeCloseTo(1.2, 5);
    expect(mixed.peakGain).toBeCloseTo(0.98 / 1.2, 5);
    expect(mixed.left[0]).toBeCloseTo(0.98, 5);
    expect(mixed.right[0]).toBeCloseTo(0.98, 5);
    expect(closed).toBe(1);
  });

  it('rejects an empty selection and still closes the context on decode failure', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    await expect(mixAudioSources([], 1)).rejects.toThrow(/No audio tracks/);
    await expect(
      mixAudioSources([{ role: 'music', blob: blob(99), volume: 1 }], 1),
    ).rejects.toThrow(/Undecodable/);
    expect(closed).toBe(1);
  });
});
