import { describe, expect, it } from 'vitest';
import { createProject, updateAudioTrack } from '../src/domain/project';
import { addScene, updateScene } from '../src/domain/storyboard';
import { parseProjectJson } from '../src/domain/validation';
import { SCHEMA_VERSION } from '../src/domain/types';
import type { Project } from '../src/domain/types';
import { referencedAssetIds, referencedAudioAssetIds } from '../src/media/cleanup';
import { MAX_AUDIO_BYTES, validateAudioFileMeta } from '../src/media/audioAssets';
import { validateImageFileMeta } from '../src/media/imageAssets';
import { buildRenderSnapshot, collectAudioAssetIds } from '../src/render/snapshot';
import { validateRenderSnapshot } from '../src/render/validation';
import type { RenderAssetInfo, RenderAudioInfo } from '../src/render/validation';

const NOW = '2026-01-01T00:00:00.000Z';

function board(): Project {
  let project = createProject(
    {
      title: 'Render test',
      mode: 'factual',
      targetDuration: 60,
      visualPreset: 'clean-educational',
    },
    { now: NOW, id: 'prj_render' },
  );
  project = addScene(
    project,
    {
      title: 'One',
      plannedDuration: 8,
      imageAssetId: null,
      onScreenText: 'First frame',
    },
    NOW,
  );
  project = addScene(
    project,
    {
      title: 'Two',
      plannedDuration: 10,
      imageAssetId: null,
      onScreenText: 'Second frame',
    },
    NOW,
  );
  project = addScene(
    project,
    {
      title: 'Three',
      plannedDuration: 12,
      imageAssetId: null,
      onScreenText: 'Third frame',
    },
    NOW,
  );
  const [first, second, third] = project.storyboard.scenes;
  project = updateScene(project, first.id, { imageAssetId: 'img_a' }, NOW);
  project = updateScene(project, second.id, { imageAssetId: 'img_b', imageFraming: 'fill' }, NOW);
  project = updateScene(project, third.id, { imageAssetId: 'img_c' }, NOW);
  return project;
}

function assetInfo(id: string): RenderAssetInfo {
  return { id, mimeType: 'image/png', width: 1080, height: 1920, byteSize: 1024 };
}

function audioInfo(id: string, durationMs = 30_000): RenderAudioInfo {
  return { id, mimeType: 'audio/wav', durationMs, byteSize: 4096 };
}

function assetsFor(project: Project): Map<string, RenderAssetInfo> {
  const map = new Map<string, RenderAssetInfo>();
  for (const scene of project.storyboard.scenes) {
    if (scene.imageAssetId) map.set(scene.imageAssetId, assetInfo(scene.imageAssetId));
  }
  return map;
}

describe('render snapshot', () => {
  it('captures order, ids, frame counts, framing, text, and output settings', () => {
    const project = board();
    const snapshot = buildRenderSnapshot(project, NOW);

    expect(snapshot.projectId).toBe('prj_render');
    expect(snapshot.output).toMatchObject({ width: 720, height: 1280, fps: 30, audio: false });
    expect(snapshot.scenes.map((scene) => scene.sceneId)).toEqual(
      project.storyboard.scenes.map((scene) => scene.id),
    );
    expect(snapshot.scenes.map((scene) => scene.frameCount)).toEqual([240, 300, 360]);
    expect(snapshot.totalFrames).toBe(900);
    expect(snapshot.totalDurationMs).toBe(30_000);
    expect(snapshot.scenes[1]?.framing).toBe('fill');
    expect(snapshot.scenes[0]?.onScreenText).toBe('First frame');
  });

  it('changes its fingerprint when text, framing, or duration changes', () => {
    const project = board();
    const base = buildRenderSnapshot(project, NOW).contentFingerprint;
    const first = project.storyboard.scenes[0]!;

    const textChanged = updateScene(project, first.id, { onScreenText: 'Different' }, NOW);
    const framed = updateScene(project, first.id, { imageFraming: 'fill' }, NOW);
    const timed = updateScene(project, first.id, { plannedDuration: 9 }, NOW);

    expect(buildRenderSnapshot(textChanged, NOW).contentFingerprint).not.toBe(base);
    expect(buildRenderSnapshot(framed, NOW).contentFingerprint).not.toBe(base);
    expect(buildRenderSnapshot(timed, NOW).contentFingerprint).not.toBe(base);
  });

  it('captures audio ids, volume, mute, and applied/trimmed timing', () => {
    let project = board();
    project = updateAudioTrack(project, 'narration', {
      assetId: 'aud_narration',
      fileName: 'narration.wav',
      durationMs: 35_000,
    }, NOW);
    project = updateAudioTrack(project, 'music', {
      assetId: 'aud_music',
      fileName: 'music.wav',
      durationMs: 12_000,
      volume: 0.4,
    }, NOW);

    const snapshot = buildRenderSnapshot(project, NOW);
    expect(snapshot.output.audio).toBe(true);
    expect(snapshot.audio.tracks).toEqual([
      expect.objectContaining({
        role: 'narration',
        assetId: 'aud_narration',
        volume: 1,
        included: true,
        sourceDurationMs: 35_000,
        appliedDurationMs: 30_000,
        trimmedMs: 5_000,
      }),
      expect.objectContaining({
        role: 'music',
        assetId: 'aud_music',
        volume: 0.4,
        included: true,
        sourceDurationMs: 12_000,
        appliedDurationMs: 12_000,
        trimmedMs: 0,
      }),
    ]);
    expect(collectAudioAssetIds(snapshot)).toEqual(['aud_narration', 'aud_music']);
    expect(snapshot.audio.narrationCutoffAcknowledged).toBe(false);

    const quieter = updateAudioTrack(project, 'music', { volume: 0.2 }, NOW);
    expect(buildRenderSnapshot(quieter, NOW).contentFingerprint).not.toBe(snapshot.contentFingerprint);
    const acknowledged = buildRenderSnapshot(project, NOW, { acknowledgeNarrationCutoff: true });
    expect(acknowledged.contentFingerprint).toBe(snapshot.contentFingerprint);
  });

  it('does not record muted tracks as included or trimmed', () => {
    let project = board();
    project = updateAudioTrack(project, 'narration', {
      assetId: 'aud_narration',
      fileName: 'narration.wav',
      durationMs: 35_000,
      muted: true,
    }, NOW);
    const snapshot = buildRenderSnapshot(project, NOW);
    expect(snapshot.output.audio).toBe(false);
    expect(snapshot.audio.tracks[0]).toMatchObject({
      included: false,
      appliedDurationMs: null,
      trimmedMs: null,
    });
    expect(collectAudioAssetIds(snapshot)).toEqual([]);
  });

  it('is a snapshot: later project edits do not change the captured value', () => {
    const project = board();
    const snapshot = buildRenderSnapshot(project, NOW);
    const before = JSON.stringify(snapshot);

    const edited = updateScene(project, project.storyboard.scenes[0]!.id, {
      onScreenText: 'Edited after capture',
      plannedDuration: 2,
    }, NOW);

    expect(JSON.stringify(snapshot)).toBe(before);
    expect(edited.storyboard.scenes[0]?.onScreenText).toBe('Edited after capture');
    expect(snapshot.scenes[0]?.onScreenText).toBe('First frame');
  });
});

describe('render validation', () => {
  it('accepts a complete board with every image present', () => {
    const project = board();
    expect(validateRenderSnapshot(buildRenderSnapshot(project, NOW), assetsFor(project))).toEqual([]);
  });

  it('reports a scene with no image attached', () => {
    const project = board();
    const first = project.storyboard.scenes[0]!;
    const withoutImage = updateScene(project, first.id, { imageAssetId: null }, NOW);
    const issues = validateRenderSnapshot(buildRenderSnapshot(withoutImage, NOW), assetsFor(project));
    expect(issues.some((issue) => issue.code === 'missing-image')).toBe(true);
  });

  it('reports an image whose stored asset is missing', () => {
    const project = board();
    const assets = assetsFor(project);
    assets.delete(project.storyboard.scenes[1]!.imageAssetId!);
    const issues = validateRenderSnapshot(buildRenderSnapshot(project, NOW), assets);
    expect(issues.some((issue) => issue.code === 'missing-asset')).toBe(true);
  });

  it('requires acknowledgment before cutting off longer narration', () => {
    const project = updateAudioTrack(board(), 'narration', {
      assetId: 'aud_narration',
      fileName: 'narration.wav',
      durationMs: 35_000,
    }, NOW);
    const assets = assetsFor(project);
    const audio = new Map([['aud_narration', audioInfo('aud_narration', 35_000)]]);

    const blocked = validateRenderSnapshot(buildRenderSnapshot(project, NOW), assets, audio);
    expect(blocked.some((issue) => issue.code === 'narration-cutoff')).toBe(true);

    const acknowledged = validateRenderSnapshot(
      buildRenderSnapshot(project, NOW, { acknowledgeNarrationCutoff: true }),
      assets,
      audio,
    );
    expect(acknowledged).toEqual([]);
  });

  it('reports missing and unsupported audio, and ignores muted audio', () => {
    const project = updateAudioTrack(board(), 'music', {
      assetId: 'aud_music',
      fileName: 'music.wav',
      durationMs: 30_000,
    }, NOW);
    const assets = assetsFor(project);
    const missing = validateRenderSnapshot(buildRenderSnapshot(project, NOW), assets);
    expect(missing.some((issue) => issue.code === 'missing-audio')).toBe(true);

    const unsupported = validateRenderSnapshot(buildRenderSnapshot(project, NOW), assets, new Map([
      ['aud_music', { ...audioInfo('aud_music'), mimeType: 'audio/midi' }],
    ]));
    expect(unsupported.some((issue) => issue.code === 'unsupported-audio')).toBe(true);

    const muted = updateAudioTrack(project, 'music', { muted: true }, NOW);
    expect(validateRenderSnapshot(buildRenderSnapshot(muted, NOW), assets)).toEqual([]);
  });

  it('reports zero-second scenes and over-long renders', () => {
    const project = board();
    const zero = updateScene(project, project.storyboard.scenes[0]!.id, { plannedDuration: 0 }, NOW);
    expect(
      validateRenderSnapshot(buildRenderSnapshot(zero, NOW), assetsFor(zero)).some(
        (issue) => issue.code === 'zero-duration',
      ),
    ).toBe(true);

    let long = board();
    for (const scene of long.storyboard.scenes) {
      long = updateScene(long, scene.id, { plannedDuration: 150 }, NOW);
    }
    expect(
      validateRenderSnapshot(buildRenderSnapshot(long, NOW), assetsFor(long)).some(
        (issue) => issue.code === 'too-long',
      ),
    ).toBe(true);
  });

  it('refuses an empty storyboard', () => {
    const project = createProject(
      { title: 'Empty', mode: 'factual', targetDuration: 60, visualPreset: 'clean-educational' },
      { now: NOW, id: 'prj_empty' },
    );
    const issues = validateRenderSnapshot(buildRenderSnapshot(project, NOW), new Map());
    expect(issues.map((issue) => issue.code)).toEqual(['no-scenes']);
  });
});

describe('media reference counting', () => {
  it('counts shared image references once and keeps referenced ids', () => {
    const project = board();
    const duplicated = {
      ...project,
      storyboard: {
        ...project.storyboard,
        scenes: [
          ...project.storyboard.scenes,
          { ...project.storyboard.scenes[0]!, id: 'scn_copy' },
        ],
      },
    };
    const referenced = referencedAssetIds([duplicated]);
    expect(referenced.has(project.storyboard.scenes[0]!.imageAssetId!)).toBe(true);
    expect(referenced.size).toBe(3);
  });

  it('counts shared audio references across duplicated projects', () => {
    const project = updateAudioTrack(board(), 'music', {
      assetId: 'aud_shared',
      fileName: 'shared.wav',
      durationMs: 10_000,
    }, NOW);
    expect(referencedAudioAssetIds([project, { ...project, id: 'prj_copy' }])).toEqual(
      new Set(['aud_shared']),
    );
  });
});

describe('upload rules', () => {
  it('accepts JPEG and PNG within limits', () => {
    expect(validateImageFileMeta({ name: 'a.jpg', type: 'image/jpeg', size: 1024 })).toBeNull();
    expect(validateImageFileMeta({ name: 'a.png', type: 'image/png', size: 1024 })).toBeNull();
  });

  it('accepts supported audio types and enforces the 25 MB limit', () => {
    expect(validateAudioFileMeta({ name: 'a.wav', type: 'audio/wav', size: 1024 })).toBeNull();
    expect(validateAudioFileMeta({ name: 'a.mp3', type: 'audio/mpeg', size: 1024 })).toBeNull();
    expect(
      validateAudioFileMeta({ name: 'a.mid', type: 'audio/midi', size: 1024 }),
    ).toMatch(/not supported/);
    expect(validateAudioFileMeta({ name: 'a.wav', type: 'audio/wav', size: 0 })).toMatch(/empty/i);
    expect(
      validateAudioFileMeta({ name: 'a.wav', type: 'audio/wav', size: MAX_AUDIO_BYTES + 1 }),
    ).toMatch(/25 MB/);
  });

  it('rejects other types, empty files, and files over 8 MB with clear messages', () => {
    expect(
      validateImageFileMeta({ name: 'a.gif', type: 'image/gif', size: 1024 }),
    ).toMatch(/JPEG and PNG/);
    expect(validateImageFileMeta({ name: 'a.png', type: 'image/png', size: 0 })).toMatch(/empty/i);
    expect(
      validateImageFileMeta({ name: 'a.png', type: 'image/png', size: 9 * 1024 * 1024 }),
    ).toMatch(/8 MB/);
  });
});

describe('schema 1 compatibility', () => {
  it('upgrades a schema 1 project with image fields defaulted', () => {
    const project = board();
    const raw = JSON.parse(JSON.stringify(project)) as Record<string, unknown>;
    raw.schemaVersion = 1;
    const storyboard = raw.storyboard as { scenes: Array<Record<string, unknown>> };
    for (const scene of storyboard.scenes) {
      delete scene.imageAssetId;
      delete scene.imageFraming;
    }

    const parsed = parseProjectJson(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.value.storyboard.scenes[0]?.imageAssetId).toBeNull();
    expect(parsed.value.storyboard.scenes[0]?.imageFraming).toBe('fit');
    expect(parsed.value.storyboard.scenes[1]?.imageFraming).toBe('fit');
    expect(parsed.value.audio.narration.assetId).toBeNull();
    expect(parsed.value.audio.music.muted).toBe(false);
  });

  it('still rejects an unknown future schema version', () => {
    const project = board();
    const raw = JSON.parse(JSON.stringify(project)) as Record<string, unknown>;
    raw.schemaVersion = 99;
    const parsed = parseProjectJson(raw);
    expect(parsed.ok).toBe(false);
  });
});
