import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SignInWithFreebuff, useFreebuffUser } from '@freebuff/auth/react';
import { requestAngles, requestScript, requestStoryboard } from '../ai/api';
import { attachClaimSource, claimSourceOptions, removeClaimSource } from '../ai/claims';
import { AI_MODELS, DEFAULT_AI_MODEL } from '../ai/models';
import type { AiModelId } from '../ai/models';
import {
  normalizeNarrationWhitespace,
  pacingWarnings,
  parseStoryboardTokens,
  scriptNarration,
  unresolvedClaims,
} from '../ai/contracts';
import {
  angleInputFingerprint,
  scriptInputFingerprint,
  storyboardInputFingerprint,
} from '../ai/input';
import { AiError } from '../ai/types';
import type {
  AiAngleSnapshot,
  AiClaim,
  AiSourceInput,
  AngleProposal,
  ScriptProposal,
  StoryboardProposal,
  StoryboardProposalScene,
} from '../ai/types';
import { useProposalStore } from '../ai/useProposals';
import { ASSET_TYPES } from '../domain/constants';
import { addPlanningNote, acceptStoryboardDraft, removePlanningNote, replaceScriptNarration, restorePreviousStoryboard } from '../domain/project';
import { isDomainError } from '../domain/errors';
import { formatDuration } from '../domain/duration';
import { validateBrief } from '../domain/staleness';
import type { AssetType, Project } from '../domain/types';
import { formatTimestamp } from '../format';
import { useStore } from '../state/StoreProvider';
import { Badge, Panel, SelectField, TextAreaField, TextField } from './ui';
import { Dialog } from './Dialog';

function errorMessage(error: unknown): string {
  if (error instanceof AiError) return error.message;
  if (isDomainError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Existing project content is unchanged.';
}

function newAngleId(index: number): string {
  return `ang_${Date.now().toString(36)}_${index}`;
}

function claimToProposal(claim: AiClaim, index: number): AiClaim {
  return { ...claim, id: `clm_${index + 1}` };
}

function ClaimSourceEditor({
  idPrefix,
  sources,
  onAttach,
}: {
  idPrefix: string;
  sources: AiSourceInput[];
  onAttach: (sourceId: string, excerpt: string) => void;
}) {
  const options = claimSourceOptions(sources);
  const [sourceId, setSourceId] = useState(options[0]?.id ?? '');
  const [excerpt, setExcerpt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const selected = options.find((source) => source.id === sourceId) ?? options[0];
  if (!selected) {
    return (
      <p className="muted-small">
        Add a pasted source excerpt in Source notes to source this claim directly.
      </p>
    );
  }
  return (
    <details className="ai-claim-source">
      <summary>Attach a source excerpt</summary>
      <div className="stack">
        <SelectField
          id={`${idPrefix}-source`}
          label="Source"
          value={selected.id}
          onChange={(event) => {
            setSourceId(event.target.value);
            setExcerpt('');
            setError(null);
          }}
        >
          {options.map((source) => (
            <option key={source.id} value={source.id}>
              {source.title.trim() || source.id}
            </option>
          ))}
        </SelectField>
        <TextAreaField
          id={`${idPrefix}-excerpt`}
          label="Verbatim excerpt"
          rows={3}
          value={excerpt}
          onChange={(event) => setExcerpt(event.target.value)}
        />
        <div className="row">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setExcerpt(selected.excerpt);
              setError(null);
            }}
          >
            Use full source excerpt
          </button>
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={() => {
              try {
                onAttach(selected.id, excerpt);
                setExcerpt('');
                setError(null);
              } catch (attachError) {
                setError(errorMessage(attachError));
              }
            }}
          >
            Attach excerpt
          </button>
        </div>
        {error ? (
          <p className="notice notice-warn" role="alert">
            {error}
          </p>
        ) : null}
        <p className="muted-small">
          The excerpt must be copied exactly from the pasted source. A match shows the source
          contains that text; it does not prove the claim is true.
        </p>
      </div>
    </details>
  );
}

function AuthRequired({ children }: { children: ReactNode }) {
  const { user, isLoading } = useFreebuffUser();
  if (isLoading) {
    return (
      <Panel title="AI planning">
        <p className="muted-small">Checking sign-in…</p>
      </Panel>
    );
  }
  if (!user) {
    return (
      <Panel
        title="AI planning"
        description="AI proposals require a Freebuff account. Generation runs on the app server; your provider credentials never reach this browser."
      >
        <p className="muted-small">
          Sign in to generate three angles, script proposals, and storyboard proposals. Manual
          editing, rendering, and media work without an account.
        </p>
        <div className="row">
          <SignInWithFreebuff returnTo={`${window.location.pathname}${window.location.search}${window.location.hash}`}>
            Sign in to use AI planning
          </SignInWithFreebuff>
        </div>
      </Panel>
    );
  }
  return <>{children}</>;
}

function useAiRequest() {
  const [pending, setPending] = useState<'angles' | 'script' | 'storyboard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      sequenceRef.current += 1;
    },
    [],
  );

  const begin = (operation: 'angles' | 'script' | 'storyboard') => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    setPending(operation);
    setError(null);
    return { controller, sequence };
  };

  const isCurrent = (sequence: number) => sequence === sequenceRef.current;

  const finish = (sequence: number) => {
    if (sequence === sequenceRef.current) setPending(null);
  };

  const cancel = () => {
    abortRef.current?.abort();
    sequenceRef.current += 1;
    setPending(null);
    setError(null);
  };

  return { pending, error, setError, begin, isCurrent, finish, cancel };
}

export function AiScriptPlanner({ project }: { project: Project }) {
  return (
    <AuthRequired>
      <ScriptPlanner project={project} />
    </AuthRequired>
  );
}

function ScriptPlanner({ project }: { project: Project }) {
  const store = useStore();
  const { proposals, storageError, commit } = useProposalStore(project.id);
  const request = useAiRequest();
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [model, setModel] = useState<AiModelId>(DEFAULT_AI_MODEL);

  const anglesProposal = proposals.angles;
  const scriptProposal = proposals.script;
  const angleFingerprint = angleInputFingerprint(project, anglesProposal?.model ?? model);
  const selectedAngle =
    anglesProposal?.angles.find((angle) => angle.id === anglesProposal.selectedAngleId) ?? null;
  const anglesStale =
    anglesProposal !== null && anglesProposal.inputFingerprint !== angleFingerprint;
  const anglesDistinct =
    anglesProposal === null ||
    new Set(
      anglesProposal.angles.map(
        (angle) => `${angle.title.trim().toLowerCase()}\n${angle.approach.trim().toLowerCase()}`,
      ),
    ).size === 3;
  const scriptFingerprint =
    scriptProposal !== null
      ? scriptInputFingerprint(project, scriptProposal.angle, scriptProposal.model)
      : null;
  const selectedAngleStillMatches =
    selectedAngle !== null &&
    scriptProposal !== null &&
    scriptProposal.angleId === selectedAngle.id &&
    scriptProposal.angle.title === selectedAngle.title &&
    scriptProposal.angle.hook === selectedAngle.hook &&
    scriptProposal.angle.approach === selectedAngle.approach &&
    scriptProposal.angle.explanation === selectedAngle.explanation;
  const scriptStale =
    scriptProposal !== null &&
    (scriptProposal.inputFingerprint !== scriptFingerprint || !selectedAngleStillMatches);
  const proposalNarration =
    scriptProposal !== null ? scriptNarration(scriptProposal.segments) : '';
  const unresolved = scriptProposal !== null ? unresolvedClaims(scriptProposal.segments) : [];
  const unreviewedSegments =
    scriptProposal?.mode === 'script' && project.brief.mode === 'factual'
      ? scriptProposal.segments.filter((segment) => segment.review === null)
      : [];
  const factualSourceCount = project.sourceNotes.filter((note) => note.excerpt.trim() !== '').length;

  const persist = (next: AngleProposal | null, script: ScriptProposal | null) => {
    commit({
      ...proposals,
      updatedAt: new Date().toISOString(),
      angles: next,
      script,
    });
  };

  const updateAngles = (mutator: (proposal: AngleProposal) => AngleProposal) => {
    if (!anglesProposal) return;
    commit({
      ...proposals,
      updatedAt: new Date().toISOString(),
      angles: { ...mutator(anglesProposal), editedAt: new Date().toISOString() },
    });
  };

  const updateScript = (mutator: (proposal: ScriptProposal) => ScriptProposal) => {
    if (!scriptProposal) return;
    commit({
      ...proposals,
      updatedAt: new Date().toISOString(),
      script: {
        ...mutator(scriptProposal),
        status: 'draft',
        editedAt: new Date().toISOString(),
      },
    });
  };

  const generateAngles = async () => {
    setConfirmRegenerate(false);
    setNotice(null);
    const validation = validateBrief(project.brief);
    if (!validation.ok) {
      request.setError('Complete the required brief fields before generating angles.');
      return;
    }
    const context = request.begin('angles');
    try {
      const result = await requestAngles(project, model, context.controller.signal);
      if (!request.isCurrent(context.sequence)) return;
      const generated: AngleProposal = {
        status: 'draft',
        model,
        inputFingerprint: result.inputFingerprint,
        angles: result.angles.map((angle, index) => ({ ...angle, id: newAngleId(index) })),
        selectedAngleId: null,
        generatedAt: new Date().toISOString(),
        editedAt: null,
      };
      persist(generated, null);
      setNotice('Three angles generated. Selecting one does not change the script.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (request.isCurrent(context.sequence)) request.setError(errorMessage(error));
    } finally {
      request.finish(context.sequence);
    }
  };

  const generateScript = async () => {
    if (!selectedAngle) {
      request.setError('Select one of the three angles before generating a script.');
      return;
    }
    if (anglesStale) {
      request.setError('The brief or source notes changed after these angles were generated. Regenerate the angles first.');
      return;
    }
    if (!anglesDistinct) {
      request.setError('Keep the three directions distinct before generating a script.');
      return;
    }
    if (project.brief.mode === 'factual' && factualSourceCount === 0) {
      request.setError('Add at least one pasted source excerpt before generating a factual script. A URL alone is not source content.');
      return;
    }
    const angleSnapshot: AiAngleSnapshot = {
      title: selectedAngle.title,
      hook: selectedAngle.hook,
      approach: selectedAngle.approach,
      explanation: selectedAngle.explanation,
    };
    const context = request.begin('script');
    setNotice(null);
    try {
      const result = await requestScript(
        project,
        angleSnapshot,
        model,
        context.controller.signal,
      );
      if (!request.isCurrent(context.sequence)) return;
      const proposal: ScriptProposal = {
        status: 'draft',
        mode: result.script.mode,
        model,
        inputFingerprint: result.inputFingerprint,
        angle: angleSnapshot,
        angleId: selectedAngle.id,
        segments: result.script.segments.map((segment, segmentIndex) => ({
          id: `seg_${segmentIndex + 1}`,
          kind: segment.kind,
          text: segment.text,
          claims: segment.claims.map(claimToProposal),
          review: segment.claims.length > 0 ? 'claims' : null,
        })),
        outline: result.script.outline,
        missingInformation: result.script.missingInformation,
        warnings: result.script.warnings,
        generatedAt: new Date().toISOString(),
        editedAt: null,
      };
      commit({
        ...proposals,
        updatedAt: new Date().toISOString(),
        script: proposal,
      });
      setNotice(
        proposal.mode === 'outline'
          ? 'The provider found insufficient evidence, so it returned a planning outline. It was not accepted as narration.'
          : 'Script proposal generated. Review it before replacing the current narration.',
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (request.isCurrent(context.sequence)) request.setError(errorMessage(error));
    } finally {
      request.finish(context.sequence);
    }
  };

  const acceptScript = () => {
    if (!scriptProposal || scriptProposal.mode !== 'script') return;
    if (scriptStale) {
      setAcceptOpen(false);
      request.setError('This script proposal is stale. Regenerate it before accepting.');
      return;
    }
    if (unresolved.length > 0 || unreviewedSegments.length > 0) {
      setAcceptOpen(false);
      request.setError('Resolve claim and factual-segment reviews before accepting.');
      return;
    }
    if (project.script.locked) {
      setAcceptOpen(false);
      request.setError('The script is locked. Unlock it before accepting a replacement.');
      return;
    }
    setAcceptOpen(false);
    const narration = scriptNarration(scriptProposal.segments);
    const result = store.mutate((current) =>
      replaceScriptNarration(current, narration, { archivePrevious: true }),
    );
    if (!result.ok) {
      request.setError(result.message ?? 'The script was not replaced.');
      return;
    }
    commit({
      ...proposals,
      updatedAt: new Date().toISOString(),
      script: { ...scriptProposal, status: 'accepted', editedAt: new Date().toISOString() },
    });
    setNotice(
      'Script accepted. The previous narration is in script history. Uploaded narration audio is unchanged; replace it in Export if needed. The storyboard review is now stale until reviewed.',
    );
  };

  const saveOutlineNote = () => {
    if (!scriptProposal || scriptProposal.mode !== 'outline') return;
    const body = [
      `Angle: ${scriptProposal.angle.title}`,
      '',
      ...scriptProposal.outline.map((item, index) => `${index + 1}. ${item}`),
      '',
      'Missing information:',
      ...scriptProposal.missingInformation.map((item) => `- ${item}`),
    ].join('\n');
    const result = store.mutate((current) =>
      addPlanningNote(current, {
        title: `Outline: ${scriptProposal.angle.title}`,
        body,
        inputFingerprint: scriptProposal.inputFingerprint,
      }),
    );
    if (!result.ok) {
      request.setError(result.message ?? 'The outline note was not saved.');
      return;
    }
    setNotice('Outline saved as a planning note. It is not narration and was not accepted as a script.');
  };

  const claimResolution = (segmentId: string, claimId: string, resolution: 'speculation' | null) => {
    updateScript((proposal) => ({
      ...proposal,
      segments: proposal.segments.map((segment) =>
        segment.id === segmentId
          ? {
              ...segment,
              claims: segment.claims.map((claim) =>
                claim.id === claimId ? { ...claim, resolution } : claim,
              ),
            }
          : segment,
      ),
    }));
  };

  const removeClaim = (segmentId: string, claimId: string) => {
    updateScript((proposal) => ({
      ...proposal,
      segments: proposal.segments.map((segment) =>
        segment.id === segmentId
          ? { ...segment, claims: segment.claims.filter((claim) => claim.id !== claimId) }
          : segment,
      ),
    }));
  };

  const attachSource = (
    segmentId: string,
    claimId: string,
    sourceId: string,
    excerpt: string,
  ) => {
    updateScript((proposal) => ({
      ...proposal,
      segments: proposal.segments.map((segment) =>
        segment.id === segmentId
          ? {
              ...segment,
              claims: segment.claims.map((claim) =>
                claim.id === claimId
                  ? attachClaimSource(claim, project.sourceNotes, sourceId, excerpt)
                  : claim,
              ),
            }
          : segment,
      ),
    }));
  };

  const detachSource = (segmentId: string, claimId: string, sourceId: string) => {
    updateScript((proposal) => ({
      ...proposal,
      segments: proposal.segments.map((segment) =>
        segment.id === segmentId
          ? {
              ...segment,
              claims: segment.claims.map((claim) =>
                claim.id === claimId ? removeClaimSource(claim, sourceId) : claim,
              ),
            }
          : segment,
      ),
    }));
  };

  return (
    <Panel
      title="AI planning"
      description="Brief → three angles → a script proposal you review and explicitly accept. Proposals are stored separately from project content and sent only to the app's server-side provider route."
      actions={
        <>
          {anglesProposal ? (
            <button
              type="button"
              className="btn btn-small"
              disabled={request.pending !== null}
              onClick={() => setConfirmRegenerate(true)}
            >
              Regenerate angles
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={request.pending !== null}
              onClick={() => void generateAngles()}
            >
              Generate three angles
            </button>
          )}
        </>
      }
    >
      {storageError ? (
        <p className="notice notice-warn" role="alert">
          {storageError}
        </p>
      ) : null}
      {request.error ? (
        <p className="notice" role="alert">
          {request.error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice notice-ok" role="status">
          {notice}
        </p>
      ) : null}
      {request.pending ? (
        <div className="row ai-pending" role="status">
          <span>Generating {request.pending}…</span>
          <button type="button" className="btn btn-small" onClick={request.cancel}>
            Cancel request
          </button>
        </div>
      ) : null}

      <div className="row ai-model-row">
        <SelectField
          id={`ai-model-script-${project.id}`}
          label="Ollama Cloud model"
          value={model}
          onChange={(event) => setModel(event.target.value as AiModelId)}
        >
          {AI_MODELS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <span className="muted-small">
          Requests run server-side through Ollama Cloud. The provider key never reaches this
          browser.
        </span>
      </div>

      {!anglesProposal ? (
        <p className="muted-small">
          The brief is the creative input. Generate exactly three directions; none of them changes
          the saved script until you generate and accept a script proposal.
        </p>
      ) : (
        <div className="stack">
          <div className="row">
            <Badge tone={anglesStale ? 'warn' : 'accent'}>
              {anglesStale ? 'Stale angles' : 'Angles current'}
            </Badge>
            <Badge>{anglesProposal.angles.length} directions</Badge>
            {!anglesDistinct ? <Badge tone="warn">Directions are not distinct</Badge> : null}
            <button
              type="button"
              className="btn btn-small btn-danger"
              onClick={() => persist(null, scriptProposal)}
            >
              Discard angles
            </button>
          </div>
          {anglesStale ? (
            <p className="notice notice-warn">
              The brief, source notes, or story notes changed after these angles were generated.
              Regenerate before using them for a new script proposal. Selection never edits the
              project script.
            </p>
          ) : null}
          {!anglesDistinct ? (
            <p className="notice notice-warn">
              The three edited directions must remain distinct. Restore distinct titles and
              approaches, or regenerate the angles.
            </p>
          ) : null}
          <div className="ai-angle-grid">
            {anglesProposal.angles.map((angle, index) => (
              <div
                key={angle.id}
                className={
                  anglesProposal.selectedAngleId === angle.id
                    ? 'ai-angle-card is-selected'
                    : 'ai-angle-card'
                }
              >
                <div className="row ai-angle-head">
                  <span className="ai-step">Angle {index + 1}</span>
                  <label className="ai-select-angle">
                    <input
                      type="radio"
                      name={`angle-${project.id}`}
                      checked={anglesProposal.selectedAngleId === angle.id}
                      onChange={() =>
                        updateAngles((proposal) => ({ ...proposal, selectedAngleId: angle.id }))
                      }
                    />
                    Select
                  </label>
                </div>
                <TextField
                  id={`angle-title-${angle.id}`}
                  label="Title"
                  value={angle.title}
                  onChange={(event) =>
                    updateAngles((proposal) => ({
                      ...proposal,
                      angles: proposal.angles.map((candidate) =>
                        candidate.id === angle.id
                          ? { ...candidate, title: event.target.value }
                          : candidate,
                      ),
                    }))
                  }
                />
                <TextAreaField
                  id={`angle-hook-${angle.id}`}
                  label="Hook"
                  rows={2}
                  value={angle.hook}
                  onChange={(event) =>
                    updateAngles((proposal) => ({
                      ...proposal,
                      angles: proposal.angles.map((candidate) =>
                        candidate.id === angle.id
                          ? { ...candidate, hook: event.target.value }
                          : candidate,
                      ),
                    }))
                  }
                />
                <TextAreaField
                  id={`angle-approach-${angle.id}`}
                  label="Narrative approach"
                  rows={2}
                  value={angle.approach}
                  onChange={(event) =>
                    updateAngles((proposal) => ({
                      ...proposal,
                      angles: proposal.angles.map((candidate) =>
                        candidate.id === angle.id
                          ? { ...candidate, approach: event.target.value }
                          : candidate,
                      ),
                    }))
                  }
                />
                <TextAreaField
                  id={`angle-explanation-${angle.id}`}
                  label="Why this direction"
                  rows={2}
                  value={angle.explanation}
                  onChange={(event) =>
                    updateAngles((proposal) => ({
                      ...proposal,
                      angles: proposal.angles.map((candidate) =>
                        candidate.id === angle.id
                          ? { ...candidate, explanation: event.target.value }
                          : candidate,
                      ),
                    }))
                  }
                />
              </div>
            ))}
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                !selectedAngle || anglesStale || !anglesDistinct || request.pending !== null
              }
              onClick={() => void generateScript()}
            >
              Generate script proposal
            </button>
            {project.brief.mode === 'factual' && factualSourceCount === 0 ? (
              <span className="muted-small">
                Add a pasted source excerpt in Source notes first.
              </span>
            ) : null}
          </div>
        </div>
      )}

      {scriptProposal ? (
        <div className="ai-proposal">
          <div className="row">
            <h3 className="ai-proposal-title">Script proposal</h3>
            <Badge tone={scriptProposal.status === 'accepted' ? 'ok' : 'neutral'}>
              {scriptProposal.status === 'accepted' ? 'Accepted' : 'Not accepted'}
            </Badge>
            <Badge>{scriptProposal.mode === 'outline' ? 'Planning outline' : 'Narration'}</Badge>
            {scriptStale ? <Badge tone="warn">Stale</Badge> : <Badge tone="accent">Current input</Badge>}
          </div>
          {scriptStale ? (
            <p className="notice notice-warn">
              The brief, source notes, story notes, or selected angle changed after this proposal
              was generated. It cannot be accepted. Regenerate it from the current inputs.
            </p>
          ) : null}
          {scriptProposal.warnings.length > 0 ? (
            <ul className="plain-list">
              {scriptProposal.warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          ) : null}

          {scriptProposal.mode === 'outline' ? (
            <div className="stack">
              <p className="notice notice-warn">
                Evidence was insufficient, so this is an outline and missing-information list, not
                final narration. It cannot be accepted into the script.
              </p>
              <div>
                <h4>Outline</h4>
                <ol className="step-list">
                  {scriptProposal.outline.map((item, index) => (
                    <li key={`${index}-${item}`}>{item}</li>
                  ))}
                </ol>
              </div>
              <div>
                <h4>Missing information</h4>
                <ul className="plain-list">
                  {scriptProposal.missingInformation.map((item, index) => (
                    <li key={`${index}-${item}`}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="row">
                <button type="button" className="btn" onClick={saveOutlineNote}>
                  Save outline as planning note
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => persist(anglesProposal, null)}
                >
                  Discard proposal
                </button>
              </div>
            </div>
          ) : (
            <div className="stack">
              <p className="muted-small">
                Angle: <strong>{scriptProposal.angle.title}</strong>. Editing segment text does not
                re-run source validation; claims still refer to the generated text.
              </p>
              {project.brief.mode === 'factual' ? (
                <p className="notice notice-info">
                  Claims are checked in the hook, body, and ending. A matching pasted excerpt shows
                  only that the supplied text contains it; it does not prove the claim is true or
                  that the source entails it. Sources are user-provided and unverified.
                </p>
              ) : (
                <p className="muted-small">
                  Fiction mode uses the audience, tone, characters, setting, and continuity notes.
                  It must not invent factual citations, and this proposal contains none.
                </p>
              )}
              {scriptProposal.segments.map((segment, index) => (
                <div key={segment.id} className="ai-segment">
                  <div className="row">
                    <Badge>{segment.kind}</Badge>
                    <span className="muted-small">Segment {index + 1}</span>
                  </div>
                  <TextAreaField
                    id={`script-segment-${segment.id}`}
                    label={`${segment.kind} text`}
                    rows={4}
                    value={segment.text}
                    onChange={(event) =>
                      updateScript((proposal) => ({
                        ...proposal,
                        segments: proposal.segments.map((candidate) =>
                          candidate.id === segment.id
                            ? {
                                ...candidate,
                                text: event.target.value,
                                review: candidate.claims.length > 0 ? 'claims' : null,
                              }
                            : candidate,
                        ),
                      }))
                    }
                  />
                  {segment.claims.length > 0 ? (
                    <div className="stack ai-claims">
                      {segment.claims.map((claim) => (
                        <div key={claim.id} className="ai-claim">
                          <div className="row">
                            <Badge
                              tone={
                                claim.status === 'supported'
                                  ? 'ok'
                                  : claim.status === 'conflicting'
                                    ? 'danger'
                                    : 'warn'
                              }
                            >
                              {claim.status}
                            </Badge>
                            <span className="ai-claim-text">{claim.text}</span>
                          </div>
                          {claim.sourceIds.length > 0 ? (
                            <p className="muted-small">Source IDs: {claim.sourceIds.join(', ')}</p>
                          ) : null}
                          {claim.excerpts.map((excerpt) => (
                            <blockquote key={`${claim.id}-${excerpt.sourceId}-${excerpt.excerpt}`}>
                              {excerpt.excerpt}
                              <footer>
                                Source: {excerpt.sourceId}{' '}
                                <button
                                  type="button"
                                  className="btn btn-small"
                                  onClick={() =>
                                    detachSource(segment.id, claim.id, excerpt.sourceId)
                                  }
                                >
                                  Remove source
                                </button>
                              </footer>
                            </blockquote>
                          ))}
                          {claim.note ? <p className="muted-small">{claim.note}</p> : null}
                          {claim.status !== 'supported' ? (
                            <div className="row">
                              {claim.resolution !== 'speculation' ? (
                                <button
                                  type="button"
                                  className="btn btn-small"
                                  onClick={() =>
                                    claimResolution(segment.id, claim.id, 'speculation')
                                  }
                                >
                                  Frame as speculation
                                </button>
                              ) : (
                                <>
                                  <Badge tone="warn">Framed as speculation</Badge>
                                  <button
                                    type="button"
                                    className="btn btn-small"
                                    onClick={() => claimResolution(segment.id, claim.id, null)}
                                  >
                                    Undo
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                className="btn btn-small btn-danger"
                                onClick={() => removeClaim(segment.id, claim.id)}
                              >
                                Remove claim
                              </button>
                            </div>
                          ) : null}
                          {project.brief.mode === 'factual' ? (
                            <ClaimSourceEditor
                              idPrefix={`claim-source-${segment.id}-${claim.id}`}
                              sources={project.sourceNotes}
                              onAttach={(sourceId, excerpt) =>
                                attachSource(segment.id, claim.id, sourceId, excerpt)
                              }
                            />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : project.brief.mode === 'factual' ? (
                    <div className="stack ai-claims">
                      <p className="muted-small">
                        No claims are annotated in this {segment.kind}. Factual assertions in hooks
                        and endings still need support.
                      </p>
                      {segment.review === null ? (
                        <div className="row">
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={() =>
                              updateScript((proposal) => ({
                                ...proposal,
                                segments: proposal.segments.map((candidate) =>
                                  candidate.id === segment.id
                                    ? { ...candidate, review: 'no-assertion' }
                                    : candidate,
                                ),
                              }))
                            }
                          >
                            No factual assertion here
                          </button>
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={() =>
                              updateScript((proposal) => ({
                                ...proposal,
                                segments: proposal.segments.map((candidate) =>
                                  candidate.id === segment.id
                                    ? { ...candidate, review: 'speculation' }
                                    : candidate,
                                ),
                              }))
                            }
                          >
                            Frame this segment as speculation
                          </button>
                        </div>
                      ) : (
                        <div className="row">
                          <Badge tone="warn">
                            {segment.review === 'no-assertion'
                              ? 'Reviewed: no factual assertion'
                              : 'Reviewed: framed as speculation'}
                          </Badge>
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={() =>
                              updateScript((proposal) => ({
                                ...proposal,
                                segments: proposal.segments.map((candidate) =>
                                  candidate.id === segment.id
                                    ? { ...candidate, review: null }
                                    : candidate,
                                ),
                              }))
                            }
                          >
                            Undo review
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
              {unresolved.length > 0 ? (
                <p className="notice notice-warn" role="alert">
                  {unresolved.length} claim{unresolved.length === 1 ? '' : 's'} still need to be
                  edited, sourced, removed, or explicitly framed as speculation before acceptance.
                </p>
              ) : null}
              {unreviewedSegments.length > 0 ? (
                <p className="notice notice-warn" role="alert">
                  {unreviewedSegments.length} factual segment
                  {unreviewedSegments.length === 1 ? '' : 's'} has no claims annotation. Review it
                  and mark it as having no factual assertion, or frame it as speculation.
                </p>
              ) : null}
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    scriptStale ||
                    scriptProposal.status === 'accepted' ||
                    unresolved.length > 0 ||
                    unreviewedSegments.length > 0 ||
                    proposalNarration.trim() === '' ||
                    project.script.locked
                  }
                  onClick={() => setAcceptOpen(true)}
                >
                  Accept script proposal
                </button>
                {project.script.locked ? (
                  <span className="muted-small">Unlock the script before accepting a replacement.</span>
                ) : null}
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => persist(anglesProposal, null)}
                >
                  Discard proposal
                </button>
              </div>
              <p className="muted-small">
                Accepting replaces the saved narration and archives the current narration in
                bounded script history. Uploaded narration audio is not regenerated or replaced
                automatically, and the storyboard review becomes stale.
              </p>
            </div>
          )}
        </div>
      ) : null}

      {project.planningNotes.length > 0 ? (
        <div className="ai-notes">
          <h3 className="ai-proposal-title">Planning notes</h3>
          <p className="muted-small">
            Planning notes are context only. They are never used as narration or rendered.
          </p>
          {project.planningNotes.map((note) => (
            <details key={note.id} className="ai-note">
              <summary>
                {note.title} · {formatTimestamp(note.createdAt)}
              </summary>
              <pre>{note.body}</pre>
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() =>
                  store.mutate((current) => removePlanningNote(current, note.id))
                }
              >
                Remove note
              </button>
            </details>
          ))}
        </div>
      ) : null}

      {confirmRegenerate ? (
        <Dialog
          title="Regenerate the three angles?"
          description="New angles replace the current angle proposal and clear any script proposal generated from it. The saved project script is not changed."
          onDismiss={() => setConfirmRegenerate(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setConfirmRegenerate(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void generateAngles()}>
                Regenerate angles
              </button>
            </>
          }
        />
      ) : null}

      {acceptOpen && scriptProposal ? (
        <Dialog
          title="Accept this script proposal?"
          description="This replaces the project narration. The current narration is archived as a recoverable version, not deleted."
          onDismiss={() => setAcceptOpen(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setAcceptOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={acceptScript}>
                Replace narration
              </button>
            </>
          }
        >
          <div className="ai-compare">
            <div>
              <h4>Current narration</h4>
              <pre>{project.script.narration.trim() || '(empty)'}</pre>
            </div>
            <div>
              <h4>Proposed narration</h4>
              <pre>{proposalNarration}</pre>
            </div>
          </div>
          <p className="notice notice-warn">
            Uploaded narration audio will not update automatically. The previous storyboard and its
            media stay in the project, but the storyboard review becomes stale when the script
            changes.
          </p>
        </Dialog>
      ) : null}
    </Panel>
  );
}

export function AiStoryboardPlanner({ project }: { project: Project }) {
  return (
    <AuthRequired>
      <StoryboardPlanner project={project} />
    </AuthRequired>
  );
}

function StoryboardPlanner({ project }: { project: Project }) {
  const store = useStore();
  const { proposals, storageError, commit } = useProposalStore(project.id);
  const request = useAiRequest();
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [model, setModel] = useState<AiModelId>(DEFAULT_AI_MODEL);
  const proposal = proposals.storyboard;
  const currentFingerprint = storyboardInputFingerprint(project, proposal?.model ?? model);
  const stale = proposal !== null && proposal.inputFingerprint !== currentFingerprint;
  const lockedScenes = project.storyboard.scenes.filter((scene) =>
    Object.values(scene.locks).some(Boolean),
  );
  const warnings = proposal
    ? [...new Set([...proposal.warnings, ...pacingWarnings(proposal.scenes, project.brief.targetDuration)])]
    : [];

  const updateProposal = (mutator: (value: StoryboardProposal) => StoryboardProposal) => {
    if (!proposal) return;
    commit({
      ...proposals,
      updatedAt: new Date().toISOString(),
      storyboard: { ...mutator(proposal), editedAt: new Date().toISOString() },
    });
  };

  const updateScene = (
    sceneId: string,
    patch: Partial<StoryboardProposalScene>,
  ) => {
    updateProposal((value) => ({
      ...value,
      scenes: value.scenes.map((scene) =>
        scene.id === sceneId ? { ...scene, ...patch } : scene,
      ),
    }));
  };

  const generate = async () => {
    if (project.script.narration.trim() === '') {
      request.setError('Write and save a script first. A storyboard is generated only from the saved script.');
      return;
    }
    const saved = await store.flush();
    if (!saved.ok) {
      request.setError(
        saved.message ??
          'The script could not be saved, so a storyboard was not generated. Resolve the save problem first.',
      );
      return;
    }
    const savedProject = store.getActiveProject();
    if (!savedProject || savedProject.id !== project.id) {
      request.setError('The project changed before generation. Reopen it and try again.');
      return;
    }
    if (savedProject.script.narration.trim() === '') {
      request.setError('There is no saved script yet. Write one before generating a storyboard.');
      return;
    }
    const context = request.begin('storyboard');
    setNotice(null);
    try {
      const result = await requestStoryboard(
        savedProject,
        model,
        context.controller.signal,
      );
      if (!request.isCurrent(context.sequence)) return;
      const generated: StoryboardProposal = {
        status: 'draft',
        model,
        inputFingerprint: result.inputFingerprint,
        scriptFingerprint: savedProject.script.fingerprint,
        scenes: result.storyboard.scenes.map((scene, index) => ({
          ...scene,
          id: `sb_${index + 1}`,
        })),
        warnings: result.storyboard.warnings,
        generatedAt: new Date().toISOString(),
        editedAt: null,
      };
      commit({
        ...proposals,
        updatedAt: new Date().toISOString(),
        storyboard: generated,
      });
      setNotice('Storyboard proposal generated from the saved script. Review scene narration and pacing before accepting.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (request.isCurrent(context.sequence)) request.setError(errorMessage(error));
    } finally {
      request.finish(context.sequence);
    }
  };

  const accept = () => {
    if (!proposal) return;
    let parsed;
    try {
      parsed = parseStoryboardTokens(
        { scenes: proposal.scenes, warnings: proposal.warnings },
        project.script.narration,
      );
    } catch (error) {
      setAcceptOpen(false);
      request.setError(errorMessage(error));
      return;
    }
    setAcceptOpen(false);
    const result = store.mutate((current) =>
      acceptStoryboardDraft(current, parsed.scenes, {
        expectedScriptFingerprint: project.script.fingerprint,
      }),
    );
    if (!result.ok) {
      request.setError(result.message ?? 'The storyboard was not replaced.');
      return;
    }
    commit({
      ...proposals,
      updatedAt: new Date().toISOString(),
      storyboard: { ...proposal, status: 'accepted', editedAt: new Date().toISOString() },
    });
    setNotice(
      'Storyboard accepted. The previous storyboard is recoverable and its attached media was not deleted. Locks were not bypassed.',
    );
  };

  const restore = () => {
    setRestoreOpen(false);
    const result = store.mutate((current) => restorePreviousStoryboard(current));
    if (!result.ok) {
      request.setError(result.message ?? 'The previous storyboard was not restored.');
      return;
    }
    setNotice('Previous storyboard restored. The board it replaced is now the recoverable previous board.');
  };

  return (
    <Panel
      title="AI storyboard proposal"
      description="Generate only from the saved script. Scene narration must reconstruct the script in order; only whitespace may differ."
      actions={
        proposal ? (
          <button
            type="button"
            className="btn btn-small"
            disabled={request.pending !== null}
            onClick={() => void generate()}
          >
            Regenerate storyboard
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={request.pending !== null || project.script.narration.trim() === ''}
            onClick={() => void generate()}
          >
            Generate storyboard proposal
          </button>
        )
      }
    >
      {storageError ? (
        <p className="notice notice-warn" role="alert">
          {storageError}
        </p>
      ) : null}
      {request.error ? (
        <p className="notice" role="alert">
          {request.error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice notice-ok" role="status">
          {notice}
        </p>
      ) : null}
      {request.pending ? (
        <div className="row ai-pending" role="status">
          <span>Generating storyboard…</span>
          <button type="button" className="btn btn-small" onClick={request.cancel}>
            Cancel request
          </button>
        </div>
      ) : null}

      <div className="row ai-model-row">
        <SelectField
          id={`ai-model-storyboard-${project.id}`}
          label="Ollama Cloud model"
          value={model}
          onChange={(event) => setModel(event.target.value as AiModelId)}
        >
          {AI_MODELS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <span className="muted-small">
          Requests run server-side through Ollama Cloud. The provider key never reaches this
          browser.
        </span>
      </div>

      {project.script.narration.trim() === '' ? (
        <p className="muted-small">There is no saved script yet. Write one before generating a storyboard.</p>
      ) : null}

      {proposal ? (
        <div className="ai-proposal">
          <div className="row">
            <Badge tone={proposal.status === 'accepted' ? 'ok' : 'neutral'}>
              {proposal.status === 'accepted' ? 'Accepted' : 'Not accepted'}
            </Badge>
            <Badge>{proposal.scenes.length} scenes</Badge>
            <Badge>
              {formatDuration(
                proposal.scenes.reduce((total, scene) => total + scene.plannedDuration, 0),
              )}{' '}
              planned
            </Badge>
            {stale ? <Badge tone="warn">Stale</Badge> : <Badge tone="accent">Current script</Badge>}
          </div>
          {stale ? (
            <p className="notice notice-warn">
              The saved script changed after this proposal was generated. It cannot be accepted.
              Generate a fresh storyboard from the current script.
            </p>
          ) : null}
          {warnings.length > 0 ? (
            <ul className="plain-list" role="status">
              {warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <p className="muted-small">
            Scene IDs are created by the app on acceptance. The proposal cannot contain media IDs
            or stock URLs. Scene narration is checked against the exact saved script with only
            whitespace normalization.
          </p>
          <div className="stack">
            {proposal.scenes.map((scene, index) => (
              <div key={scene.id} className="ai-segment">
                <div className="row">
                  <Badge>Scene {index + 1}</Badge>
                  <span className="muted-small">{formatDuration(scene.plannedDuration)}</span>
                </div>
                <div className="form-grid">
                  <TextField
                    id={`sb-title-${scene.id}`}
                    label="Title"
                    value={scene.title}
                    onChange={(event) => updateScene(scene.id, { title: event.target.value })}
                  />
                  <TextField
                    id={`sb-duration-${scene.id}`}
                    label="Planned duration (seconds)"
                    type="number"
                    min={1}
                    max={600}
                    value={String(scene.plannedDuration)}
                    onChange={(event) =>
                      updateScene(scene.id, {
                        plannedDuration: Number(event.target.value),
                      })
                    }
                  />
                </div>
                <TextAreaField
                  id={`sb-narration-${scene.id}`}
                  label="Scene narration"
                  rows={4}
                  value={scene.narration}
                  onChange={(event) => updateScene(scene.id, { narration: event.target.value })}
                />
                <TextAreaField
                  id={`sb-visual-${scene.id}`}
                  label="Visual direction"
                  rows={2}
                  value={scene.visualDirection}
                  onChange={(event) =>
                    updateScene(scene.id, { visualDirection: event.target.value })
                  }
                />
                <div className="form-grid">
                  <SelectField
                    id={`sb-asset-${scene.id}`}
                    label="Suggested asset type"
                    value={scene.assetType}
                    onChange={(event) =>
                      updateScene(scene.id, { assetType: event.target.value as AssetType })
                    }
                  >
                    {ASSET_TYPES.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.label}
                      </option>
                    ))}
                  </SelectField>
                  <TextField
                    id={`sb-text-${scene.id}`}
                    label="On-screen text"
                    value={scene.onScreenText}
                    onChange={(event) => updateScene(scene.id, { onScreenText: event.target.value })}
                  />
                </div>
              </div>
            ))}
          </div>
          {lockedScenes.length > 0 ? (
            <p className="notice notice-warn" role="alert">
              {lockedScenes.length} current scene{lockedScenes.length === 1 ? '' : 's'} has locked
              components. Unlock all locked components before replacing the storyboard.
            </p>
          ) : null}
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                stale ||
                proposal.status === 'accepted' ||
                lockedScenes.length > 0 ||
                project.script.narration.trim() === ''
              }
              onClick={() => setAcceptOpen(true)}
            >
              Accept storyboard proposal
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() =>
                commit({
                  ...proposals,
                  updatedAt: new Date().toISOString(),
                  storyboard: null,
                })
              }
            >
              Discard proposal
            </button>
          </div>
          <p className="muted-small">
            Accepting preserves the current storyboard as a recoverable previous board. Detached
            media is not deleted. No scene locks are bypassed.
          </p>
        </div>
      ) : null}

      {project.storyboard.previous ? (
        <div className="ai-notes">
          <h3 className="ai-proposal-title">Previous storyboard</h3>
          <p className="muted-small">
            {project.storyboard.previous.scenes.length} scene
            {project.storyboard.previous.scenes.length === 1 ? '' : 's'} saved{' '}
            {formatTimestamp(project.storyboard.previous.savedAt)}. Restoring swaps it with the
            current board; attached media stays available.
          </p>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setRestoreOpen(true)}
            disabled={lockedScenes.length > 0}
          >
            Restore previous storyboard
          </button>
        </div>
      ) : null}

      {restoreOpen ? (
        <Dialog
          title="Restore the previous storyboard?"
          description="The current storyboard becomes the recoverable previous board. Attached media is not deleted, and locked components prevent this restore."
          onDismiss={() => setRestoreOpen(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setRestoreOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={restore}>
                Restore previous board
              </button>
            </>
          }
        />
      ) : null}

      {acceptOpen && proposal ? (
        <Dialog
          title="Accept this storyboard proposal?"
          description="This replaces every current scene with the proposal above. Scene IDs are created by the app."
          onDismiss={() => setAcceptOpen(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setAcceptOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={accept}>
                Replace storyboard
              </button>
            </>
          }
        >
          <p className="notice notice-warn">
            The current storyboard is kept as a recoverable previous board. Its attached images are
            not detached or deleted. The new board is marked reviewed against the current script
            because you explicitly accept it. Uploaded audio is unchanged.
          </p>
          <p className="muted-small">
            Reconstructed narration matches the saved script after whitespace normalization:{' '}
            {normalizeNarrationWhitespace(
              proposal.scenes.map((scene) => scene.narration).join(' '),
            ) === normalizeNarrationWhitespace(project.script.narration)
              ? 'yes'
              : 'no — acceptance will be refused.'}
          </p>
        </Dialog>
      ) : null}
    </Panel>
  );
}
