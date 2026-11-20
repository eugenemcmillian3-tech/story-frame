import { useState } from 'react';
import { AiScriptPlanner } from '../components/AiPlanning';
import { Dialog } from '../components/Dialog';
import { NarrationPanel } from '../components/NarrationPanel';
import { Badge, Panel, TextAreaField, TextField } from '../components/ui';
import { NARRATION_WORDS_PER_MINUTE } from '../domain/constants';
import { countWords, estimateRuntimeSeconds, formatDuration } from '../domain/duration';
import { newId } from '../domain/ids';
import {
  removeSourceNote,
  replaceScriptNarration,
  restoreScriptVersion,
  setScriptLock,
  updateSourceNote,
  updateSourceNotes,
  updateStoryNotes,
} from '../domain/project';
import { DEMO_SCRIPTS } from '../domain/sample';
import type { Project, ScriptVersion } from '../domain/types';
import { formatTimestamp } from '../format';
import { routeToHash } from '../router';
import { useStore } from '../state/StoreProvider';

export function ScriptScreen({ project }: { project: Project }) {
  const store = useStore();
  const [error, setError] = useState<string | null>(null);
  const [pendingDemo, setPendingDemo] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<ScriptVersion | null>(null);

  const script = project.script;
  const words = countWords(script.narration);
  const runtime = estimateRuntimeSeconds(script.narration);
  const demo = DEMO_SCRIPTS[project.brief.mode];

  const run = (mutator: (current: Project) => Project) => {
    const result = store.mutate(mutator);
    setError(result.ok ? null : (result.message ?? 'That change was not applied.'));
  };

  const applyDemo = () => {
    setPendingDemo(false);
    run((current) =>
      replaceScriptNarration(current, DEMO_SCRIPTS[current.brief.mode].narration, {
        archivePrevious: true,
      }),
    );
  };

  const addSource = () => {
    run((current) =>
      updateSourceNotes(current, [
        ...current.sourceNotes,
        { id: newId('src'), title: '', url: '', excerpt: '', notes: '' },
      ]),
    );
  };

  return (
    <div className="stack">
      <header className="screen-head">
        <div>
          <h1>Script</h1>
          <p className="screen-subtitle">
            One narration script, one source of truth. No separate hook, body, and ending copies.
          </p>
        </div>
        <div className="row">
          <Badge tone={script.locked ? 'warn' : 'neutral'}>
            {script.locked ? 'Locked' : 'Unlocked'}
          </Badge>
          <Badge>{project.brief.mode === 'factual' ? 'Factual' : 'Fiction'}</Badge>
        </div>
      </header>

      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}

      <AiScriptPlanner project={project} />

      <Panel
        title="Narration"
        description="Write it the way it should be spoken out loud."
        actions={
          <>
            <button
              type="button"
              className="btn btn-small"
              aria-pressed={script.locked}
              onClick={() => run((current) => setScriptLock(current, !current.script.locked))}
            >
              {script.locked ? 'Unlock script' : 'Lock script'}
            </button>
          </>
        }
      >
        <TextAreaField
          id="script-narration"
          label="Narration script"
          value={script.narration}
          rows={16}
          disabled={script.locked}
          onChange={(event) =>
            run((current) => replaceScriptNarration(current, event.target.value))
          }
          placeholder="Write the narration here."
          hint={
            script.locked
              ? `Locked ${script.lockedAt ? `on ${formatTimestamp(script.lockedAt)}` : ''}. Unlock to edit.`
              : 'The script is unlocked. Locking prevents edits and accidental replacement.'
          }
        />

        <div className="stats-row">
          <div className="stat">
            <span className="stat-label">Words</span>
            <span className="stat-value">{words}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Estimated runtime</span>
            <span className="stat-value">≈ {formatDuration(runtime)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Brief target</span>
            <span className="stat-value">{formatDuration(project.brief.targetDuration)}</span>
          </div>
        </div>
        <p className="muted-small">
          Runtime is estimated from {words} words at {NARRATION_WORDS_PER_MINUTE} words per minute.
          It is an estimate, not measured audio.
        </p>
        <p className="fingerprint">
          Content fingerprint <code>{script.fingerprint}</code> — the storyboard review compares
          this exact value, so any edit invalidates review.
        </p>

        <div className="row">
          <button
            type="button"
            className="btn btn-small"
            disabled={script.locked}
            onClick={() => (script.narration.trim() === '' ? applyDemo() : setPendingDemo(true))}
          >
            Load demo script (sample fixture, not generated)
          </button>
          <a
            className="btn btn-small"
            href={routeToHash({ name: 'project', id: project.id, stage: 'storyboard' })}
          >
            Go to storyboard
          </a>
        </div>
        <p className="muted-small">
          Sample fixtures are written by hand and shipped with the app. Nothing here is generated by
          AI. Loading one replaces the narration and keeps the current text as a previous version.
        </p>
      </Panel>

      <NarrationPanel project={project} />

      {script.versions.length > 0 ? (
        <Panel
          title="Previous script versions"
          description={`Up to 5 replaced narrations are kept in this browser. Restoring one also archives the current narration.`}
        >
          <ul className="version-list">
            {script.versions.map((version) => (
              <li key={version.id}>
                <div>
                  <p className="version-meta">Replaced {formatTimestamp(version.replacedAt)}</p>
                  <p className="version-excerpt">
                    {version.narration.trim().slice(0, 180) || '(empty)'}
                    {version.narration.trim().length > 180 ? '…' : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={script.locked}
                  onClick={() => setPendingRestore(version)}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {project.brief.mode === 'factual' ? (
        <Panel
          title="Source notes"
          description="Sources are user-provided and unverified. A URL does not mean this app has retrieved the page; nothing is fetched or checked."
        >
          {project.sourceNotes.length === 0 ? (
            <p className="muted-small">
              No sources yet. Add the titles, links, and excerpts you are working from.
            </p>
          ) : (
            <div className="stack">
              {project.sourceNotes.map((note) => (
                <div key={note.id} className="source-card">
                  <div className="form-grid">
                    <TextField
                      id={`source-title-${note.id}`}
                      label="Source title"
                      value={note.title}
                      onChange={(event) =>
                        run((current) =>
                          updateSourceNote(current, note.id, { title: event.target.value }),
                        )
                      }
                    />
                    <TextField
                      id={`source-url-${note.id}`}
                      label="URL (optional)"
                      value={note.url}
                      placeholder="https://"
                      onChange={(event) =>
                        run((current) =>
                          updateSourceNote(current, note.id, { url: event.target.value }),
                        )
                      }
                    />
                  </div>
                  <TextAreaField
                    id={`source-excerpt-${note.id}`}
                    label="Pasted excerpt"
                    rows={3}
                    value={note.excerpt}
                    onChange={(event) =>
                      run((current) =>
                        updateSourceNote(current, note.id, { excerpt: event.target.value }),
                      )
                    }
                  />
                  <TextAreaField
                    id={`source-notes-${note.id}`}
                    label="Your notes"
                    rows={2}
                    value={note.notes}
                    onChange={(event) =>
                      run((current) =>
                        updateSourceNote(current, note.id, { notes: event.target.value }),
                      )
                    }
                  />
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      onClick={() => run((current) => removeSourceNote(current, note.id))}
                    >
                      Remove source
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <button type="button" className="btn btn-small" onClick={addSource}>
              Add source note
            </button>
          </div>
        </Panel>
      ) : (
        <Panel
          title="Story notes"
          description="Fiction mode. These notes are context for the story; they are not used to generate anything in this milestone."
        >
          <TextAreaField
            id="story-characters"
            label="Characters"
            rows={3}
            value={project.storyNotes.characters}
            onChange={(event) =>
              run((current) => updateStoryNotes(current, { characters: event.target.value }))
            }
            placeholder="Who is in it, and what do they want?"
          />
          <TextAreaField
            id="story-setting"
            label="Setting"
            rows={3}
            value={project.storyNotes.setting}
            onChange={(event) =>
              run((current) => updateStoryNotes(current, { setting: event.target.value }))
            }
            placeholder="Where and when does it happen?"
          />
          <TextAreaField
            id="story-continuity"
            label="Continuity notes"
            rows={3}
            value={project.storyNotes.continuity}
            onChange={(event) =>
              run((current) => updateStoryNotes(current, { continuity: event.target.value }))
            }
            placeholder="Details that must stay consistent across scenes."
          />
        </Panel>
      )}

      <div className="row panel-actions">
        <a
          className="btn btn-primary"
          href={routeToHash({ name: 'project', id: project.id, stage: 'storyboard' })}
        >
          Continue to storyboard
        </a>
        <button
          type="button"
          className="btn"
          disabled={script.locked}
          onClick={() => (script.narration.trim() === '' ? applyDemo() : setPendingDemo(true))}
        >
          Load demo script
        </button>
      </div>

      {pendingDemo ? (
        <Dialog
          title="Load the demo script?"
          description={`"${demo.title}" is a hand-written sample fixture, not AI output. It replaces the current narration; the current text is kept as a previous version.`}
          onDismiss={() => setPendingDemo(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setPendingDemo(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={applyDemo}>
                Replace narration with demo script
              </button>
            </>
          }
        />
      ) : null}

      {pendingRestore ? (
        <Dialog
          title="Restore this version?"
          description="The current narration is archived as a previous version first, so this can be undone."
          onDismiss={() => setPendingRestore(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setPendingRestore(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const version = pendingRestore;
                  setPendingRestore(null);
                  run((current) => restoreScriptVersion(current, version.id));
                }}
              >
                Restore version
              </button>
            </>
          }
        />
      ) : null}
    </div>
  );
}
