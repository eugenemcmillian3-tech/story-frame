import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DirectedEditingBody } from '../src/components/DirectedEditing';
import { createProject, replaceScriptNarration } from '../src/domain/project';
import { addScene, setSceneLocks } from '../src/domain/storyboard';
import type { Project } from '../src/domain/types';
import { ProjectRepository } from '../src/persistence/projectRepository';
import { StoreProvider } from '../src/state/StoreProvider';
import { ProjectStore } from '../src/state/store';
import { MemoryStorage } from './helpers';

const mocks = vi.hoisted(() => ({ requestEditPlan: vi.fn() }));

vi.mock('../src/ai/api', () => ({ requestEditPlan: mocks.requestEditPlan }));

vi.mock('@freebuff/auth/react', () => ({
  useFreebuffUser: () => ({ user: { sub: 'dev_user' }, isLoading: false }),
  SignInWithFreebuff: () => null,
}));

vi.mock('../src/media/cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/media/cleanup')>();
  return { ...actual, cleanupProjectMedia: async () => [] };
});

const NOW = '2026-01-01T00:00:00.000Z';

function board(): Project {
  let project = createProject(
    {
      title: 'Directed editing panel',
      mode: 'factual',
      targetDuration: 60,
      visualPreset: 'clean-educational',
    },
    { now: NOW, id: 'prj_panel' },
  );
  project = replaceScriptNarration(project, 'Opening line. Closing line.', { now: NOW });
  project = addScene(project, { title: 'Opening', plannedDuration: 20 }, NOW);
  project = addScene(project, { title: 'Close', plannedDuration: 20 }, NOW);
  return project;
}

function storeFor(project: Project): ProjectStore {
  const repository = new ProjectRepository(new MemoryStorage());
  const created = repository.create(project);
  if (!created.ok) throw new Error(created.message);
  const store = new ProjectStore(repository, { autosave: false });
  store.openProject(project.id);
  return store;
}

function renderPanel(project: Project): ProjectStore {
  const store = storeFor(project);
  render(
    <StoreProvider store={store}>
      <DirectedEditingBody project={project} />
    </StoreProvider>,
  );
  return store;
}

async function planChange(request: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('Requested change'), { target: { value: request } });
  fireEvent.click(screen.getByRole('button', { name: 'Plan change' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Plan change' }));
  await waitFor(() => expect(mocks.requestEditPlan).toHaveBeenCalled());
}

beforeEach(() => {
  mocks.requestEditPlan.mockReset();
});

afterEach(cleanup);

describe('directed editing panel', () => {
  it('shows what a plan affects and refuses to apply a locked change', async () => {
    const base = board();
    const project = setSceneLocks(base, base.storyboard.scenes[1]!.id, { visuals: true }, NOW);
    const lockedScene = project.storyboard.scenes[1]!;
    renderPanel(project);
    mocks.requestEditPlan.mockResolvedValue({
      inputFingerprint: 'fnv1a:input:1',
      tokens: {
        commands: [
          { kind: 'scene.visual', sceneId: lockedScene.id, visualDirection: 'A new closing shot' },
        ],
        explanation: 'One visual change.',
        alternatives: [],
      },
    });

    await planChange('Replace the closing visual');

    expect(await screen.findByText('Affected components')).toBeTruthy();
    expect(screen.getByText('Preserved components')).toBeTruthy();
    expect(screen.getByText(/is locked\./)).toBeTruthy();
    expect(screen.getByText(/never unlocks it for you|Unlock visuals/)).toBeTruthy();
    expect(screen.getByText(/Estimated additional usage/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Apply change' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(project.storyboard.scenes[1]?.visualDirection).toBe('');
  });

  it('lists the lock conflict when the provider returns no commands for a locked target', async () => {
    const base = board();
    const project = setSceneLocks(base, base.storyboard.scenes[1]!.id, { visuals: true }, NOW);
    renderPanel(project);
    mocks.requestEditPlan.mockResolvedValue({
      inputFingerprint: 'fnv1a:input:3',
      tokens: {
        commands: [],
        explanation: 'Scene 2’s visual direction is locked, so no command was proposed.',
        alternatives: [],
      },
    });

    await planChange('Replace the visual in scene 2 with a wide shot');

    expect(await screen.findByText('Lock conflicts')).toBeTruthy();
    expect(
      screen.getByText('Scene 2 (“Close”) visual direction is locked. (inferred from your request)'),
    ).toBeTruthy();
    expect(screen.getByText(/Unlock visuals on Scene 2 yourself/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Apply change' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows a provider-named lock without the request-inferred label', async () => {
    const base = board();
    const project = setSceneLocks(base, base.storyboard.scenes[1]!.id, { visuals: true }, NOW);
    renderPanel(project);
    mocks.requestEditPlan.mockResolvedValue({
      inputFingerprint: 'fnv1a:input:4',
      tokens: {
        commands: [],
        explanation: 'The second scene visual is locked.',
        alternatives: [],
        blocked: [{ sceneId: project.storyboard.scenes[1]!.id, component: 'visuals' }],
      },
    });

    await planChange('Make the second beat’s visual warmer');

    expect(
      await screen.findByText('Scene 2 (“Close”) visual direction is locked.'),
    ).toBeTruthy();
    expect(screen.queryByText(/inferred from your request/)).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Apply change' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('applies an applicable plan to the open project', async () => {
    const project = board();
    const scene = project.storyboard.scenes[0]!;
    const store = renderPanel(project);
    mocks.requestEditPlan.mockResolvedValue({
      inputFingerprint: 'fnv1a:input:2',
      tokens: {
        commands: [{ kind: 'scene.text', sceneId: scene.id, onScreenText: 'New caption' }],
        explanation: 'One text change.',
        alternatives: [],
      },
    });

    await planChange('Change the opening caption');

    const apply = (await screen.findByRole('button', {
      name: 'Apply change',
    })) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply change' }));

    const applied = store.getSnapshot().active?.project;
    expect(applied?.storyboard.scenes[0]?.onScreenText).toBe('New caption');
    expect(applied?.editHistory).toHaveLength(1);
    // The untouched scene and the script stay exactly as they were.
    expect(applied?.storyboard.scenes[1]).toEqual(project.storyboard.scenes[1]);
    expect(applied?.script).toEqual(project.script);
    expect(await screen.findByText(/Change applied/)).toBeTruthy();
  });
});
