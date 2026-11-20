import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NarrationPanel } from '../src/components/NarrationPanel';
import { createProject, updateAudioTrack } from '../src/domain/project';
import type { NarrationTake, Project } from '../src/domain/types';
import type { AudioAssetRecord } from '../src/media/mediaDb';
import { ProjectRepository } from '../src/persistence/projectRepository';
import { StoreProvider } from '../src/state/StoreProvider';
import { ProjectStore } from '../src/state/store';
import { MemoryStorage } from './helpers';

/** Stored audio is served from a map, so the panel's two lookups stay observable. */
const media = vi.hoisted(() => ({
  records: new Map<string, AudioAssetRecord>(),
  getAudioAsset: vi.fn(),
}));

vi.mock('../src/media/mediaDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/media/mediaDb')>();
  return { ...actual, getAudioAsset: media.getAudioAsset };
});

/** Signed in, so the panel renders its body rather than the sign-in prompt. */
vi.mock('@freebuff/auth/react', () => ({
  useFreebuffUser: () => ({ user: { sub: 'dev_user' }, isLoading: false }),
  SignInWithFreebuff: () => null,
}));

vi.mock('../src/narration/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/narration/api')>();
  return {
    ...actual,
    getNarrationUsage: async () => ({
      dailyLimit: 20,
      minuteLimit: 3,
      usedToday: 0,
      usedThisMinute: 0,
      estimatedUsdToday: 0,
    }),
  };
});

const NOW = '2026-01-01T00:00:00.000Z';
const RESTORE = 'Restore previous narration';

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

function generated(): AudioAssetRecord {
  return {
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
}

function upload(replacesAssetId: string | null): AudioAssetRecord {
  return {
    id: 'aud_upload',
    projectId: 'prj_upload',
    name: 'take.wav',
    mimeType: 'audio/wav',
    byteSize: 192044,
    durationMs: 2000,
    sampleRate: 48000,
    channels: 1,
    createdAt: NOW,
    blob: new Blob([]),
    source: 'upload',
    generation: null,
    replacesAssetId,
  };
}

function attached(asset: AudioAssetRecord): Project {
  return updateAudioTrack(
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
      assetId: asset.id,
      fileName: asset.name,
      durationMs: asset.durationMs,
      generated: asset.generation ?? null,
    },
    NOW,
  );
}

function show(project: Project): void {
  const store = new ProjectStore(new ProjectRepository(new MemoryStorage()), {
    autosave: false,
  });
  render(
    <StoreProvider store={store}>
      <NarrationPanel project={project} />
    </StoreProvider>,
  );
}

beforeEach(() => {
  media.records = new Map();
  media.getAudioAsset.mockImplementation(async (id: string) => media.records.get(id));
});

afterEach(cleanup);

describe('restoring narration an upload replaced', () => {
  it('offers restore for an upload whose replaced take is still stored', async () => {
    const kept = generated();
    const current = upload(kept.id);
    for (const record of [kept, current]) media.records.set(record.id, record);

    show(attached(current));

    // One read for the attached upload, then one for the take it replaced.
    await waitFor(() => expect(media.getAudioAsset).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: RESTORE })).toBeTruthy();
    expect(screen.getByText('Kept earlier take (3.92 s).')).toBeTruthy();
  });

  it('offers no restore when the upload replaced nothing', async () => {
    media.records.set('aud_upload', upload(null));

    show(attached(media.records.get('aud_upload')!));

    await waitFor(() => expect(media.getAudioAsset).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: RESTORE })).toBeNull();
  });
});
