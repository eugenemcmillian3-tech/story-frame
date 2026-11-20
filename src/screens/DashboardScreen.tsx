import { useState } from 'react';
import type { FormEvent } from 'react';
import { Dialog } from '../components/Dialog';
import { Badge, Panel, SelectField, TextField } from '../components/ui';
import {
  MODE_LABELS,
  TARGET_DURATIONS,
  VISUAL_PRESET_LABELS,
  VISUAL_PRESETS,
} from '../domain/constants';
import { formatDuration } from '../domain/duration';
import type { ProjectMode, TargetDuration, VisualPreset } from '../domain/types';
import { formatTimestamp } from '../format';
import { cleanupProjectMedia } from '../media/cleanup';
import { deleteRendersForProject } from '../media/mediaDb';
import { cancelRenderJob } from '../render/renderManager';
import { routeToHash } from '../router';
import { useAppState, useStore } from '../state/StoreProvider';
import type { ProjectCard } from '../state/store';

export function DashboardScreen() {
  const store = useStore();
  const state = useAppState();

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<ProjectMode>('factual');
  const [targetDuration, setTargetDuration] = useState<TargetDuration>(60);
  const [visualPreset, setVisualPreset] = useState<VisualPreset>('clean-educational');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectCard | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectCard | null>(null);

  const handleCreate = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() === '') {
      setFormError('Give the project a title so you can find it later.');
      return;
    }
    const result = store.createProject({ title, mode, targetDuration, visualPreset });
    if (!result.ok || !result.id) {
      setFormError(result.message ?? 'The project could not be created.');
      return;
    }
    setFormError(null);
    setCreating(false);
    window.location.hash = routeToHash({ name: 'project', id: result.id, stage: 'brief' });
  };

  const handleSample = () => {
    const result = store.installSampleProject();
    if (!result.ok || !result.id) {
      setNotice(result.message ?? 'The sample project could not be created.');
      return;
    }
    window.location.hash = routeToHash({ name: 'project', id: result.id, stage: 'brief' });
  };

  const openRename = (card: ProjectCard) => {
    setRenameTarget(card);
    setRenameValue(card.title);
    setRenameError(null);
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const result = await store.renameProject(renameTarget.id, renameValue);
    if (!result.ok) {
      setRenameError(result.message ?? 'The project could not be renamed.');
      return;
    }
    setRenameTarget(null);
    setNotice('Project renamed.');
  };

  const handleDuplicate = (card: ProjectCard) => {
    const result = store.duplicateProject(card.id);
    if (!result.ok) {
      setNotice(result.message ?? 'The project could not be duplicated.');
      return;
    }
    setNotice('Duplicated with new project and scene IDs.');
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const projectId = deleteTarget.id;
    // A render for this project has nowhere to go once it is deleted.
    cancelRenderJob(projectId);
    const result = await store.deleteProject(projectId);
    setDeleteTarget(null);
    setNotice(
      result.ok
        ? 'Project deleted from this browser.'
        : (result.message ?? 'The project could not be deleted.'),
    );
    if (!result.ok) return;
    // Images and rendered videos are stored separately; clear what this project
    // alone referenced. Shared image assets stay while any other project uses them.
    void deleteRendersForProject(projectId).catch(() => undefined);
    void cleanupProjectMedia(store).catch(() => undefined);
  };

  return (
    <div className="dashboard">
      <header className="screen-head">
        <div>
          <h1>Projects</h1>
          <p className="screen-subtitle">
            Vertical 9:16 shorts for solo creators. Brief → script → storyboard → preview.
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={handleSample}>
            Load sample project
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setCreating(true);
              setFormError(null);
            }}
          >
            New project
          </button>
        </div>
      </header>

      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      {creating ? (
        <Panel
          title="New project"
          description="You can change the title, mode, length, and preset later in the brief."
          className="create-panel"
        >
          <form className="form-grid" onSubmit={handleCreate}>
            <TextField
              id="new-project-title"
              label="Title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="How tide pools survive low tide"
              required
              error={formError ?? undefined}
            />
            <SelectField
              id="new-project-mode"
              label="Mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as ProjectMode)}
            >
              <option value="factual">Factual</option>
              <option value="fiction">Fiction</option>
            </SelectField>
            <SelectField
              id="new-project-duration"
              label="Target duration"
              value={String(targetDuration)}
              onChange={(event) =>
                setTargetDuration(Number(event.target.value) as TargetDuration)
              }
            >
              {TARGET_DURATIONS.map((duration) => (
                <option key={duration} value={duration}>
                  {duration} seconds
                </option>
              ))}
            </SelectField>
            <SelectField
              id="new-project-preset"
              label="Visual preset"
              value={visualPreset}
              onChange={(event) => setVisualPreset(event.target.value as VisualPreset)}
            >
              {VISUAL_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </SelectField>
            <div className="row form-actions">
              <button type="submit" className="btn btn-primary">
                Create project
              </button>
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </form>
        </Panel>
      ) : null}

      {state.cards.length === 0 ? (
        <div className="empty-state">
          <h2>No projects yet</h2>
          <p>
            Start with a brief: the topic, who it is for, and what the viewer should take away.
            Then write one narration script and lay it out as a vertical storyboard.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setCreating(true)}
            >
              Create a project
            </button>
            <button type="button" className="btn" onClick={handleSample}>
              Load sample project (demo fixtures)
            </button>
          </div>
          <p className="muted-small">Saved on this browser only.</p>
        </div>
      ) : (
        <ul className="project-grid">
          {state.cards.map((card) => (
            <li key={card.id} className="project-card">
              <div className="project-card-top">
                <h2>{card.title}</h2>
                {card.isSample ? <Badge tone="accent">Sample</Badge> : null}
                {!card.readable ? <Badge tone="danger">Unreadable</Badge> : null}
              </div>
              {card.readable ? (
                <div className="badge-row">
                  <Badge>{MODE_LABELS[card.mode]}</Badge>
                  <Badge>{formatDuration(card.targetDuration)}</Badge>
                  <Badge>{VISUAL_PRESET_LABELS[card.visualPreset]}</Badge>
                </div>
              ) : null}
              <p className="project-card-status">
                {card.readable ? card.workflowLabel : card.problem}
              </p>
              <p className="project-card-updated">Updated {formatTimestamp(card.updatedAt)}</p>
              <div className="project-card-actions">
                {card.readable ? (
                  <a
                    className="btn btn-primary"
                    href={routeToHash({ name: 'project', id: card.id, stage: 'brief' })}
                  >
                    Open
                  </a>
                ) : null}
                {card.readable ? (
                  <button type="button" className="btn" onClick={() => openRename(card)}>
                    Rename
                  </button>
                ) : null}
                {card.readable ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => handleDuplicate(card)}
                  >
                    Duplicate
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setDeleteTarget(card)}
                >
                  {card.readable ? 'Delete' : 'Remove from this browser'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {renameTarget ? (
        <Dialog
          title="Rename project"
          description="The project keeps its content and IDs."
          onDismiss={() => setRenameTarget(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setRenameTarget(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={submitRename}>
                Save name
              </button>
            </>
          }
        >
          <TextField
            id="rename-project-title"
            label="Project title"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            error={renameError ?? undefined}
          />
        </Dialog>
      ) : null}

      {deleteTarget ? (
        <Dialog
          title={deleteTarget.readable ? 'Delete project?' : 'Remove unreadable project?'}
          description={
            deleteTarget.readable
              ? `"${deleteTarget.title}" will be removed from this browser. This cannot be undone here.`
              : 'The unreadable stored record will be removed from this browser. Its raw data cannot be recovered afterwards.'
          }
          onDismiss={() => setDeleteTarget(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={confirmDelete}>
                {deleteTarget.readable ? 'Delete project' : 'Remove record'}
              </button>
            </>
          }
        />
      ) : null}
    </div>
  );
}
