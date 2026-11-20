import { describe, expect, it } from 'vitest';
import {
  createProject,
  renameProject,
  replaceScriptNarration,
  updateBrief,
} from '../src/domain/project';
import { addScene, moveScene, updateScene } from '../src/domain/storyboard';
import { serializeProjectDataExport } from '../src/domain/exportData';
import {
  PROJECT_KEY_PREFIX,
  ProjectRepository,
  projectKey,
  projectLockName,
} from '../src/persistence/projectRepository';
import { ProjectStore } from '../src/state/store';
import { MemoryStorage, gatedLock, queueLock } from './helpers';

const input = {
  title: 'Tide pools',
  mode: 'factual' as const,
  targetDuration: 60 as const,
  visualPreset: 'clean-educational' as const,
};

function makeStore(storage: MemoryStorage): ProjectStore {
  return new ProjectStore(new ProjectRepository(storage), { autosave: false });
}

/** Simulate another tab writing this project, and return the storage event value. */
function saveFromAnotherTab(storage: MemoryStorage, id: string, title: string): string {
  const other = new ProjectRepository(storage).read(id);
  if (!other.ok) throw new Error(other.message);
  const saved = new ProjectRepository(storage).save(
    { ...other.project, title },
    other.project.contentRevision,
  );
  if (!saved.ok) throw new Error(saved.message);
  return JSON.stringify(saved.project);
}

describe('browser-local persistence', () => {
  it('creates a project and reopens it from a fresh repository', () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const created = repository.create(createProject(input));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const reopened = new ProjectRepository(storage).read(created.project.id);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.project.title).toBe('Tide pools');
    expect(reopened.project.id).toBe(created.project.id);
    expect(reopened.project.contentRevision).toBe(1);
  });

  it('keeps brief changes after a refresh', async () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    const created = store.createProject(input);
    expect(created.id).toBeTruthy();

    store.mutate((project) =>
      updateBrief(project, {
        topic: 'Why tide pools survive low tide',
        audience: 'Curious adults',
        goal: 'Understand the adaptation',
        tone: 'Calm',
      }),
    );
    expect((await store.flush()).ok).toBe(true);

    const refreshed = makeStore(storage);
    refreshed.openProject(created.id as string);
    const project = refreshed.getSnapshot().active?.project;
    expect(project?.brief.topic).toBe('Why tide pools survive low tide');
    expect(project?.brief.audience).toBe('Curious adults');
    expect(project?.brief.tone).toBe('Calm');
  });

  it('keeps script and scene edits, including order, after a refresh', async () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    const created = store.createProject(input);

    store.mutate((project) => replaceScriptNarration(project, 'Line one. Line two.'));
    store.mutate((project) => addScene(project, { title: 'First', plannedDuration: 8 }));
    store.mutate((project) => addScene(project, { title: 'Second', plannedDuration: 12 }));
    const scenes = store.getSnapshot().active?.project.storyboard.scenes ?? [];
    store.mutate((project) =>
      updateScene(project, scenes[0]?.id as string, { narration: 'Opening line' }),
    );
    store.mutate((project) => moveScene(project, scenes[1]?.id as string, -1));
    expect((await store.flush()).ok).toBe(true);

    const refreshed = makeStore(storage);
    refreshed.openProject(created.id as string);
    const project = refreshed.getSnapshot().active?.project;
    expect(project?.script.narration).toBe('Line one. Line two.');
    expect(project?.storyboard.scenes.map((scene) => scene.title)).toEqual(['Second', 'First']);
    expect(project?.storyboard.scenes[1]?.narration).toBe('Opening line');
    expect(project?.storyboard.scenes[0]?.plannedDuration).toBe(12);
  });

  it('increments the content revision on every successful write', async () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    store.createProject(input);
    expect(store.getSnapshot().active?.baseRevision).toBe(1);
    store.mutate((project) => renameProject(project, 'Renamed'));
    expect((await store.flush()).ok).toBe(true);
    expect(store.getSnapshot().active?.baseRevision).toBe(2);
  });
});

describe('corrupt and unsupported stored data', () => {
  it('does not crash on invalid JSON and reports an unreadable card', () => {
    const storage = new MemoryStorage();
    storage.seed(`${PROJECT_KEY_PREFIX}bad`, '{"id": "truncated"');
    const store = makeStore(storage);

    const cards = store.getSnapshot().cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]?.readable).toBe(false);
    expect(cards[0]?.problem).toMatch(/not valid JSON/i);

    expect(() => store.openProject('bad')).not.toThrow();
    expect(store.getSnapshot().openError).toBeTruthy();
    expect(storage.getItem(`${PROJECT_KEY_PREFIX}bad`)).toBe('{"id": "truncated"');
  });

  it('reports an unsupported schema version instead of guessing', () => {
    const storage = new MemoryStorage();
    const project = createProject(input);
    storage.seed(projectKey(project.id), JSON.stringify({ ...project, schemaVersion: 99 }));
    const result = new ProjectRepository(storage).read(project.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported-schema');
    expect(result.message).toMatch(/Unsupported schema version 99/);
  });

  it('refuses to overwrite a corrupt stored copy', () => {
    const storage = new MemoryStorage();
    const project = createProject(input);
    const repository = new ProjectRepository(storage);
    const created = repository.create(project);
    if (!created.ok) throw new Error(created.message);
    storage.seed(projectKey(project.id), 'not json at all');

    const saved = repository.save(created.project, created.project.contentRevision);
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.reason).toBe('invalid-stored');
    expect(storage.getItem(projectKey(project.id))).toBe('not json at all');
  });
});

describe('conflict handling', () => {
  it('does not silently overwrite a newer save from another tab', async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const created = repository.create(createProject(input));
    if (!created.ok) throw new Error(created.message);
    const id = created.project.id;

    const storeA = makeStore(storage);
    const storeB = makeStore(storage);
    storeA.openProject(id);
    storeB.openProject(id);

    storeA.mutate((project) => renameProject(project, 'Renamed by tab A'));
    expect((await storeA.flush()).ok).toBe(true);

    storeB.mutate((project) => updateBrief(project, { tone: 'Typed in tab B' }));
    const conflict = await storeB.flush();
    expect(conflict.ok).toBe(false);
    expect(storeB.getSnapshot().active?.saveStatus).toBe('conflict');

    const stored = new ProjectRepository(storage).read(id);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.project.title).toBe('Renamed by tab A');
    expect(stored.project.brief.tone).not.toBe('Typed in tab B');

    // The losing tab keeps its own edits in memory.
    expect(storeB.getSnapshot().active?.project.brief.tone).toBe('Typed in tab B');

    // Reloading explicitly discards them in favour of the newer stored copy.
    expect(storeB.reloadActive().ok).toBe(true);
    expect(storeB.getSnapshot().active?.project.title).toBe('Renamed by tab A');
  });

  it('follows a newer save from another tab when this tab has no edits to protect', () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const created = repository.create(createProject(input));
    if (!created.ok) throw new Error(created.message);
    const id = created.project.id;

    const store = makeStore(storage);
    store.openProject(id);

    const value = saveFromAnotherTab(storage, id, 'Saved elsewhere');
    store.notifyStorageEvent(projectKey(id), value);

    const active = store.getSnapshot().active;
    expect(active?.saveStatus).toBe('clean');
    expect(active?.project.title).toBe('Saved elsewhere');
    expect(active?.baseRevision).toBe(active?.project.contentRevision);
  });

  it('keeps a conflict on screen when this tab also has edits', async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const created = repository.create(createProject(input));
    if (!created.ok) throw new Error(created.message);
    const id = created.project.id;

    const store = makeStore(storage);
    store.openProject(id);
    store.mutate((project) => updateBrief(project, { tone: 'Typed in this tab' }));

    const value = saveFromAnotherTab(storage, id, 'Saved elsewhere');
    store.notifyStorageEvent(projectKey(id), value);
    expect(store.getSnapshot().active?.saveStatus).toBe('conflict');

    // Further typing must not hide the warning or drop the local edits.
    store.mutate((project) => updateBrief(project, { tone: 'Still typing' }));
    const active = store.getSnapshot().active;
    expect(active?.saveStatus).toBe('conflict');
    expect(active?.message).toMatch(/another tab/i);
    expect(active?.project.brief.tone).toBe('Still typing');
    expect((await store.flush()).ok).toBe(false);
  });

  it('serializes two simultaneous saves so only one passes the revision check', async () => {
    const storage = new MemoryStorage();
    // Both stores share one lock queue, like two tabs using the same origin.
    const lock = queueLock();
    const seed = new ProjectRepository(storage, undefined, lock).create(createProject(input));
    if (!seed.ok) throw new Error(seed.message);
    const id = seed.project.id;

    const storeA = new ProjectStore(new ProjectRepository(storage, undefined, lock), {
      autosave: false,
    });
    const storeB = new ProjectStore(new ProjectRepository(storage, undefined, lock), {
      autosave: false,
    });
    storeA.openProject(id);
    storeB.openProject(id);

    storeA.mutate((project) => renameProject(project, 'Saved by tab A'));
    storeB.mutate((project) => updateBrief(project, { tone: 'Typed in tab B' }));

    // Neither save has finished when the other starts, so both begin from
    // revision 1. The lock makes the second one see revision 2 and conflict.
    const [first, second] = await Promise.all([storeA.flush(), storeB.flush()]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(storeB.getSnapshot().active?.saveStatus).toBe('conflict');
    expect(storeB.getSnapshot().active?.project.brief.tone).toBe('Typed in tab B');

    const stored = new ProjectRepository(storage).read(id);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.project.contentRevision).toBe(2);
    expect(stored.project.title).toBe('Saved by tab A');
    expect(stored.project.brief.tone).not.toBe('Typed in tab B');
  });

  it('holds the cross-tab lock for the revision check and the write', async () => {
    const storage = new MemoryStorage();
    const names: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = gatedLock(gate, names);
    const store = new ProjectStore(new ProjectRepository(storage, undefined, lock), {
      autosave: false,
    });
    const id = store.createProject(input).id as string;
    store.mutate((project) => updateBrief(project, { tone: 'Waits for the lock' }));

    const pending = store.flush();
    await Promise.resolve();

    // The save has asked for this project's lock but written nothing yet.
    expect(names).toEqual([projectLockName(id)]);
    const before = new ProjectRepository(storage).read(id);
    expect(before.ok && before.project.contentRevision).toBe(1);

    release();
    expect((await pending).ok).toBe(true);

    const stored = new ProjectRepository(storage).read(id);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.project.contentRevision).toBe(2);
    expect(stored.project.brief.tone).toBe('Waits for the lock');
  });

  it('treats a cleared origin storage as a deletion', () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    const id = store.createProject(input).id as string;

    new ProjectRepository(storage).remove(id);
    store.notifyStorageEvent(null, null);

    expect(store.getSnapshot().active?.saveStatus).toBe('deleted');
    expect(store.getSnapshot().cards).toHaveLength(0);
  });

  it('can discard edits that can never be saved', async () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    const id = store.createProject(input).id as string;

    new ProjectRepository(storage).remove(id);
    store.notifyStorageEvent(projectKey(id), null);
    store.mutate((project) => updateBrief(project, { tone: 'Cannot be saved' }));
    // Leaving normally would drop the edits, so closing is refused; discarding is explicit.
    await store.closeProject();
    expect(store.getSnapshot().active?.project.brief.tone).toBe('Cannot be saved');

    store.discardActiveEdits();
    expect(store.getSnapshot().active).toBeNull();
    expect(storage.getItem(projectKey(id))).toBeNull();
  });

  it('reports a project deleted in another tab and never recreates it', async () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    const created = store.createProject(input);
    const id = created.id as string;

    new ProjectRepository(storage).remove(id);
    store.notifyStorageEvent(projectKey(id), null);

    const active = store.getSnapshot().active;
    expect(active?.saveStatus).toBe('deleted');
    expect(active?.project.id).toBe(id);

    // A deleted project must not come back through a save.
    store.mutate((project) => updateBrief(project, { tone: 'Typed after deletion' }));
    expect((await store.flush()).ok).toBe(false);
    expect(store.getSnapshot().active?.project.brief.tone).toBe('Typed after deletion');
    expect(storage.getItem(projectKey(id))).toBeNull();
  });

  it('lets a tab with no edits leave a project another tab deleted', async () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    const id = store.createProject(input).id as string;

    new ProjectRepository(storage).remove(id);
    store.notifyStorageEvent(projectKey(id), null);
    await store.closeProject();

    expect(store.getSnapshot().active).toBeNull();
    expect(storage.getItem(projectKey(id))).toBeNull();
  });

  it('keeps the project open when leaving would lose unsaved edits', async () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    store.createProject(input);

    storage.failWrites = true;
    store.mutate((project) => updateBrief(project, { topic: 'Never silently dropped' }));
    await store.closeProject();

    const active = store.getSnapshot().active;
    expect(active?.saveStatus).toBe('error');
    expect(active?.project.brief.topic).toBe('Never silently dropped');
  });

  it('keeps in-memory edits and offers a real rescue export on quota failure', async () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    const created = store.createProject(input);

    storage.failWrites = true;
    store.mutate((project) => updateBrief(project, { topic: 'Typed before quota failure' }));
    const saved = await store.flush();

    expect(saved.ok).toBe(false);
    const active = store.getSnapshot().active;
    expect(active?.saveStatus).toBe('error');
    expect(active?.message).toMatch(/full/i);
    expect(active?.project.brief.topic).toBe('Typed before quota failure');

    const rescue = serializeProjectDataExport(active!.project);
    expect(() => JSON.parse(rescue)).not.toThrow();
    expect(JSON.parse(rescue).project.brief.topic).toBe('Typed before quota failure');
    expect(created.id).toBeTruthy();
  });
});
