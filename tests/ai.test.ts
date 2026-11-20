import { describe, expect, it } from 'vitest';
import {
  parseAngleTokens,
  parseScriptTokens,
  parseStoryboardTokens,
  scriptNarration,
  unresolvedClaims,
} from '../src/ai/contracts';
import {
  angleInputFingerprint,
  buildAnglesInput,
  scriptInputFingerprint,
  storyboardInputFingerprint,
} from '../src/ai/input';
import { attachClaimSource, removeClaimSource } from '../src/ai/claims';
import { AiError } from '../src/ai/types';
import type { AiClaim } from '../src/ai/types';
import { addPlanningNote, acceptStoryboardDraft, createProject, replaceScriptNarration, updateBrief, updateSourceNotes } from '../src/domain/project';
import { addScene, setSceneLocks } from '../src/domain/storyboard';
import { parseProjectJson } from '../src/domain/validation';
import { SCHEMA_VERSION } from '../src/domain/types';

const NOW = '2026-01-01T00:00:00.000Z';

function factualProject() {
  let project = createProject(
    {
      title: 'Factual AI',
      mode: 'factual',
      targetDuration: 60,
      visualPreset: 'clean-educational',
    },
    { now: NOW, id: 'prj_ai' },
  );
  project = updateBrief(project, {
    topic: 'How a bicycle stays upright',
    audience: 'Curious adults',
    goal: 'Explain the current evidence',
    tone: 'Calm',
  }, NOW);
  project = updateSourceNotes(project, [
    {
      id: 'src_1',
      title: 'Bicycle stability notes',
      url: 'https://example.com/not-sent',
      excerpt: 'A moving bicycle can stay upright without a rider because its steering geometry helps it correct a lean.',
      notes: 'User-provided excerpt.',
    },
  ], NOW);
  return project;
}

function angle() {
  return {
    title: 'The lean that corrects itself',
    hook: 'A bicycle left to roll does not simply fall over.',
    approach: 'Walk through steering geometry, then the limits of the evidence.',
    explanation: 'A concrete visual sequence with a clear evidence boundary.',
  };
}

function validScript() {
  return {
    mode: 'script',
    segments: [
      {
        kind: 'hook',
        text: 'A moving bicycle can stay upright without a rider.',
        claims: [
          {
            text: 'A moving bicycle can stay upright without a rider.',
            sourceIds: ['src_1'],
            excerpts: [
              {
                sourceId: 'src_1',
                excerpt: 'A moving bicycle can stay upright without a rider',
              },
            ],
            status: 'supported',
            note: 'The excerpt is user-supplied, not independently checked.',
          },
        ],
      },
      {
        kind: 'ending',
        text: 'That does not settle every detail of bicycle stability.',
        claims: [
          {
            text: 'That does not settle every detail of bicycle stability.',
            sourceIds: [],
            excerpts: [],
            status: 'missing',
            note: 'Needs a source or should be framed as an open question.',
          },
        ],
      },
    ],
    outline: [],
    missingInformation: [],
    warnings: [],
  };
}

function validScenes(script: string) {
  const words = script.split(' ');
  const middle = Math.ceil(words.length / 2);
  return {
    scenes: [
      {
        title: 'Open',
        narration: words.slice(0, middle).join(' '),
        visualDirection: 'A bicycle rolls past a neutral background.',
        assetType: 'image',
        onScreenText: 'A bicycle stays up',
        plannedDuration: 20,
      },
      {
        title: 'Close',
        narration: words.slice(middle).join(' '),
        visualDirection: 'Cut to a simple steering diagram.',
        assetType: 'diagram',
        onScreenText: '',
        plannedDuration: 20,
      },
    ],
    warnings: [],
  };
}

describe('AI angle contracts', () => {
  it('requires exactly three distinct angles', () => {
    const one = { title: 'A', hook: 'H', approach: 'P', explanation: 'E' };
    expect(() => parseAngleTokens({ angles: [one] })).toThrow(AiError);
    expect(() =>
      parseAngleTokens({ angles: [one, { ...one }, { ...one, title: 'B' }] }),
    ).toThrow(/not distinct/);
    expect(parseAngleTokens({ angles: [one, { ...one, title: 'B' }, { ...one, title: 'C' }] }).angles)
      .toHaveLength(3);
  });

  it('changes the input fingerprint when the selected model changes', () => {
    const project = factualProject();
    expect(angleInputFingerprint(project, 'gemma4:31b')).not.toBe(angleInputFingerprint(project));
  });

  it('changes the input fingerprint when a relevant source changes', () => {
    const project = factualProject();
    const before = angleInputFingerprint(project);
    const after = updateSourceNotes(project, [
      { ...project.sourceNotes[0]!, excerpt: 'A different excerpt.' },
    ], NOW);
    expect(angleInputFingerprint(after)).not.toBe(before);
    expect(buildAnglesInput(project).sourceNotes[0]?.id).toBe('src_1');
  });
});

describe('AI script contracts', () => {
  it('validates factual source ids and verbatim excerpts', () => {
    const project = factualProject();
    const parsed = parseScriptTokens(validScript(), {
      mode: 'factual',
      sources: buildAnglesInput(project).sourceNotes,
    });
    expect(parsed.mode).toBe('script');
    expect(parsed.segments).toHaveLength(2);
    expect(scriptNarration(
      parsed.segments.map((segment, index) => ({ ...segment, id: String(index), claims: segment.claims, review: 'claims' as const })),
    )).toContain('A moving bicycle');
    expect(unresolvedClaims(
      parsed.segments.map((segment, index) => ({ ...segment, id: String(index), claims: segment.claims, review: 'claims' as const })),
    )).toHaveLength(1);
  });

  it('rejects unknown source ids and non-verbatim excerpts', () => {
    const sources = buildAnglesInput(factualProject()).sourceNotes;
    const unknown = validScript();
    unknown.segments[0]!.claims[0]!.sourceIds = ['src_missing'];
    expect(() => parseScriptTokens(unknown, { mode: 'factual', sources })).toThrow(/source ID/);

    const changed = validScript();
    changed.segments[0]!.claims[0]!.excerpts[0]!.excerpt = 'A paraphrased sentence.';
    expect(() => parseScriptTokens(changed, { mode: 'factual', sources })).toThrow(/verbatim/);
  });

  it('accepts an insufficient-evidence outline but not as narration', () => {
    const parsed = parseScriptTokens(
      {
        mode: 'outline',
        segments: [],
        outline: ['Define the question', 'Collect measurements'],
        missingInformation: ['No excerpt addresses the mechanism'],
        warnings: [],
      },
      { mode: 'factual', sources: [] },
    );
    expect(parsed.mode).toBe('outline');
    expect(parsed.outline).toHaveLength(2);
  });

  it('rejects an outline response in fiction mode', () => {
    expect(() =>
      parseScriptTokens(
        {
          mode: 'outline',
          segments: [],
          outline: ['Plan the scene'],
          missingInformation: [],
          warnings: [],
        },
        { mode: 'fiction', sources: [] },
      ),
    ).toThrow(/fiction/i);
  });

  it('does not allow invented citations in fiction', () => {
    expect(() =>
      parseScriptTokens(
        {
          mode: 'script',
          segments: [
            {
              kind: 'body',
              text: 'Mira stepped onto the night bus.',
              claims: [{ text: 'A citation', sourceIds: [], excerpts: [], status: 'missing' }],
            },
          ],
          outline: [],
          missingInformation: [],
          warnings: [],
        },
        { mode: 'fiction', sources: [] },
      ),
    ).toThrow(/must not include factual citations/);
  });

  it('changes the script proposal fingerprint when the selected angle changes', () => {
    const project = factualProject();
    const first = scriptInputFingerprint(project, angle());
    const second = scriptInputFingerprint(project, { ...angle(), hook: 'A different hook.' });
    expect(first).not.toBe(second);
  });
});

describe('AI storyboard contracts', () => {
  it('reconstructs the saved script in order with whitespace normalization', () => {
    const project = replaceScriptNarration(
      factualProject(),
      'A moving bicycle can stay upright.   The evidence has limits.',
      { now: NOW },
    );
    const parsed = parseStoryboardTokens(
      {
        scenes: [
          {
            title: 'One',
            narration: 'A moving bicycle can stay upright.',
            visualDirection: 'A bicycle rolls.',
            assetType: 'image',
            onScreenText: '',
            plannedDuration: 30,
          },
          {
            title: 'Two',
            narration: 'The evidence has limits.',
            visualDirection: 'A split diagram.',
            assetType: 'diagram',
            onScreenText: 'Limits',
            plannedDuration: 30,
          },
        ],
        warnings: [],
      },
      project.script.narration,
    );
    expect(parsed.scenes).toHaveLength(2);
    expect(storyboardInputFingerprint(project)).toContain('fnv1a:');
  });

  it('rejects rewritten narration, URLs, and invalid media fields', () => {
    const project = replaceScriptNarration(factualProject(), 'One sentence. Two sentence.', { now: NOW });
    const rewritten = validScenes(project.script.narration);
    rewritten.scenes[0]!.narration = 'One changed sentence.';
    expect(() => parseStoryboardTokens(rewritten, project.script.narration)).toThrow(/reconstruct/);

    const url = validScenes(project.script.narration);
    url.scenes[0]!.visualDirection = 'Use a frame from https://example.com/stock.jpg';
    expect(() => parseStoryboardTokens(url, project.script.narration)).toThrow(/URLs/);

    const media = validScenes(project.script.narration) as unknown as {
      scenes: Array<Record<string, unknown>>;
    };
    media.scenes[0]!.mediaId = 'img_invented';
    expect(() => parseStoryboardTokens(media, project.script.narration)).toThrow(/media IDs/);
  });

  it('changes the storyboard fingerprint when the saved script changes', () => {
    const project = replaceScriptNarration(factualProject(), 'One sentence. Two sentence.', { now: NOW });
    const next = replaceScriptNarration(project, 'One sentence. Three sentence.', { now: NOW });
    expect(storyboardInputFingerprint(project)).not.toBe(storyboardInputFingerprint(next));
  });
});

describe('storyboard acceptance safety', () => {
  it('keeps the previous board, creates new scene ids, and preserves media references', () => {
    let project = replaceScriptNarration(factualProject(), 'One sentence. Two sentence.', { now: NOW });
    project = addScene(project, {}, NOW);
    const oldScene = project.storyboard.scenes[0]!;
    project = {
      ...project,
      storyboard: {
        ...project.storyboard,
        scenes: [{ ...oldScene, imageAssetId: 'img_old' }],
      },
    };
    const accepted = acceptStoryboardDraft(project, [
      {
        title: 'New one',
        narration: 'One sentence.',
        visualDirection: 'A bicycle.',
        assetType: 'image',
        onScreenText: '',
        plannedDuration: 20,
      },
      {
        title: 'New two',
        narration: 'Two sentence.',
        visualDirection: 'A diagram.',
        assetType: 'diagram',
        onScreenText: '',
        plannedDuration: 20,
      },
    ], { expectedScriptFingerprint: project.script.fingerprint, now: NOW });
    expect(accepted.storyboard.scenes).toHaveLength(2);
    expect(accepted.storyboard.scenes[0]!.id).not.toBe(oldScene.id);
    expect(accepted.storyboard.previous?.scenes[0]?.imageAssetId).toBe('img_old');
  });

  it('refuses locked current scenes and stale script fingerprints', () => {
    let project = replaceScriptNarration(factualProject(), 'One sentence. Two sentence.', { now: NOW });
    project = addScene(project, {}, NOW);
    const sceneId = project.storyboard.scenes[0]!.id;
    project = setSceneLocks(project, sceneId, { narration: true }, NOW);
    const draft = [
      {
        title: 'New',
        narration: project.script.narration,
        visualDirection: 'A bicycle.',
        assetType: 'image' as const,
        onScreenText: '',
        plannedDuration: 30,
      },
    ];
    expect(() =>
      acceptStoryboardDraft(project, draft, {
        expectedScriptFingerprint: project.script.fingerprint,
        now: NOW,
      }),
    ).toThrow(/locked components/);

    const unlocked = setSceneLocks(project, sceneId, { narration: false }, NOW);
    expect(() =>
      acceptStoryboardDraft(unlocked, draft, {
        expectedScriptFingerprint: 'fnv1a:stale:1',
        now: NOW,
      }),
    ).toThrow(/script changed/);
  });

  it('stores outlines as planning notes, not accepted narration', () => {
    const project = factualProject();
    const noted = addPlanningNote(project, {
      title: 'Outline',
      body: '1. Define the question',
      inputFingerprint: angleInputFingerprint(project),
    }, { now: NOW });
    expect(noted.planningNotes).toHaveLength(1);
    expect(noted.script.narration).toBe('');
  });
});

describe('direct claim sourcing', () => {
  const sources = buildAnglesInput(factualProject()).sourceNotes;
  const missingClaim = (): AiClaim => ({
    id: 'clm_1',
    text: 'A moving bicycle can stay upright without a rider.',
    sourceIds: [],
    excerpts: [],
    status: 'missing',
    note: 'No excerpt was supplied by the provider.',
    resolution: null,
  });

  it('attaches a verbatim excerpt and marks a missing claim supported', () => {
    const sourced = attachClaimSource(
      missingClaim(),
      sources,
      'src_1',
      'A moving bicycle can stay upright without a rider',
    );
    expect(sourced.status).toBe('supported');
    expect(sourced.resolution).toBe('supported');
    expect(sourced.sourceIds).toEqual(['src_1']);
    expect(sourced.excerpts).toHaveLength(1);
  });

  it('rejects paraphrases and unknown sources', () => {
    expect(() =>
      attachClaimSource(missingClaim(), sources, 'src_1', 'Bicycles balance by themselves.'),
    ).toThrow(/verbatim/);
    expect(() =>
      attachClaimSource(missingClaim(), sources, 'src_missing', 'A moving bicycle'),
    ).toThrow(/pasted source/);
  });

  it('keeps a conflicting claim conflicting instead of silently resolving it', () => {
    const conflicting: AiClaim = { ...missingClaim(), status: 'conflicting' };
    const sourced = attachClaimSource(
      conflicting,
      sources,
      'src_1',
      'A moving bicycle can stay upright without a rider',
    );
    expect(sourced.status).toBe('conflicting');
    expect(sourced.resolution).toBeNull();
  });

  it('removes an attached source and returns the claim to missing', () => {
    const sourced = attachClaimSource(
      missingClaim(),
      sources,
      'src_1',
      'A moving bicycle can stay upright without a rider',
    );
    const removed = removeClaimSource(sourced, 'src_1');
    expect(removed.status).toBe('missing');
    expect(removed.sourceIds).toEqual([]);
    expect(removed.excerpts).toEqual([]);
    expect(removed.resolution).toBeNull();
  });
});

describe('schema 3 migration', () => {
  it('adds planning notes and a null previous storyboard', () => {
    const project = factualProject();
    const raw = JSON.parse(JSON.stringify({ ...project, schemaVersion: 3 })) as Record<string, unknown>;
    delete raw.planningNotes;
    delete (raw.storyboard as Record<string, unknown>).previous;
    const parsed = parseProjectJson(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.value.planningNotes).toEqual([]);
    expect(parsed.value.storyboard.previous).toBeNull();
  });
});
