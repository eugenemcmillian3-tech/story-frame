import { isDomainError } from '../domain/errors';
import {
  createProject,
  duplicateProject as copyProject,
  renameProject as retitleProject,
  setStage,
} from '../domain/project';
import type { NewProjectInput } from '../domain/project';
import { createSampleProject } from '../domain/sample';
import { describeWorkflowStatus } from '../domain/staleness';
import type { Project, Stage } from '../domain/types';
import { projectIdFromKey } from '../persistence/projectRepository';
import type { ProjectRepository, SaveResult } from '../persistence/projectRepository';
import type { Route } from '../router';

export type SaveStatus = 'clean' | 'dirty' | 'saved' | 'error' | 'conflict' | 'deleted';

export interface ProjectCard {
  id: string;
  title: string;
  mode: Project['brief']['mode'];
  targetDuration: Project['brief']['targetDuration'];
  visualPreset: Project['brief']['visualPreset'];
  updatedAt: string;
  workflowLabel: string;
  isSample: boolean;
  readable: boolean;
  problem?: string;
}

export interface ActiveProject {
  project: Project;
  /** Revision last known to exist in storage; used for conflict detection. */
  baseRevision: number;
  saveStatus: SaveStatus;
  message: string | null;
}

export interface AppState {
  cards: ProjectCard[];
  active: ActiveProject | null;
  openError: string | null;
}

export interface StoreResult {
  ok: boolean;
  message?: string;
  id?: string;
}

export interface ProjectStoreOptions {
  /** Milliseconds to wait before an automatic save. Set autosave false in tests. */
  autosaveDelayMs?: number;
  autosave?: boolean;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * Application state. Holds at most one open project plus the dashboard cards.
 * Projects themselves are the single source of truth in storage; cards are
 * derived by reading them, never duplicated into a second store.
 */
export class ProjectStore {
  private state: AppState = { cards: [], active: null, openError: null };
  private readonly listeners = new Set<() => void>();
  private readonly repository: ProjectRepository;
  private readonly options: Required<ProjectStoreOptions>;
  private timer: unknown = null;
  private dirty = false;
  /** Saves run one at a time so each check reads the revision the last one wrote. */
  private saveQueue: Promise<unknown> = Promise.resolve();

  constructor(repository: ProjectRepository, options: ProjectStoreOptions = {}) {
    this.repository = repository;
    this.options = {
      autosaveDelayMs: options.autosaveDelayMs ?? 700,
      autosave: options.autosave ?? true,
      schedule: options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      cancel: options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    };
    this.refresh();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AppState => this.state;

  get storageAvailable(): boolean {
    return this.repository.available;
  }

  private setState(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  private buildCards(): ProjectCard[] {
    const readable: ProjectCard[] = [];
    const unreadable: ProjectCard[] = [];
    for (const id of this.repository.listIds()) {
      const result = this.repository.read(id);
      if (result.ok) {
        const project = result.project;
        readable.push({
          id: project.id,
          title: project.title,
          mode: project.brief.mode,
          targetDuration: project.brief.targetDuration,
          visualPreset: project.brief.visualPreset,
          updatedAt: project.updatedAt,
          workflowLabel: describeWorkflowStatus(project),
          isSample: project.isSample,
          readable: true,
        });
      } else {
        unreadable.push({
          id,
          title: 'Unreadable project',
          mode: 'factual',
          targetDuration: 60,
          visualPreset: 'clean-educational',
          updatedAt: '',
          workflowLabel: 'Cannot be opened',
          isSample: false,
          readable: false,
          problem: result.message,
        });
      }
    }
    readable.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return [...readable, ...unreadable];
  }

  refresh(): void {
    this.setState({ cards: this.buildCards() });
  }

  /** Readable projects only; used for safe media reference counting. */
  listAllProjects(): Project[] {
    const projects: Project[] = [];
    for (const id of this.repository.listIds()) {
      const read = this.repository.read(id);
      if (read.ok) projects.push(read.project);
    }
    return projects;
  }

  hasUnreadableProjects(): boolean {
    return this.state.cards.some((card) => !card.readable);
  }

  getActiveProject(): Project | null {
    return this.state.active?.project ?? null;
  }

  // -------------------------------------------------------------------------
  // Opening and routing
  // -------------------------------------------------------------------------

  openProject(id: string): void {
    this.clearTimer();
    const result = this.repository.read(id);
    if (!result.ok) {
      this.dirty = false;
      this.setState({
        active: null,
        openError:
          result.reason === 'missing'
            ? 'This project is not saved in this browser any more.'
            : result.message,
      });
      return;
    }
    this.dirty = false;
    this.setState({
      openError: null,
      active: {
        project: result.project,
        baseRevision: result.project.contentRevision,
        saveStatus: 'clean',
        message: null,
      },
    });
  }

  async closeProject(): Promise<void> {
    const id = this.state.active?.project.id ?? null;
    // Never drop in-memory edits on the floor: if the final save fails, keep the
    // project open so the save banner can offer a rescue export.
    if (this.dirty) {
      const result = await this.flush();
      if (!result.ok) return;
    }
    if (id !== null && this.state.active?.project.id !== id) return;
    this.clearTimer();
    this.dirty = false;
    this.setState({ active: null, openError: null });
    this.refresh();
  }

  /** Keep the store aligned with the current route without duplicating state. */
  syncRoute(route: Route): void {
    if (route.name === 'project') {
      const active = this.state.active;
      if (!active || active.project.id !== route.id) {
        this.openProject(route.id);
        return;
      }
      if (active.project.workflow.lastStage !== route.stage) {
        this.applyMutation((project) => setStage(project, route.stage));
      }
      return;
    }
    if (this.state.active) void this.closeProject();
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  private applyMutation(mutator: (project: Project) => Project): StoreResult {
    const active = this.state.active;
    if (!active) return { ok: false, message: 'No project is open.' };
    let next: Project;
    try {
      next = mutator(active.project);
    } catch (error) {
      if (isDomainError(error)) return { ok: false, message: error.message };
      if (error instanceof Error) return { ok: false, message: error.message };
      return { ok: false, message: 'That change could not be applied.' };
    }
    if (next === active.project) return { ok: true };

    // A conflict or a deletion outranks "dirty": the banner stays up until the
    // user decides what happens to edits that cannot be written.
    const blocked = active.saveStatus === 'conflict' || active.saveStatus === 'deleted';

    this.dirty = true;
    this.setState({
      active: {
        ...active,
        project: next,
        saveStatus: blocked ? active.saveStatus : 'dirty',
        message: blocked ? active.message : null,
      },
    });
    this.scheduleSave();
    return { ok: true };
  }

  mutate(mutator: (project: Project) => Project): StoreResult {
    return this.applyMutation(mutator);
  }

  setStage(stage: Stage): StoreResult {
    return this.applyMutation((project) => setStage(project, stage));
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  private scheduleSave(): void {
    if (!this.options.autosave || !this.dirty) return;
    if (this.state.active?.saveStatus === 'conflict') return;
    if (this.state.active?.saveStatus === 'deleted') return;
    this.clearTimer();
    this.timer = this.options.schedule(() => {
      this.timer = null;
      void this.flush();
    }, this.options.autosaveDelayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.options.cancel(this.timer);
      this.timer = null;
    }
  }

  /**
   * Save the open project. Calls are queued within this tab, and the
   * repository holds a cross-tab lock while it checks the revision and writes,
   * so the check and the write are one atomic step between tabs.
   */
  flush(): Promise<StoreResult> {
    const run = this.saveQueue.then(() => this.flushNow());
    this.saveQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Best-effort save for page unload, where a cross-tab lock cannot be awaited.
   * The revision check still refuses to overwrite a newer stored copy.
   */
  flushSync(): StoreResult {
    this.clearTimer();
    const target = this.saveTarget();
    if (!target.ok) return target.result;
    return this.commitSave(
      this.repository.save(target.active.project, target.active.baseRevision),
      target.active,
    );
  }

  private async flushNow(): Promise<StoreResult> {
    this.clearTimer();
    const target = this.saveTarget();
    if (!target.ok) return target.result;
    const outcome = await this.repository.saveExclusive(
      target.active.project,
      target.active.baseRevision,
    );
    return this.commitSave(outcome, target.active);
  }

  /** The open project, if it has edits that are allowed to be written. */
  private saveTarget(): { ok: true; active: ActiveProject } | { ok: false; result: StoreResult } {
    const active = this.state.active;
    if (!active) return { ok: false, result: { ok: true } };
    // With nothing to write there is nothing to lose, even if the stored copy
    // moved on or disappeared: leaving is safe and needs no confirmation.
    if (!this.dirty) return { ok: false, result: { ok: true } };
    if (active.saveStatus === 'conflict') {
      return {
        ok: false,
        result: { ok: false, message: active.message ?? 'Another copy of this project is newer.' },
      };
    }
    if (active.saveStatus === 'deleted') {
      return {
        ok: false,
        result: {
          ok: false,
          message: active.message ?? 'This project no longer exists in storage.',
        },
      };
    }
    return { ok: true, active };
  }

  private commitSave(outcome: SaveResult, attempted: ActiveProject): StoreResult {
    const current = this.state.active;
    const stillOpen = current !== null && current.project.id === attempted.project.id;

    if (outcome.ok) {
      if (!stillOpen) {
        this.refresh();
        return { ok: true };
      }
      // Edits made while the save was in flight stay in memory and become the
      // next write; only the revision this save produced is adopted.
      const unchanged = current.project === attempted.project;
      this.dirty = !unchanged;
      this.setState({
        active: {
          project: unchanged ? outcome.project : current.project,
          baseRevision: outcome.project.contentRevision,
          saveStatus: unchanged ? 'saved' : 'dirty',
          message: null,
        },
      });
      this.refresh();
      if (!unchanged) this.scheduleSave();
      return { ok: true };
    }

    if (!stillOpen) {
      this.refresh();
      return { ok: false, message: outcome.message };
    }

    const status: SaveStatus =
      outcome.reason === 'conflict'
        ? 'conflict'
        : outcome.reason === 'deleted-externally'
          ? 'deleted'
          : 'error';

    this.setState({
      active: { ...current, saveStatus: status, message: outcome.message },
    });
    if (status === 'error') this.dirty = true;
    return { ok: false, message: outcome.message };
  }

  /** Discard in-memory edits and load the newest stored copy. */
  reloadActive(): StoreResult {
    const active = this.state.active;
    if (!active) return { ok: false, message: 'No project is open.' };
    this.openProject(active.project.id);
    if (this.state.openError) return { ok: false, message: this.state.openError };
    return { ok: true };
  }

  /**
   * Forget the open project without saving. Only offered for edits that cannot
   * be written (conflict, deletion, storage failure), after the UI confirms.
   */
  discardActiveEdits(): void {
    this.clearTimer();
    this.dirty = false;
    this.setState({ active: null, openError: null });
    this.refresh();
  }

  /** Keep in-memory edits by writing them as a brand-new project. */
  saveAsNewProject(): StoreResult {
    const active = this.state.active;
    if (!active) return { ok: false, message: 'No project is open.' };
    const copy = copyProject(active.project);
    const created = this.repository.create(copy);
    if (!created.ok) return { ok: false, message: created.message };
    this.refresh();
    this.openProject(created.project.id);
    return { ok: true, id: created.project.id };
  }

  // -------------------------------------------------------------------------
  // Dashboard operations
  // -------------------------------------------------------------------------

  createProject(input: NewProjectInput): StoreResult {
    const project = createProject(input);
    const result = this.repository.create(project);
    if (!result.ok) return { ok: false, message: result.message };
    this.refresh();
    this.openProject(result.project.id);
    return { ok: true, id: result.project.id };
  }

  installSampleProject(): StoreResult {
    const result = this.repository.create(createSampleProject());
    if (!result.ok) return { ok: false, message: result.message };
    this.refresh();
    this.openProject(result.project.id);
    return { ok: true, id: result.project.id };
  }

  async renameProject(id: string, title: string): Promise<StoreResult> {
    const read = this.repository.read(id);
    if (!read.ok) return { ok: false, message: read.message };
    const renamed = retitleProject(read.project, title);
    if (renamed === read.project) return { ok: true, id };
    const saved = await this.repository.saveExclusive(renamed, read.project.contentRevision);
    if (!saved.ok) return { ok: false, message: saved.message };
    if (this.state.active?.project.id === id) {
      this.setState({
        active: {
          project: { ...this.state.active.project, title: saved.project.title, updatedAt: saved.project.updatedAt },
          baseRevision: saved.project.contentRevision,
          saveStatus: 'saved',
          message: null,
        },
      });
    }
    this.refresh();
    return { ok: true, id };
  }

  duplicateProject(id: string): StoreResult {
    const read = this.repository.read(id);
    if (!read.ok) return { ok: false, message: read.message };
    const copy = copyProject(read.project);
    const created = this.repository.create(copy);
    if (!created.ok) return { ok: false, message: created.message };
    this.refresh();
    return { ok: true, id: created.project.id };
  }

  async deleteProject(id: string): Promise<StoreResult> {
    const active = this.state.active;
    if (active?.project.id === id && this.dirty) await this.flush();
    const result = this.repository.remove(id);
    if (this.state.active?.project.id === id) {
      this.clearTimer();
      this.dirty = false;
      this.setState({ active: null, openError: null });
    }
    this.refresh();
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  /**
   * Cross-tab notification from the storage event (or a test). A null key means
   * another tab cleared this origin's storage.
   */
  notifyStorageEvent(key: string | null, newValue: string | null): void {
    const id = key === null ? null : projectIdFromKey(key);
    if (key !== null && id === null) return;

    this.refresh();

    const active = this.state.active;
    if (!active) return;
    if (id !== null && active.project.id !== id) return;

    const read = this.repository.read(active.project.id);
    if (!read.ok) {
      const removed = newValue === null || key === null;
      this.clearTimer();
      this.setState({
        active: {
          ...active,
          saveStatus: removed ? 'deleted' : 'conflict',
          message: removed
            ? 'This project was deleted in another tab.'
            : 'This project changed in another tab and the newer copy cannot be read.',
        },
      });
      return;
    }

    if (read.project.contentRevision === active.baseRevision) return;

    if (!this.dirty) {
      // Nothing in this tab would be lost, so follow the newer copy rather than
      // stopping autosave with a conflict over edits that do not exist.
      this.setState({
        active: {
          project: read.project,
          baseRevision: read.project.contentRevision,
          saveStatus: 'clean',
          message: null,
        },
      });
      return;
    }

    this.setState({
      active: {
        ...active,
        saveStatus: 'conflict',
        message:
          'This project was saved in another tab. Your edits here are still open and nothing was overwritten.',
      },
    });
  }
}
