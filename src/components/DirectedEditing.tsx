import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SignInWithFreebuff, useFreebuffUser } from '@freebuff/auth/react';
import { requestEditPlan } from '../ai/api';
import { AiError } from '../ai/types';
import { DEFAULT_AI_MODEL } from '../ai/models';
import { Dialog } from './Dialog';
import { Badge, Panel, TextAreaField } from './ui';
import { MAX_EDIT_HISTORY } from '../domain/constants';
import {
  MAX_EDIT_REQUEST_CHARS,
  applyEditPlan,
  editProjectFingerprint,
  previewEditPlan,
  undoEdit,
} from '../domain/editPlan';
import type { EditPlan } from '../domain/editPlan';
import { isDomainError } from '../domain/errors';
import { newId } from '../domain/ids';
import type { Project } from '../domain/types';
import { cleanupProjectMedia } from '../media/cleanup';
import { formatTimestamp } from '../format';
import { useStore } from '../state/StoreProvider';

function errorMessage(error: unknown): string {
  if (error instanceof AiError) return error.message;
  if (isDomainError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'That request could not be planned. Existing project content is unchanged.';
}

function usd(value: number): string {
  return value >= 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(4)}`;
}

function List({ title, items, tone }: { title: string; items: string[]; tone?: 'warn' }) {
  return (
    <div className="stack">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted-small">None.</p>
      ) : (
        <ul className={tone === 'warn' ? 'version-list version-list-warn' : 'version-list'}>
          {items.map((item) => (
            <li key={item}>
              <span className={tone === 'warn' ? 'field-error' : undefined}>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Directed editing: one request, previewed as a bounded set of allowlisted
 * commands, then applied atomically. The preview is recomputed from the live
 * project on every render, so an edit made elsewhere shows up as a stale plan
 * instead of being applied on top of a different board.
 */
export function DirectedEditing({ project }: { project: Project }) {
  return (
    <SignedIn>
      <DirectedEditingBody project={project} />
    </SignedIn>
  );
}

function SignedIn({ children }: { children: ReactNode }) {
  const { user, isLoading } = useFreebuffUser();
  if (isLoading) {
    return (
      <Panel title="Directed editing">
        <p className="muted-small">Checking sign-in…</p>
      </Panel>
    );
  }
  if (!user) {
    return (
      <Panel
        title="Directed editing"
        description="Ask for one scoped change and review exactly what it touches. Planning sends the request and project state to the provider, so it needs a Freebuff account."
      >
        <div className="row">
          <SignInWithFreebuff
            returnTo={`${window.location.pathname}${window.location.search}${window.location.hash}`}
          >
            Sign in to plan a change
          </SignInWithFreebuff>
        </div>
      </Panel>
    );
  }
  return <>{children}</>;
}

type PendingKind = 'plan' | 'apply' | 'undo';

export function DirectedEditingBody({ project }: { project: Project }) {
  const store = useStore();
  const [request, setRequest] = useState('');
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [providerAlternatives, setProviderAlternatives] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingKind | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const preview = plan ? previewEditPlan(project, plan) : null;
  const latestEdit = project.editHistory[0] ?? null;
  const alternatives = [
    ...new Set([...(preview?.alternatives ?? []), ...providerAlternatives]),
  ];

  const planChange = async () => {
    setPending(null);
    setError(null);
    setNotice(null);
    if (request.trim() === '') {
      setError('Describe the change you want.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const result = await requestEditPlan(
        project,
        request.trim(),
        DEFAULT_AI_MODEL,
        controller.signal,
      );
      const next: EditPlan = {
        id: newId('plan'),
        request: request.trim(),
        model: DEFAULT_AI_MODEL,
        projectFingerprint: editProjectFingerprint(project),
        inputFingerprint: result.inputFingerprint,
        createdAt: new Date().toISOString(),
        commands: result.tokens.commands,
        blocked: result.tokens.blocked,
        blockedScript: result.tokens.blockedScript,
      };
      setPlan(next);
      setExplanation(result.tokens.explanation || null);
      setProviderAlternatives(result.tokens.alternatives);
      if (next.commands.length === 0) {
        setNotice('No allowlisted command fits that request. Existing content is unchanged.');
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const applyPlan = () => {
    if (!plan) return;
    setPending(null);
    setError(null);
    const outcome = store.mutate((current) =>
      applyEditPlan(current, plan, { now: new Date().toISOString() }).project,
    );
    if (!outcome.ok) {
      setError(outcome.message ?? 'The change was not applied.');
      return;
    }
    setPlan(null);
    setExplanation(null);
    setProviderAlternatives([]);
    setNotice(
      'Change applied. Undo it below if it is not what you wanted; unrelated work was not touched.',
    );
    void cleanupProjectMedia(store).catch(() => undefined);
  };

  const runUndo = () => {
    if (!latestEdit) return;
    setPending(null);
    setError(null);
    const outcome = store.mutate((current) =>
      undoEdit(current, latestEdit.id, { now: new Date().toISOString() }),
    );
    if (!outcome.ok) {
      setError(outcome.message ?? 'That edit could not be undone.');
      return;
    }
    setNotice('The edit was undone. Its assets stay stored while the history refers to them.');
    void cleanupProjectMedia(store).catch(() => undefined);
  };

  return (
    <Panel
      title="Directed editing"
      description="Ask for one scoped change — a scene's visual, its on-screen text, its timing, or part of the script. A plan is checked against locks and the current board before anything is written."
    >
      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="stack">
        <TextAreaField
          id="directed-edit-request"
          label="Requested change"
          rows={3}
          value={request}
          disabled={busy}
          onChange={(event) => setRequest(event.target.value.slice(0, MAX_EDIT_REQUEST_CHARS))}
          placeholder="Replace scene three's visual only. Shorten the opening while keeping locked scenes."
          hint="One change per plan. The plan lists what it touches before anything is written."
        />
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || request.trim() === ''}
            onClick={() => setPending('plan')}
          >
            {busy ? 'Planning…' : 'Plan change'}
          </button>
          {plan ? (
            <button type="button" className="btn" onClick={() => setPlan(null)}>
              Discard plan
            </button>
          ) : null}
          <span className="muted-small">
            Planning is one billed provider request from today's allowance.
          </span>
        </div>
      </div>

      {preview ? (
        <div className="stack">
          <div className="row">
            <Badge tone={preview.applicable ? 'ok' : 'warn'}>
              {preview.stale
                ? 'Plan is stale'
                : preview.applicable
                  ? 'Plan is applicable'
                  : 'Plan cannot be applied'}
            </Badge>
            <span className="muted-small">
              {plan?.commands.length ?? 0} command{(plan?.commands.length ?? 0) === 1 ? '' : 's'} ·{' '}
              {plan?.request}
            </span>
          </div>

          {explanation ? <p className="muted-small">{explanation}</p> : null}

          {preview.stale ? (
            <div className="review-banner is-stale" role="alert">
              <div>
                <strong>The project changed after this plan was made</strong>
                <p>
                  Nothing was applied. Plan the change again so it is checked against the current
                  board.
                </p>
              </div>
            </div>
          ) : null}

          <List title="Affected components" items={preview.affected} />
          <List title="Preserved components" items={preview.preserved} />
          <List
            title="Lock conflicts"
            tone="warn"
            items={preview.lockConflicts.map((conflict) =>
              conflict.source === 'request'
                ? `${conflict.message} (inferred from your request)`
                : conflict.message,
            )}
          />
          <List title="Timing implications" items={preview.timing} />
          <List title="Required regenerations" items={preview.regenerations} />
          <List title="Alternatives" items={alternatives} />

          <p className="muted-small">
            Estimated additional usage: 1 AI planning request (spent when this plan was
            generated).{' '}
            {preview.estimatedUsage.narrationUsd !== null
              ? `Regenerating narration would be about ${usd(preview.estimatedUsage.narrationUsd)} for ${preview.estimatedUsage.narrationCharacters} characters at the published list price. `
              : 'No narration regeneration is needed. '}
            {preview.estimatedUsage.imageGenerations > 0
              ? `${preview.estimatedUsage.imageGenerations} scene image${preview.estimatedUsage.imageGenerations === 1 ? '' : 's'} would need a fresh generation.`
              : 'No image generation is required.'}
          </p>

          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!preview.applicable || busy}
              onClick={() => setPending('apply')}
            >
              Apply change
            </button>
            <button type="button" className="btn" onClick={() => setPlan(null)}>
              Discard plan
            </button>
          </div>
        </div>
      ) : null}

      {latestEdit ? (
        <div className="stack">
          <h3>Undo history</h3>
          <p className="muted-small">
            Last edit: “{latestEdit.request}” applied {formatTimestamp(latestEdit.appliedAt)}.{' '}
            {project.editHistory.length} of {MAX_EDIT_HISTORY} edits kept — the oldest is dropped
            first, and only once its assets are no longer referenced.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => setPending('undo')}
            >
              Undo this edit
            </button>
          </div>
        </div>
      ) : null}

      {pending === 'plan' ? (
        <Dialog
          title="Plan this change?"
          description="This sends your request and the current script, scenes, and locks to the provider as one planning request. It does not change the project."
          onDismiss={() => setPending(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void planChange()}>
                Plan change
              </button>
            </>
          }
        />
      ) : null}

      {pending === 'apply' && preview ? (
        <Dialog
          title="Apply this change?"
          description={`This writes ${preview.affected.join('; ')}. Everything listed under Preserved stays as it is. It can be undone from the undo history while that record is kept.`}
          onDismiss={() => setPending(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={applyPlan}>
                Apply change
              </button>
            </>
          }
        />
      ) : null}

      {pending === 'undo' && latestEdit ? (
        <Dialog
          title="Undo this edit?"
          description={`“${latestEdit.request}” will be reverted with the same lock checks. Unlocking is never automatic: a locked component that changed will refuse the undo.`}
          onDismiss={() => setPending(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={runUndo}>
                Undo edit
              </button>
            </>
          }
        />
      ) : null}
    </Panel>
  );
}
