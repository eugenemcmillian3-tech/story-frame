import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestEditPlan } from '../src/ai/api';
import { buildEditInput, requestFingerprint } from '../src/ai/input';
import { DEFAULT_AI_MODEL } from '../src/ai/models';
import { AiError } from '../src/ai/types';
import { createProject, replaceScriptNarration, updateAudioTrack } from '../src/domain/project';
import { addScene } from '../src/domain/storyboard';
import type { Project } from '../src/domain/types';

const NOW = '2026-01-01T00:00:00.000Z';
const REQUEST = 'Replace the first scene visual only';

function project(): Project {
  let board = createProject(
    {
      title: 'Directed edit request',
      mode: 'factual',
      targetDuration: 60,
      visualPreset: 'clean-educational',
    },
    { now: NOW, id: 'prj_api' },
  );
  board = replaceScriptNarration(board, 'Opening line. Closing line.', { now: NOW });
  board = addScene(board, { title: 'Opening', narration: 'Opening line.', plannedDuration: 10 }, NOW);
  return board;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The client compares the server's fingerprint with its own request payload. */
function fingerprintFor(project: Project): string {
  return requestFingerprint({
    operation: 'edit',
    model: DEFAULT_AI_MODEL,
    input: buildEditInput(project, REQUEST),
  });
}

const signal = () => new AbortController().signal;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('edit plan request', () => {
  it('returns only allowlisted commands from a valid response', async () => {
    const board = project();
    const sceneId = board.storyboard.scenes[0]!.id;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          operation: 'edit',
          inputFingerprint: fingerprintFor(board),
          proposal: {
            commands: [{ kind: 'scene.visual', sceneId, visualDirection: 'A slow push in' }],
            explanation: 'One visual change.',
            alternatives: [],
          },
        }),
      ),
    );

    const result = await requestEditPlan(board, REQUEST, DEFAULT_AI_MODEL, signal());

    expect(result.tokens.commands).toEqual([
      { kind: 'scene.visual', sceneId, visualDirection: 'A slow push in' },
    ]);
    expect(result.tokens.blocked).toEqual([]);
    expect(result.inputFingerprint).toBe(fingerprintFor(board));
  });

  it('rejects a provider failure and leaves the project untouched', async () => {
    const board = project();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'provider down' }, 502)));

    await expect(requestEditPlan(board, REQUEST, DEFAULT_AI_MODEL, signal())).rejects.toBeInstanceOf(
      AiError,
    );

    // Planning is a read of the project: nothing was attached, applied, or recorded.
    expect(board.script.narration).toBe('Opening line. Closing line.');
    expect(board.editHistory).toEqual([]);
    expect(board.storyboard.scenes[0]?.visualDirection).toBe('');
  });

  it('rejects a response that adds a field outside the allowlist', async () => {
    const board = project();
    const sceneId = board.storyboard.scenes[0]!.id;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          operation: 'edit',
          inputFingerprint: fingerprintFor(board),
          proposal: {
            commands: [
              {
                kind: 'scene.visual',
                sceneId,
                visualDirection: 'A slow push in',
                narration: 'Rewritten while nobody asked',
              },
            ],
          },
        }),
      ),
    );

    await expect(
      requestEditPlan(board, REQUEST, DEFAULT_AI_MODEL, signal()),
    ).rejects.toThrow(/unsupported field/);
  });

  it('rejects a response whose input fingerprint does not match the sent request', async () => {
    const board = project();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          operation: 'edit',
          inputFingerprint: 'fnv1a:00000000:0',
          proposal: { commands: [] },
        }),
      ),
    );

    await expect(requestEditPlan(board, REQUEST, DEFAULT_AI_MODEL, signal())).rejects.toMatchObject({
      code: 'stale',
    });
  });

  it('sends the script, scenes, and locks the plan is checked against', async () => {
    const board = updateAudioTrack(project(), 'narration', {
      assetId: 'aud_take',
      fileName: 'take.mp3',
      durationMs: 20_000,
    }, NOW);
    let sent: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return jsonResponse({
          operation: 'edit',
          inputFingerprint: fingerprintFor(board),
          proposal: { commands: [] },
        });
      }),
    );

    await requestEditPlan(board, REQUEST, DEFAULT_AI_MODEL, signal());

    expect(sent).toMatchObject({
      operation: 'edit',
      input: {
        script: { narration: 'Opening line. Closing line.', locked: false },
        scenes: [{ title: 'Opening', status: 'draft' }],
      },
    });
  });
});
