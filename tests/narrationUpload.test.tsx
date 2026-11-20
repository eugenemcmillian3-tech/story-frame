import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AudioTracksPanel } from '../src/components/AudioTracksPanel';
import { createProject, updateAudioTrack } from '../src/domain/project';
import type { NarrationTake } from '../src/domain/types';
import type { AudioAssetRecord } from '../src/media/mediaDb';
import { ProjectRepository } from '../src/persistence/projectRepository';
import { StoreProvider } from '../src/state/StoreProvider';
import { ProjectStore } from '../src/state/store';
import { MemoryStorage } from './helpers';

/** Only the write is replaced: the question is which id the panel hands it. */
const media = vi.hoisted(() => ({
  current: null as AudioAssetRecord | null,
  storeAudioFile: vi.fn(),
}));

vi.mock('../src/media/mediaDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/media/mediaDb')>();
  return { ...actual, getAudioAsset: async () => media.current };
});

vi.mock('../src/media/audioAssets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/media/audioAssets')>();
  return { ...actual, storeAudioFile: media.storeAudioFile };
});

vi.mock('../src/media/cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/media/cleanup')>();
  return { ...actual, cleanupProjectMedia: async () => [] };
});

const NOW = '2026-01-01T00:00:00.000Z';

const take: NarrationTake = {
  provider: 'Deepgram',
  model: 'aura-1',
  voice: 'aura-angus-en',
  scriptFingerprint: 'fnv1a:abc:917',
  characters: 917,
  estimatedUsd: 0.0138,
  jobId: 'nar_generated',
  generatedAt: NOW,
};

const generated: AudioAssetRecord = {
  id: 'aud_generated',
  projectId: 'prj_upload',
  name: 'narration-aura-angus-en-422713.mp3',
  mimeType: 'audio/mpeg',
  byteSize: 23510,
  durationMs: 3918,
  sampleRate: 48000,
  channels: 2,
  createdAt: NOW,
  blob: new Blob([]),
  source: 'generated',
  generation: take,
  replacesAssetId: null,
};

const uploaded = (projectId: string, file: File, replaces: string | null): AudioAssetRecord => ({
  id: 'aud_upload',
  projectId,
  name: file.name,
  mimeType: file.type,
  byteSize: file.size,
  durationMs: 2000,
  sampleRate: 48000,
  channels: 1,
  createdAt: NOW,
  blob: file,
  source: 'upload',
  generation: null,
  replacesAssetId: replaces,
});

beforeEach(() => {
  media.current = generated;
  URL.createObjectURL = vi.fn(() => 'blob:mock-audio');
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

describe('uploading audio over generated narration', () => {
  it('stores the upload with the narration it replaces, and music with none', async () => {
    const project = updateAudioTrack(
      createProject(
        {
          title: 'Upload over narration',
          mode: 'factual',
          targetDuration: 60,
          visualPreset: 'clean-educational',
        },
        { now: NOW, id: 'prj_upload' },
      ),
      'narration',
      {
        assetId: generated.id,
        fileName: generated.name,
        durationMs: generated.durationMs,
        generated: take,
      },
      NOW,
    );
    const repository = new ProjectRepository(new MemoryStorage());
    const created = repository.create(project);
    if (!created.ok) throw new Error(created.message);
    const store = new ProjectStore(repository, { autosave: false });
    store.openProject(project.id);
    media.storeAudioFile.mockImplementation(
      async (projectId: string, file: File, replaces: string | null) =>
        uploaded(projectId, file, replaces),
    );

    render(
      <StoreProvider store={store}>
        <AudioTracksPanel project={project} />
      </StoreProvider>,
    );

    const narrationFile = new File([new Uint8Array([1, 2, 3])], 'take.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByLabelText('Narration audio file'), {
      target: { files: [narrationFile] },
    });
    await waitFor(() =>
      expect(media.storeAudioFile).toHaveBeenCalledWith(project.id, narrationFile, generated.id),
    );

    // The stored upload is attached, so the generated take becomes the previous one.
    expect(store.getSnapshot().active?.project.audio.narration.assetId).toBe('aud_upload');

    const musicFile = new File([new Uint8Array([4, 5, 6])], 'bed.mp3', { type: 'audio/mpeg' });
    fireEvent.change(screen.getByLabelText('Background music audio file'), {
      target: { files: [musicFile] },
    });
    await waitFor(() =>
      expect(media.storeAudioFile).toHaveBeenCalledWith(project.id, musicFile, null),
    );
  });
});
