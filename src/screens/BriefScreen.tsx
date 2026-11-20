import { useState } from 'react';
import {
  Badge,
  Panel,
  SegmentedControl,
  SelectField,
  TextAreaField,
  TextField,
} from '../components/ui';
import { CURRENCIES, TARGET_DURATIONS, VISUAL_PRESETS } from '../domain/constants';
import { updateBrief } from '../domain/project';
import { validateBrief } from '../domain/staleness';
import type { Brief, Project, ProjectMode, TargetDuration } from '../domain/types';
import { routeToHash } from '../router';
import { useStore } from '../state/StoreProvider';

export function BriefScreen({ project }: { project: Project }) {
  const store = useStore();
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [budgetText, setBudgetText] = useState(
    project.brief.budget.amount === null ? '' : String(project.brief.budget.amount),
  );

  const validation = validateBrief(project.brief);
  const brief = project.brief;

  const update = (patch: Partial<Brief>) => {
    const result = store.mutate((current) => updateBrief(current, patch));
    setError(result.ok ? null : (result.message ?? 'That change was not applied.'));
  };

  const updateBudgetAmount = (value: string) => {
    setBudgetText(value);
    const parsed = value.trim() === '' ? null : Number(value);
    update({
      budget: {
        ...brief.budget,
        amount: parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
      },
    });
  };

  const handleContinue = () => {
    if (!validation.ok) {
      setShowErrors(true);
      return;
    }
    void store.flush();
    window.location.hash = routeToHash({ name: 'project', id: project.id, stage: 'script' });
  };

  return (
    <div className="stack">
      <header className="screen-head">
        <div>
          <h1>Brief</h1>
          <p className="screen-subtitle">
            What the video is about, who it is for, and how it should feel. These choices drive the
            rest of the workspace.
          </p>
        </div>
        <div className="row">
          <Badge tone="accent">{brief.mode === 'factual' ? 'Factual mode' : 'Fiction mode'}</Badge>
          <Badge>{brief.targetDuration}s target</Badge>
        </div>
      </header>

      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}

      <div className="brief-layout">
        <div className="stack">
          <Panel title="Core brief" description="Required fields are marked. Nothing here is generated.">
            <div className="form-grid">
              <div className="field-full">
                <TextAreaField
                  id="brief-topic"
                  label="Topic or starting material"
                  required
                  rows={4}
                  value={brief.topic}
                  onChange={(event) => update({ topic: event.target.value })}
                  placeholder="The subject, or paste the notes you are starting from."
                  error={showErrors ? validation.errors.topic : undefined}
                />
              </div>
              <TextField
                id="brief-audience"
                label="Intended audience"
                required
                value={brief.audience}
                onChange={(event) => update({ audience: event.target.value })}
                placeholder="Curious adults who watch short explainers"
                error={showErrors ? validation.errors.audience : undefined}
              />
              <TextField
                id="brief-goal"
                label="Goal"
                required
                value={brief.goal}
                onChange={(event) => update({ goal: event.target.value })}
                placeholder="What the viewer should take away"
                error={showErrors ? validation.errors.goal : undefined}
              />
              <TextField
                id="brief-tone"
                label="Tone"
                required
                value={brief.tone}
                onChange={(event) => update({ tone: event.target.value })}
                placeholder="Calm and curious, no hype"
                error={showErrors ? validation.errors.tone : undefined}
              />
              <div className="field-full">
                <SegmentedControl<ProjectMode>
                  legend="Mode"
                  name="brief-mode"
                  value={brief.mode}
                  options={[
                    { value: 'factual', label: 'Factual' },
                    { value: 'fiction', label: 'Fiction' },
                  ]}
                  onChange={(mode) => update({ mode })}
                  hint={
                    brief.mode === 'factual'
                      ? 'Factual mode adds source notes. Sources are user-provided and unverified.'
                      : 'Fiction mode adds story notes: characters, setting, and continuity.'
                  }
                />
              </div>
              <div className="field-full">
                <SegmentedControl<TargetDuration>
                  legend="Target duration"
                  name="brief-duration"
                  value={brief.targetDuration}
                  options={TARGET_DURATIONS.map((duration) => ({
                    value: duration,
                    label: `${duration}s`,
                  }))}
                  onChange={(targetDuration) => update({ targetDuration })}
                  hint="The storyboard warns when its planned total differs materially from this target."
                />
              </div>
              <fieldset className="field field-full">
                <legend>Visual preset</legend>
                <div className="preset-grid">
                  {VISUAL_PRESETS.map((preset) => (
                    <label
                      key={preset.id}
                      className={
                        brief.visualPreset === preset.id ? 'preset-card is-selected' : 'preset-card'
                      }
                    >
                      <input
                        type="radio"
                        name="brief-visual-preset"
                        value={preset.id}
                        checked={brief.visualPreset === preset.id}
                        onChange={() => update({ visualPreset: preset.id })}
                      />
                      <span className="preset-title">{preset.label}</span>
                      <span className="preset-description">{preset.description}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </Panel>

          <Panel
            title="Voice preference"
            description="Stored as configuration for a later phase. Narration generation is not connected in this milestone."
          >
            <div className="form-grid">
              <TextField
                id="brief-voice"
                label="Preferred voice"
                value={brief.voicePreference.label}
                onChange={(event) =>
                  update({
                    voicePreference: { ...brief.voicePreference, label: event.target.value },
                  })
                }
                placeholder="Warm narrator, mid pace"
              />
              <TextField
                id="brief-voice-notes"
                label="Voice notes"
                value={brief.voicePreference.notes}
                onChange={(event) =>
                  update({
                    voicePreference: { ...brief.voicePreference, notes: event.target.value },
                  })
                }
                placeholder="Anything a voice director should know"
              />
            </div>
            <p className="muted-small">
              Voice preference is only a note. Audio is not generated here; optional narration and
              music are uploaded in Export and stored in this browser.
            </p>
          </Panel>

          <Panel
            title="Planning budget"
            description="A note for yourself. There are no spending controls, usage tracking, or billing here, and nothing enforces this number."
          >
            <div className="form-grid">
              <TextField
                id="brief-budget-amount"
                label="Planning budget"
                inputMode="decimal"
                value={budgetText}
                onChange={(event) => updateBudgetAmount(event.target.value)}
                placeholder="0"
              />
              <SelectField
                id="brief-budget-currency"
                label="Currency"
                value={brief.budget.currency}
                onChange={(event) =>
                  update({ budget: { ...brief.budget, currency: event.target.value } })
                }
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </SelectField>
            </div>
            <p className="muted-small">
              Planning note only. No payment method is connected and no spending is possible.
            </p>
          </Panel>

          <div className="row panel-actions">
            <button type="button" className="btn btn-primary" onClick={handleContinue}>
              Continue to script
            </button>
            {showErrors && !validation.ok ? (
              <span className="field-error" role="alert">
                Complete the required brief fields to continue.
              </span>
            ) : null}
          </div>
        </div>

        <aside className="stack">
          <Panel title="Brief checklist">
            <ul className="checklist">
              <CheckItem label="Topic or starting material" done={brief.topic.trim() !== ''} />
              <CheckItem label="Intended audience" done={brief.audience.trim() !== ''} />
              <CheckItem label="Goal" done={brief.goal.trim() !== ''} />
              <CheckItem label="Tone" done={brief.tone.trim() !== ''} />
            </ul>
            <p className="muted-small">
              The brief autosaves to this browser as you type. Use the save status in the top bar to
              confirm.
            </p>
          </Panel>
          <Panel title="What happens next">
            <ol className="step-list">
              <li>Write one narration script.</li>
              <li>Lay the narration out as scenes.</li>
              <li>Lock the parts that are approved.</li>
              <li>Review the storyboard against the exact script.</li>
              <li>Preview placeholders. Export is not available yet.</li>
            </ol>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function CheckItem({ label, done }: { label: string; done: boolean }) {
  return (
    <li className={done ? 'check-item is-done' : 'check-item'}>
      <span className="check-dot" aria-hidden="true" />
      {label}
      <span className="visually-hidden">{done ? ' — complete' : ' — missing'}</span>
    </li>
  );
}
