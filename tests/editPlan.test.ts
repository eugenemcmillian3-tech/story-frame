import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEditTokens } from '../src/ai/contracts';
import { AiError } from '../src/ai/types';
import { MAX_EDIT_HISTORY } from '../src/domain/constants';
import {
  applyEditPlan,
  composeScript,
  editProjectFingerprint,
  previewEditPlan,
  undoEdit,
} from '../src/domain/editPlan';
import type { EditBlockedTarget, EditPlan } from '../src/domain/editPlan';
import {
  createProject,
  replaceScriptNarration,
  setScriptLock,
  updateAudioTrack,
} from '../src/domain/project';
import { addScene, setSceneLocks, updateScene } from '../src/domain/storyboard';
import type { EditCommand, Project, Scene } from '../src/domain/types';
import { cleanupProjectMedia } from '../src/media/cleanup';
import type { MediaAssetRecord } from '../src/media/mediaDb';

/** Media storage is a map here: the question is what cleanup keeps, not IndexedDB. */
const media = vi.hoisted(() => ({
  images: [] as MediaAssetRecord[],
  deleted: [] as string[],
}));

vi.mock('../src/media/mediaDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/media/mediaDb')>();
  return {
    ...actual,
    listAllAssets: async () => media.images,
    deleteAsset: async (id: string) => {
      media.deleted.push(id);
    },
    listAllAudioAssets: async () => [],
    deleteAudioAsset: async () => undefined,
  };
});

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-02T00:00:00.000Z';
const SCRIPT =
  'Opening line about the topic. Middle line about the evidence. Closing line about the limits.';
const KEPT_OPENING = SCRIPT.slice(0, SCRIPT.indexOf(' Middle'));

function board(): Project {
  let project = createProject(
    {
      title: 'Directed editing',
      mode: 'factual',
      targetDuration: 60,
      visualPreset: 'clean-educational',
    },
    { now: NOW, id: 'prj_edit' },
  );
  project = replaceScriptNarration(project, SCRIPT, { now: NOW });
  project = addScene(project, { title: 'Opening', plannedDuration: 20 }, NOW);
  project = addScene(project, { title: 'Evidence', plannedDuration: 20 }, NOW);
  project = addScene(project, { title: 'Close', plannedDuration: 20 }, NOW);
  const [opening, evidence, closing] = project.storyboard.scenes as [Scene, Scene, Scene];
  project = updateScene(
    project,
    opening.id,
    { imageAssetId: 'img_opening', onScreenText: 'Opening' },
    NOW,
  );
  project = updateScene(
    project,
    evidence.id,
    {
      visualDirection: 'Approved diagram of the evidence',
      imageAssetId: 'img_evidence',
      onScreenText: 'Evidence',
    },
    NOW,
  );
  const scenes = project.storyboard.scenes.map((scene) =>
    scene.id === opening.id || scene.id === evidence.id
      ? { ...scene, status: 'approved' as const }
      : scene,
  );
  return {
    ...project,
    storyboard: {
      ...project.storyboard,
      scenes,
      reviewedScriptFingerprint: project.script.fingerprint,
      reviewedAt: NOW,
    },
  };
}

function plan(
  project: Project,
  commands: EditCommand[],
  request = 'Directed change',
  blocked?: EditBlockedTarget[],
  blockedScript?: boolean,
): EditPlan {
  return {
    id: 'plan_1',
    request,
    model: 'test-model',
    projectFingerprint: editProjectFingerprint(project),
    inputFingerprint: 'fnv1a:plan:1',
    createdAt: NOW,
    commands,
    blocked,
    blockedScript,
  };
}

function sceneAt(project: Project, index: number): Scene {
  return project.storyboard.scenes[index] as Scene;
}

function image(id: string): MediaAssetRecord {
  return {
    id,
    projectId: 'prj_edit',
    name: `${id}.png`,
    mimeType: 'image/png',
    byteSize: 10,
    width: 100,
    height: 100,
    createdAt: NOW,
    blob: {} as Blob,
  };
}

beforeEach(() => {
  media.images = [];
  media.deleted = [];
});

describe('edit command allowlist', () => {
  it('accepts only the allowlisted commands and their named fields', () => {
    const tokens = parseEditTokens({
      commands: [
        { kind: 'scene.visual', sceneId: 'scn_1', visualDirection: 'A slow push in' },
        { kind: 'scene.text', sceneId: 'scn_2', onScreenText: 'Evidence' },
        { kind: 'scene.duration', sceneId: 'scn_3', plannedDuration: 12 },
        {
          kind: 'script.replace',
          scope: 'ending',
          text: ' A new closing line.',
          boundary: 'Opening line.',
        },
      ],
      explanation: 'One visual, one text, one duration, one ending.',
      alternatives: ['Keep the current ending'],
    });
    expect(tokens.commands.map((command) => command.kind)).toEqual([
      'scene.visual',
      'scene.text',
      'scene.duration',
      'script.replace',
    ]);
    expect(tokens.commands[0]).toEqual({
      kind: 'scene.visual',
      sceneId: 'scn_1',
      visualDirection: 'A slow push in',
    });
  });

  it('rejects an unknown command, an extra field, or an unexpected top-level key', () => {
    expect(() =>
      parseEditTokens({ commands: [{ kind: 'project.replace', script: 'anything' }] }),
    ).toThrow(AiError);
    expect(() =>
      parseEditTokens({
        commands: [
          {
            kind: 'scene.visual',
            sceneId: 'scn_1',
            visualDirection: 'A slow push in',
            imageAssetId: 'img_invented',
          },
        ],
      }),
    ).toThrow(AiError);
    expect(() => parseEditTokens({ commands: [], unlocked: ['scn_1'] })).toThrow(AiError);
  });

  it('validates a blocked target against the scene lock components', () => {
    expect(
      parseEditTokens({ commands: [], blocked: [{ sceneId: 'scn_1', component: 'visuals' }] })
        .blocked,
    ).toEqual([{ sceneId: 'scn_1', component: 'visuals' }]);
    expect(parseEditTokens({ commands: [] }).blockedScript).toBe(false);
    expect(parseEditTokens({ commands: [], blockedScript: true }).blockedScript).toBe(true);
    expect(() => parseEditTokens({ commands: [], blockedScript: 'yes' })).toThrow(AiError);
    // A partial plan would apply its commands and silently drop the refusal.
    expect(() =>
      parseEditTokens({
        commands: [{ kind: 'scene.visual', sceneId: 'scn_1', visualDirection: 'A diagram' }],
        blocked: [{ sceneId: 'scn_2', component: 'visuals' }],
      }),
    ).toThrow(AiError);
    expect(() =>
      parseEditTokens({
        commands: [{ kind: 'scene.visual', sceneId: 'scn_1', visualDirection: 'A diagram' }],
        blockedScript: true,
      }),
    ).toThrow(AiError);
    // The script is not a scene component, so it cannot be a blocked target.
    expect(() =>
      parseEditTokens({ commands: [], blocked: [{ sceneId: 'scn_1', component: 'script' }] }),
    ).toThrow(AiError);
    expect(() =>
      parseEditTokens({
        commands: [],
        blocked: [{ sceneId: 'scn_1', component: 'visuals', locked: true }],
      }),
    ).toThrow(AiError);
  });
});

describe('scoped edit application', () => {
  it('revises one scene while unrelated approved work is unchanged', () => {
    const project = board();
    const target = sceneAt(project, 1);
    const editPlan = plan(project, [
      { kind: 'scene.visual', sceneId: target.id, visualDirection: 'A new evidence diagram' },
    ]);

    const preview = previewEditPlan(project, editPlan);
    expect(preview.applicable).toBe(true);
    expect(preview.affected.join(' ')).toContain('Evidence');
    expect(preview.preserved.join(' ')).toContain('Approval of 1 untouched approved scene');

    const { project: next } = applyEditPlan(project, editPlan, { now: LATER });

    expect(sceneAt(next, 1).visualDirection).toBe('A new evidence diagram');
    expect(sceneAt(next, 1).imageAssetId).toBeNull();
    expect(sceneAt(next, 1).status).toBe('draft');
    expect(sceneAt(next, 1).onScreenText).toBe(target.onScreenText);
    expect(sceneAt(next, 1).plannedDuration).toBe(target.plannedDuration);

    // Unrelated components are untouched, including their approval and images.
    expect(next.script).toEqual(project.script);
    expect(next.brief).toEqual(project.brief);
    expect(next.sourceNotes).toEqual(project.sourceNotes);
    expect(sceneAt(next, 0)).toEqual(sceneAt(project, 0));
    expect(sceneAt(next, 2)).toEqual(sceneAt(project, 2));
    expect(next.storyboard.reviewedScriptFingerprint).toBe(
      project.storyboard.reviewedScriptFingerprint,
    );
    expect(next.editHistory).toHaveLength(1);
    expect(next.editHistory[0]?.before.scenes[1]?.imageAssetId).toBe('img_evidence');
  });

  it('rewrites the ending and leaves locked scenes and their timing alone', () => {
    const project = board();
    const locked = setSceneLocks(project, sceneAt(project, 1).id, { timing: true }, NOW);
    const editPlan = plan(locked, [
      { kind: 'script.replace', scope: 'ending', text: 'A shorter close.', boundary: KEPT_OPENING },
    ]);

    const { project: next } = applyEditPlan(locked, editPlan, { now: LATER });

    expect(next.script.narration).toBe(`${KEPT_OPENING}A shorter close.`);
    expect(next.script.versions[0]?.narration).toBe(SCRIPT);
    expect(next.storyboard.reviewedScriptFingerprint).toBe(project.storyboard.reviewedScriptFingerprint);
    expect(next.storyboard.reviewedScriptFingerprint).not.toBe(next.script.fingerprint);
    expect(next.storyboard.scenes.map((scene) => scene.plannedDuration)).toEqual([20, 20, 20]);
    expect(next.storyboard.scenes.map((scene) => scene.locks)).toEqual(
      locked.storyboard.scenes.map((scene) => scene.locks),
    );
  });

  it('refuses an edit to a locked component without unlocking anything', () => {
    const base = board();
    const project = setSceneLocks(base, sceneAt(base, 1).id, { visuals: true }, NOW);
    const editPlan = plan(project, [
      { kind: 'scene.visual', sceneId: sceneAt(project, 1).id, visualDirection: 'New' },
    ]);

    expect(() => applyEditPlan(project, editPlan, { now: LATER })).toThrow(/locked/i);
    expect(sceneAt(project, 1).locks.visuals).toBe(true);
    expect(sceneAt(project, 1).imageAssetId).toBe('img_evidence');
    expect(project.editHistory).toHaveLength(0);
  });

  it('explains a lock conflict and offers alternatives instead of guessing', () => {
    const base = board();
    const project = setSceneLocks(base, sceneAt(base, 1).id, { visuals: true }, NOW);
    const editPlan = plan(project, [
      { kind: 'scene.visual', sceneId: sceneAt(project, 1).id, visualDirection: 'New' },
    ]);

    const preview = previewEditPlan(project, editPlan);
    expect(preview.applicable).toBe(false);
    expect(preview.lockConflicts).toHaveLength(1);
    expect(preview.alternatives.join(' ')).toMatch(/unlock/i);
    expect(preview.alternatives.join(' ')).toMatch(/limit/i);
  });

  it('names the lock conflict behind a plan that returned no commands', () => {
    const base = board();
    const project = setSceneLocks(base, sceneAt(base, 1).id, { visuals: true }, NOW);
    const refused = plan(
      project,
      [],
      'Replace scene 2’s visual with a close-up of two people yawning across a table.',
    );

    const preview = previewEditPlan(project, refused);

    expect(preview.lockConflicts).toEqual([
      { message: 'Scene 2 (“Evidence”) visual direction is locked.', source: 'request' },
    ]);
    expect(preview.alternatives.join(' ')).toContain('Unlock visuals on Scene 2 yourself');
    expect(preview.affected).toContain('Nothing: the plan has no commands');
    expect(preview.applicable).toBe(false);

    // A request that names an unlocked scene stays free of invented conflicts.
    const elsewhere = plan(project, [], 'Replace the visual in scene 3 with a wide shot.');
    expect(previewEditPlan(project, elsewhere).lockConflicts).toEqual([]);

    // Titles are not guessed at: “Evidence” alone is not proof of the target.
    const byTitle = plan(project, [], 'Make the Evidence scene warmer.');
    expect(previewEditPlan(project, byTitle).lockConflicts).toEqual([]);
  });

  it('verifies a provider-named blocked target against the project locks', () => {
    const base = board();
    const project = setSceneLocks(base, sceneAt(base, 1).id, { visuals: true }, NOW);
    const sceneId = sceneAt(project, 1).id;

    const structured = plan(
      project,
      [],
      'Make the second beat’s visual warmer.',
      [{ sceneId, component: 'visuals' }],
    );
    const preview = previewEditPlan(project, structured);
    expect(preview.lockConflicts).toEqual([
      { message: 'Scene 2 (“Evidence”) visual direction is locked.', source: 'provider' },
    ]);
    expect(preview.alternatives.join(' ')).toContain('Unlock visuals on Scene 2 yourself');
    expect(preview.applicable).toBe(false);

    // A named target whose lock is not actually set is dropped, not reported.
    const unlocked = plan(project, [], 'Make the second beat’s visual warmer.', [
      { sceneId, component: 'text' },
    ]);
    expect(previewEditPlan(project, unlocked).lockConflicts).toEqual([]);

    // An id that is not in the project is ignored too.
    const unknown = plan(project, [], 'Warm up the whole thing.', [
      { sceneId: 'scn_missing', component: 'visuals' },
    ]);
    expect(previewEditPlan(project, unknown).lockConflicts).toEqual([]);
  });

  it('does not fall back to request text when the provider named a target', () => {
    const base = board();
    const project = setSceneLocks(base, sceneAt(base, 1).id, { visuals: true }, NOW);

    // The request points at locked scene 2, but the provider blamed unlocked scene 3.
    const refused = plan(
      project,
      [],
      'Replace the visual in scene 2 with a wide shot.',
      [{ sceneId: sceneAt(project, 2).id, component: 'visuals' }],
    );

    expect(previewEditPlan(project, refused).lockConflicts).toEqual([]);
  });

  it('reports a provider-named script lock without inferring from the request', () => {
    const project = setScriptLock(board(), true, NOW);
    const named = plan(project, [], 'Shorten the whole thing.', undefined, true);

    const preview = previewEditPlan(project, named);
    expect(preview.lockConflicts).toEqual([
      { message: 'The narration script is locked.', source: 'provider' },
    ]);
    expect(preview.alternatives.join(' ')).toContain('Unlock the script yourself');
    expect(preview.applicable).toBe(false);

    // A script claim that the project does not confirm is dropped, and it still
    // counts as the provider naming a target, so request text is not consulted.
    const base = board();
    const withLockedScene = setSceneLocks(
      base,
      sceneAt(base, 1).id,
      { visuals: true },
      NOW,
    );
    const wrong = plan(withLockedScene, [], 'Replace the visual in scene 2.', undefined, true);
    expect(previewEditPlan(withLockedScene, wrong).lockConflicts).toEqual([]);
  });

  it('names a locked script when a plan with no commands asked for a script rewrite', () => {
    const project = setScriptLock(board(), true, NOW);
    const refused = plan(project, [], 'Tighten the script opening without losing the evidence.');

    const preview = previewEditPlan(project, refused);

    expect(preview.lockConflicts).toEqual([
      { message: 'The narration script is locked.', source: 'request' },
    ]);
    expect(preview.alternatives.join(' ')).toContain('Unlock the script yourself');
    expect(preview.affected).toContain('Nothing: the plan has no commands');
    expect(preview.applicable).toBe(false);

    // A scene-narration request is not a script rewrite, even with the script locked.
    const sceneNarration = plan(project, [], 'Rewrite the narration in scene 3.');
    expect(previewEditPlan(project, sceneNarration).lockConflicts).toEqual([]);
  });

  it('rejects a boundary too short to identify where the script splits', () => {
    const project = board();
    const short = plan(project, [
      { kind: 'script.replace', scope: 'ending', text: 'A shorter close.', boundary: 'Opening' },
    ]);

    expect(() => composeScript(project, short.commands[0]!)).toThrow(
      /at least 12 characters/,
    );
    const preview = previewEditPlan(project, short);
    expect(preview.applicable).toBe(false);
    expect(preview.alternatives.join(' ')).toMatch(/at least 12 characters/);
    expect(() => applyEditPlan(project, short, { now: LATER })).toThrow(/at least 12 characters/);
    expect(project.script.narration).toBe(SCRIPT);
  });

  it('rejects a script boundary that is not in the saved script', () => {
    const project = board();
    const editPlan = plan(project, [
      {
        kind: 'script.replace',
        scope: 'opening',
        text: 'New opening.',
        boundary: 'not in the script',
      },
    ]);

    const preview = previewEditPlan(project, editPlan);
    expect(preview.applicable).toBe(false);
    expect(preview.alternatives.join(' ')).toMatch(/whole script|changed/i);
    expect(() => composeScript(project, editPlan.commands[0]!)).toThrow();
  });
});

describe('plan freshness', () => {
  it('refuses a plan made before an unrelated edit', () => {
    const project = board();
    const editPlan = plan(project, [
      { kind: 'scene.text', sceneId: sceneAt(project, 0).id, onScreenText: 'New caption' },
    ]);
    const changed = updateScene(project, sceneAt(project, 2).id, { title: 'Renamed close' }, LATER);

    expect(previewEditPlan(changed, editPlan).stale).toBe(true);
    expect(() => applyEditPlan(changed, editPlan, { now: LATER })).toThrow(/changed after this plan/);
    expect(sceneAt(changed, 0).onScreenText).not.toBe('New caption');
  });
});

describe('undo and recovery', () => {
  it('undoes an edit and keeps unrelated later work', () => {
    const project = board();
    const target = sceneAt(project, 1);
    const { project: edited } = applyEditPlan(
      project,
      plan(project, [
        { kind: 'scene.visual', sceneId: target.id, visualDirection: 'New diagram' },
        { kind: 'scene.text', sceneId: target.id, onScreenText: 'New text' },
      ]),
      { now: LATER },
    );
    const unrelated = updateScene(edited, sceneAt(edited, 0).id, { title: 'Later rename' }, LATER);

    const undone = undoEdit(unrelated, edited.editHistory[0]!.id, { now: LATER });

    expect(sceneAt(undone, 1)).toEqual(target);
    expect(sceneAt(undone, 0).title).toBe('Later rename');
    expect(undone.editHistory).toHaveLength(0);
  });

  it('refuses an undo that would change a component locked since the edit', () => {
    const project = board();
    const target = sceneAt(project, 1);
    const { project: edited } = applyEditPlan(
      project,
      plan(project, [{ kind: 'scene.text', sceneId: target.id, onScreenText: 'New text' }]),
      { now: LATER },
    );
    const locked = setSceneLocks(edited, target.id, { text: true }, LATER);

    expect(() => undoEdit(locked, edited.editHistory[0]!.id, { now: LATER })).toThrow(
      /Locked components/,
    );
    expect(sceneAt(locked, 1).onScreenText).toBe('New text');
  });

  it('bounds the history and drops the oldest entries first', () => {
    let project = board();
    for (let index = 0; index < MAX_EDIT_HISTORY + 2; index += 1) {
      project = applyEditPlan(
        project,
        plan(project, [
          { kind: 'scene.text', sceneId: sceneAt(project, 0).id, onScreenText: `Caption ${index}` },
        ]),
        { now: LATER },
      ).project;
    }
    expect(project.editHistory).toHaveLength(MAX_EDIT_HISTORY);
    expect(project.editHistory[0]?.before.scenes[0]?.onScreenText).toBe(`Caption ${MAX_EDIT_HISTORY}`);
  });
});

describe('dependency invalidation', () => {
  it('invalidates the narration take and review a script rewrite touches, nothing else', () => {
    const project = board();
    const narrated = updateAudioTrack(
      project,
      'narration',
      {
        assetId: 'aud_take',
        fileName: 'take.mp3',
        durationMs: 20_000,
        generated: {
          provider: 'Deepgram',
          model: 'aura-1',
          voice: 'aura-angus-en',
          scriptFingerprint: project.script.fingerprint,
          characters: SCRIPT.length,
          estimatedUsd: 0.001,
          jobId: 'nar_1',
          generatedAt: NOW,
        },
      },
      NOW,
    );
    const { project: next } = applyEditPlan(
      narrated,
      plan(narrated, [
        { kind: 'script.replace', scope: 'ending', text: ' New close.', boundary: KEPT_OPENING },
      ]),
      { now: LATER },
    );

    expect(next.script.fingerprint).not.toBe(narrated.script.fingerprint);
    expect(next.storyboard.reviewedScriptFingerprint).not.toBe(next.script.fingerprint);
    expect(next.audio.narration.assetId).toBe('aud_take');
    expect(next.audio.narration.generated?.scriptFingerprint).toBe(narrated.script.fingerprint);
    expect(next.editHistory[0]?.before.audio).toEqual(narrated.audio);
  });
});

describe('persistence', () => {
  it('round-trips the undo history through the project validator', async () => {
    const { parseProjectJson } = await import('../src/domain/validation');
    const project = board();
    const target = sceneAt(project, 1);
    const { project: next } = applyEditPlan(
      project,
      plan(project, [{ kind: 'scene.visual', sceneId: target.id, visualDirection: 'New' }]),
      { now: LATER },
    );

    const parsed = parseProjectJson(JSON.parse(JSON.stringify(next)));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.editHistory).toHaveLength(1);
    expect(parsed.value.editHistory[0]?.before.scenes[1]?.imageAssetId).toBe('img_evidence');
    expect(parsed.value.editHistory[0]?.before.scriptNarration).toBe(SCRIPT);
    expect(parsed.value.editHistory[0]?.request).toBe('Directed change');
  });
});

describe('cleanup with undo history', () => {
  it('keeps an image only the undo snapshot still refers to', async () => {
    media.images = [image('img_evidence'), image('img_orphan')];
    const project = board();
    const target = sceneAt(project, 1);
    const { project: next } = applyEditPlan(
      project,
      plan(project, [{ kind: 'scene.visual', sceneId: target.id, visualDirection: 'New' }]),
      { now: LATER },
    );
    const store = {
      hasUnreadableProjects: () => false,
      listAllProjects: () => [next],
      getActiveProject: () => next,
      flush: async () => ({ ok: true }),
    };

    const deleted = await cleanupProjectMedia(store);

    expect(deleted).toEqual(['img_orphan']);
    expect(media.deleted).toEqual(['img_orphan']);
  });
});
