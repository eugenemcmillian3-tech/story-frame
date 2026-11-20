import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AiScriptPlanner } from '../src/components/AiPlanning';
import { angleInputFingerprint } from '../src/ai/input';
import type { AngleProposal, ProjectProposals } from '../src/ai/types';
import { createProject } from '../src/domain/project';
import type { Project } from '../src/domain/types';
import { ProjectRepository } from '../src/persistence/projectRepository';
import { ProjectStore } from '../src/state/store';
import { StoreProvider } from '../src/state/StoreProvider';
import { MemoryStorage } from './helpers';

vi.mock('@freebuff/auth/react', () => ({
  useFreebuffUser: () => ({ user: { sub: 'user_1' }, isLoading: false }),
  SignInWithFreebuff: () => null,
}));

const NOW = '2026-01-01T00:00:00.000Z';
const STORAGE_KEY = 'storyframe.v1.ai-proposals:prj_angles';

function testProject(): Project {
  return createProject(
    {
      title: 'Factual angles',
      mode: 'factual',
      targetDuration: 60,
      visualPreset: 'clean-educational',
    },
    { now: NOW, id: 'prj_angles' },
  );
}

function angleDraft(project: Project, label: string): AngleProposal {
  return {
    status: 'draft',
    model: 'deepseek-v4.1-flash',
    inputFingerprint: angleInputFingerprint(project, 'deepseek-v4.1-flash'),
    angles: [1, 2, 3].map((index) => ({
      id: `${label}_${index}`,
      title: `${label} direction ${index}`,
      hook: `${label} hook ${index}`,
      approach: `${label} approach ${index}`,
      explanation: `${label} explanation ${index}`,
    })),
    selectedAngleId: null,
    generatedAt: NOW,
    editedAt: null,
  };
}

// jsdom here has no localStorage, and the proposals store needs one to exist.
let storage: MemoryStorage;

function seed(proposals: ProjectProposals): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(proposals));
}

function stored(): ProjectProposals {
  return JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as ProjectProposals;
}

function renderPlanner(project: Project): void {
  const repository = new ProjectRepository(new MemoryStorage());
  const store = new ProjectStore(repository, { autosave: false });
  render(
    <StoreProvider store={store}>
      <AiScriptPlanner project={project} />
    </StoreProvider>,
  );
}

beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        daily: { used: 1, limit: 40, remaining: 39 },
        minute: { used: 1, limit: 6, remaining: 5 },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('previous angle draft after discarding the angles', () => {
  it('keeps the previous draft visible and restorable', () => {
    const project = testProject();
    const current = angleDraft(project, 'current');
    const previous = angleDraft(project, 'previous');
    seed({
      version: 1,
      projectId: project.id,
      updatedAt: NOW,
      angles: current,
      script: null,
      storyboard: null,
      previousAngles: previous,
      previousStoryboard: null,
    });
    renderPlanner(project);

    // The current angles are on screen before discarding.
    expect(screen.getByText('Angle 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Discard angles' }));

    // The panel used to live inside the angle branch, so this is the regression.
    expect(screen.queryByText('Angle 1')).toBeNull();
    expect(screen.getByText(/Previous angle draft/)).toBeTruthy();
    expect(screen.getByText(/The current angles were discarded/)).toBeTruthy();
    expect(stored().angles).toBeNull();
    expect(stored().previousAngles?.angles[0].title).toBe('previous direction 1');

    fireEvent.click(screen.getByRole('button', { name: 'Restore previous angles' }));

    expect(screen.getByText('Angle 1')).toBeTruthy();
    expect(screen.getByDisplayValue('previous direction 1')).toBeTruthy();
    expect(screen.queryByText(/Previous angle draft/)).toBeNull();
    expect(stored().angles?.angles[0].title).toBe('previous direction 1');
    expect(stored().previousAngles).toBeNull();
  });

  it('shows no panel when only the discarded draft exists', () => {
    const project = testProject();
    seed({
      version: 1,
      projectId: project.id,
      updatedAt: NOW,
      angles: angleDraft(project, 'current'),
      script: null,
      storyboard: null,
      previousAngles: null,
      previousStoryboard: null,
    });
    renderPlanner(project);

    fireEvent.click(screen.getByRole('button', { name: 'Discard angles' }));

    expect(screen.queryByText(/angle draft/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore previous angles' })).toBeNull();
  });
});
