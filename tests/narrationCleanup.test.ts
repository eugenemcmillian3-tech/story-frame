import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, updateAudioTrack } from '../src/domain/project';
import type { NarrationTake, Project } from '../src/domain/types';
import { linkAudioAssetReplacement } from '../src/media/audioAssets';
import { cleanupProjectMedia } from '../src/media/cleanup';
import { putAudioAsset } from '../src/media/mediaDb';
import type { AudioAssetRecord } from '../src/media/mediaDb';

/**
 * Media storage is swapped for one in-memory map: this test is about which
 * records cleanup keeps, not about IndexedDB.
 */
const media = vi.hoisted(() => ({ audio: new Map<string, AudioAssetRecord>() }));

vi.mock('../src/media/mediaDb', () => ({
  listAllAssets: async () => [],
  deleteAsset: async () => undefined,
  listAllAudioAssets: async () => [...media.audio.values()],
  deleteAudioAsset: async (id: string) => {
    media.audio.delete(id);
  },
  getAudioAsset: async (id: string) => media.audio.get(id),
  putAudioAsset: async (record: AudioAssetRecord) => {
    media.audio.set(record.id, record);
  },
}));

const NOW = '2026-01-01T00:00:00.000Z';
const PROJECT_ID = 'prj_restore';

function take(id: string, voice: string): NarrationTake {
  return {
    provider: 'Deepgram Aura',
    model: '@cf/deepgram/aura-1',
    voice,
    scriptFingerprint: 'fnv1a:abc:917',
    characters: 917,
    estimatedUsd: 0.0138,
    jobId: `nar_${id}`,
    generatedAt: NOW,
  };
}

function narration(id: string, voice: string, replacesAssetId: string | null): AudioAssetRecord {
  return {
    id,
    projectId: PROJECT_ID,
    name: `narration-${voice}.mp3`,
    mimeType: 'audio/mpeg',
    byteSize: 4096,
    durationMs: 41_140,
    sampleRate: 48_000,
    channels: 2,
    createdAt: NOW,
    blob: {} as Blob,
    source: 'generated',
    generation: take(id, voice),
    replacesAssetId,
  };
}

function project(): Project {
  return createProject(
    { title: 'Restored narration', mode: 'factual', targetDuration: 60, visualPreset: 'clean-educational' },
    { now: NOW, id: PROJECT_ID },
  );
}

/** Attach a take exactly as the panel does when it generates or restores one. */
function attached(current: Project, asset: AudioAssetRecord): Project {
  return updateAudioTrack(
    current,
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

function storeFor(active: Project) {
  return {
    hasUnreadableProjects: () => false,
    listAllProjects: () => [active],
    getActiveProject: () => active,
    flush: async () => ({ ok: true }),
  };
}

beforeEach(() => {
  media.audio.clear();
});

describe('restored narration cleanup', () => {
  it('keeps both takes when the restored one replaces the newer narration', async () => {
    const older = narration('aud_older', 'luna', null);
    const newer = narration('aud_newer', 'orion', older.id);
    const stray = narration('aud_stray', 'orion', null);
    for (const asset of [older, newer, stray]) await putAudioAsset(asset);

    let board = attached(project(), newer);
    await linkAudioAssetReplacement(older.id, newer.id);
    board = attached(board, older);

    const deleted = await cleanupProjectMedia(storeFor(board));

    // Cleanup still prunes takes nothing refers to; it just keeps the chain.
    expect(deleted).toEqual(['aud_stray']);
    expect(media.audio.has(older.id)).toBe(true);
    expect(media.audio.has(newer.id)).toBe(true);
    expect(media.audio.get(older.id)?.replacesAssetId).toBe(newer.id);
  });

  it('keeps both takes again after switching back to the newer narration', async () => {
    const older = narration('aud_older', 'luna', null);
    const newer = narration('aud_newer', 'orion', older.id);
    for (const asset of [older, newer]) await putAudioAsset(asset);

    // Restore the older take, then switch back to the newer one.
    await linkAudioAssetReplacement(older.id, newer.id);
    let board = attached(project(), older);
    await cleanupProjectMedia(storeFor(board));

    await linkAudioAssetReplacement(newer.id, older.id);
    board = attached(board, newer);
    const deleted = await cleanupProjectMedia(storeFor(board));

    expect(deleted).toEqual([]);
    expect(media.audio.has(newer.id)).toBe(true);
    expect(media.audio.has(older.id)).toBe(true);
    expect(media.audio.get(newer.id)?.replacesAssetId).toBe(older.id);
  });
});
