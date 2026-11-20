import { describe, expect, it, vi } from 'vitest';
import { storeAudioFile } from '../src/media/audioAssets';
import type { AudioAssetRecord } from '../src/media/mediaDb';

/** The write is captured so the record storeAudioFile builds can be inspected. */
const media = vi.hoisted(() => ({ written: null as AudioAssetRecord | null }));

vi.mock('../src/media/mediaDb', () => ({
  getAudioAsset: async () => undefined,
  putAudioAsset: async (record: AudioAssetRecord) => {
    media.written = record;
  },
}));

/** Stub the browser decode, not the module, so the real storeAudioFile runs. */
class FakeAudioContext {
  async decodeAudioData() {
    return { duration: 2, length: 96_000, sampleRate: 48_000, numberOfChannels: 1 };
  }
  async close() {}
}

(globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;

describe('storeAudioFile', () => {
  it('writes the narration take an upload replaces', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'take.wav', { type: 'audio/wav' });
    // jsdom's Blob does not always expose arrayBuffer(); decodeAudioData is stubbed anyway.
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });

    await storeAudioFile('prj_upload', file, 'aud_generated');

    expect(media.written).toMatchObject({
      source: 'upload',
      generation: null,
      replacesAssetId: 'aud_generated',
    });
  });
});
