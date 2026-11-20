import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SignInWithFreebuff, useFreebuffUser } from '@freebuff/auth/react';
import { Dialog } from './Dialog';
import { Badge, Panel, SelectField } from './ui';
import { newId } from '../domain/ids';
import { updateAudioTrack } from '../domain/project';
import type { NarrationTake, Project } from '../domain/types';
import { formatTimestamp } from '../format';
import { linkAudioAssetReplacement, storeGeneratedNarration } from '../media/audioAssets';
import { cleanupProjectMedia } from '../media/cleanup';
import { deleteAudioAsset, getAudioAsset } from '../media/mediaDb';
import type { AudioAssetRecord } from '../media/mediaDb';
import { generateNarration, getNarrationUsage } from '../narration/api';
import type { NarrationUsageView } from '../narration/api';
import {
  NARRATION_CAPABILITY_NOTES,
  NARRATION_MODEL,
  buildSampleText,
  estimateNarrationUsd,
  narrationVoiceLabel,
} from '../narration/provider';
import {
  compareNarrationToScenes,
  fitUnlockedSceneDurations,
  narrationStatus,
} from '../narration/plan';
import { useStore } from '../state/StoreProvider';

const PRICE_PERCENT = (NARRATION_MODEL.usdPerThousandCharacters * 100).toFixed(1);

function usd(value: number): string {
  return value >= 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(4)}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

function reasonMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

/**
 * Turns the saved script into real narration with one provider voice. The panel
 * never edits the script, never regenerates on its own, and never hides what a
 * generation may cost.
 */
export function NarrationPanel({ project }: { project: Project }) {
  return (
    <SignedIn>
      <NarrationBody project={project} />
    </SignedIn>
  );
}

function SignedIn({ children }: { children: ReactNode }) {
  const { user, isLoading } = useFreebuffUser();
  if (isLoading) {
    return (
      <Panel title="Narration audio">
        <p className="muted-small">Checking sign-in…</p>
      </Panel>
    );
  }
  if (!user) {
    return (
      <Panel
        title="Narration audio"
        description="Narration runs on the app server with the provider's own key. Sign in to generate; uploading your own audio needs no account."
      >
        <div className="row">
          <SignInWithFreebuff
            returnTo={`${window.location.pathname}${window.location.search}${window.location.hash}`}
          >
            Sign in to generate narration
          </SignInWithFreebuff>
        </div>
      </Panel>
    );
  }
  return <>{children}</>;
}

type PendingKind = 'sample' | 'generate' | 'fit';

function NarrationBody({ project }: { project: Project }) {
  const store = useStore();
  const track = project.audio.narration;
  const scriptText = project.script.narration;
  const take = track.generated ?? null;
  const status = narrationStatus(take, project.script.fingerprint);
  const [voice, setVoice] = useState(take?.voice ?? NARRATION_MODEL.defaultVoice);
  const [pending, setPending] = useState<PendingKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<NarrationUsageView | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<AudioAssetRecord | null>(null);
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const sampleRef = useRef<HTMLAudioElement>(null);
  const sampleUrlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current);
    },
    [],
  );

  // The take the current one replaced, which restore can swap back in.
  useEffect(() => {
    let active = true;
    setPrevious(null);
    const currentId = track.assetId;
    if (!currentId) return;
    void (async () => {
      try {
        const current = await getAudioAsset(currentId);
        const replacedId = current?.replacesAssetId ?? null;
        const kept = replacedId ? await getAudioAsset(replacedId) : undefined;
        if (active) setPrevious(kept ?? null);
      } catch {
        if (active) setPrevious(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [track.assetId]);

  const refreshUsage = async () => {
    try {
      setUsage(await getNarrationUsage());
      setUsageError(null);
    } catch (reason) {
      setUsageError(reasonMessage(reason, 'Usage could not be loaded.'));
    }
  };

  useEffect(() => {
    void refreshUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount
  }, []);

  const characters = scriptText.length;
  const estimatedUsd = estimateNarrationUsd(characters);
  const sampleText = buildSampleText(scriptText);
  const sampleUsd = estimateNarrationUsd(sampleText.length);
  const timing = track.durationMs === null ? null : compareNarrationToScenes(project, track.durationMs);
  const timingOff = timing !== null && Math.abs(timing.deltaMs) >= 500;

  /**
   * Speaks the saved script exactly. The store is flushed first so the audio and
   * the recorded fingerprint both describe the same, persisted text.
   */
  const runGeneration = async (kind: 'sample' | 'generate') => {
    const purpose = kind === 'sample' ? 'sample' : 'narration';
    setPending(null);
    setError(null);
    setNotice(null);
    if (scriptText.trim() === '') {
      setError('Write and save a script before generating narration.');
      return;
    }
    const text = purpose === 'sample' ? sampleText : scriptText;
    if (text.trim() === '') {
      setError('There is no text in the script to speak.');
      return;
    }
    setBusy(true);
    try {
      const flushed = await store.flush();
      if (!flushed.ok) {
        setError(flushed.message ?? 'The script could not be saved, so nothing was generated.');
        return;
      }
      const current = store.getSnapshot().active?.project;
      if (!current) {
        setError('The project is not open any more.');
        return;
      }
      const result = await generateNarration({
        id: newId('nar'),
        text,
        voice,
        purpose,
        projectId: current.id,
        scriptFingerprint: current.script.fingerprint,
      });

      if (purpose === 'sample') {
        if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current);
        const url = URL.createObjectURL(result.blob);
        sampleUrlRef.current = url;
        setSampleUrl(url);
        setNotice(
          `Sample spoken by ${narrationVoiceLabel(result.voice)}: ${result.characters} characters, about ${usd(result.estimatedUsd)} at the published list price.`,
        );
        window.setTimeout(() => void sampleRef.current?.play().catch(() => undefined), 50);
        await refreshUsage();
        return;
      }

      const nextTake: NarrationTake = {
        provider: NARRATION_MODEL.provider,
        model: result.model || NARRATION_MODEL.model,
        voice: result.voice,
        scriptFingerprint: current.script.fingerprint,
        characters: result.characters,
        estimatedUsd: result.estimatedUsd,
        jobId: result.jobId,
        generatedAt: new Date().toISOString(),
      };
      const stored = await storeGeneratedNarration(
        current.id,
        result.blob,
        nextTake,
        current.audio.narration.assetId,
      );
      const applied = store.mutate((latest) =>
        updateAudioTrack(latest, 'narration', {
          assetId: stored.id,
          fileName: stored.name,
          durationMs: stored.durationMs,
          muted: false,
          generated: nextTake,
        }),
      );
      if (!applied.ok) {
        await deleteAudioAsset(stored.id).catch(() => undefined);
        setError(applied.message ?? 'The narration was generated but could not be attached.');
        return;
      }
      setNotice(
        `Generated ${seconds(stored.durationMs)} of narration with ${narrationVoiceLabel(result.voice)}. The narration it replaced is kept and can be restored.`,
      );
      void cleanupProjectMedia(store).catch(() => undefined);
      await refreshUsage();
    } catch (reason) {
      setError(reasonMessage(reason, 'Narration could not be generated.'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Swaps the kept take back in. The take being swapped out becomes the restored
   * take's replacement, so the button keeps working in both directions instead
   * of hiding the newer narration for good.
   */
  const restorePrevious = async () => {
    if (!previous) return;
    setError(null);
    setNotice(null);
    const replacedId = track.assetId;
    try {
      if (replacedId && replacedId !== previous.id) {
        await linkAudioAssetReplacement(previous.id, replacedId);
      }
    } catch (reason) {
      setError(reasonMessage(reason, 'The previous narration could not be swapped in.'));
      return;
    }
    const applied = store.mutate((current) =>
      updateAudioTrack(current, 'narration', {
        assetId: previous.id,
        fileName: previous.name,
        durationMs: previous.durationMs,
        muted: false,
        generated: previous.generation ?? null,
      }),
    );
    if (!applied.ok) {
      setError(applied.message ?? 'The previous narration could not be restored.');
      return;
    }
    setNotice(
      `Restored the ${seconds(previous.durationMs)} take. The one it replaced is now the previous take.`,
    );
  };

  const fitTiming = () => {
    setPending(null);
    setError(null);
    let changed = 0;
    const result = store.mutate((current) => {
      const fitted = fitUnlockedSceneDurations(current, track.durationMs ?? 0, new Date().toISOString());
      changed = fitted.changedScenes;
      return fitted.project;
    });
    if (!result.ok) {
      setError(result.message ?? 'Scene timing could not be adjusted.');
      return;
    }
    setNotice(
      changed === 0
        ? 'The storyboard already matches the measured narration.'
        : `Rescaled ${changed} unlocked scene${changed === 1 ? '' : 's'} to the measured narration. Locked timing was left alone.`,
    );
  };

  const dialogCopy = (kind: PendingKind): { title: string; description: string } => {
    if (kind === 'sample') {
      return {
        title: 'Generate a sample?',
        description: `This sends the first ${sampleText.length} characters of the saved script to ${NARRATION_MODEL.label} with the ${narrationVoiceLabel(voice)} voice, for about ${usd(sampleUsd)} at the published list price. The sample is played, not attached to the project.`,
      };
    }
    if (kind === 'fit' && timing) {
      return {
        title: 'Fit scene durations to the narration?',
        description: `${timing.unlockedScenes} scene${timing.unlockedScenes === 1 ? '' : 's'} without a timing lock will be rescaled to total ${seconds(timing.measuredMs)}. ${timing.lockedScenes} locked scene${timing.lockedScenes === 1 ? '' : 's'} keep their exact planned duration.`,
      };
    }
    return {
      title: status === 'current' ? 'Generate narration again?' : 'Generate narration?',
      description: `This sends ${characters} characters of the saved script to ${NARRATION_MODEL.label} with the ${narrationVoiceLabel(voice)} voice, for about ${usd(estimatedUsd)} at the published list price (before allowances, plan and tax). The previous narration is kept until you replace it.`,
    };
  };

  const copy = pending ? dialogCopy(pending) : null;

  return (
    <Panel
      title="Narration audio"
      description="Speak the saved script with one provider voice, as a single take for the whole script. Generating never rewrites the script."
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
        <div className="row">
          <SelectField
            id="narration-voice"
            label="Voice"
            value={voice}
            disabled={busy}
            onChange={(event) => setVoice(event.target.value)}
          >
            {NARRATION_MODEL.voices.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </SelectField>
          <div className="row">
            <button
              type="button"
              className="btn btn-small"
              disabled={busy || sampleText.trim() === ''}
              onClick={() => setPending('sample')}
            >
              Preview sample
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || scriptText.trim() === ''}
              onClick={() => setPending('generate')}
            >
              {status === 'none' ? 'Generate narration' : 'Generate new narration'}
            </button>
          </div>
        </div>

        <p className="muted-small">
          {NARRATION_MODEL.label} · {NARRATION_MODEL.voices.length} voices · ${PRICE_PERCENT} per 1k
          characters published list price. This script is {characters} characters, so one generation
          is about {usd(estimatedUsd)}. Every generation is a billed provider request: it cannot be
          cancelled once sent, and a failed attempt is still counted here.
        </p>
        <p className="muted-small">{NARRATION_CAPABILITY_NOTES.speakingRate}</p>
        <p className="muted-small">{NARRATION_CAPABILITY_NOTES.pronunciation}</p>
        <p className="muted-small">{NARRATION_CAPABILITY_NOTES.cloning}</p>

        {sampleUrl ? (
          <audio ref={sampleRef} src={sampleUrl} controls className="audio-preview">
            Your browser cannot play this sample.
          </audio>
        ) : null}

        {take ? (
          <div className="stack">
            <div className="row">
              <Badge tone={status === 'stale' ? 'warn' : 'ok'}>
                {status === 'stale' ? 'Narration may be outdated' : 'Narration matches the script'}
              </Badge>
              <span className="muted-small">
                {narrationVoiceLabel(take.voice)} · {take.characters} characters ·{' '}
                {take.estimatedUsd === null ? 'no quoted price' : `about ${usd(take.estimatedUsd)}`} ·{' '}
                {formatTimestamp(take.generatedAt)}
              </span>
            </div>
            {status === 'stale' ? (
              <div className="review-banner is-stale" role="status">
                <div>
                  <strong>The script changed after this narration was generated</strong>
                  <p>
                    The audio may not match the saved script. Nothing regenerates on its own and no
                    credits are spent until you choose to generate again.
                  </p>
                </div>
              </div>
            ) : null}
            <p className="muted-small">
              Measured audio duration {track.durationMs === null ? 'not measured' : seconds(track.durationMs)}.
              {previous ? ' The take it replaced is still stored and can be swapped back in.' : ''}
            </p>
            {previous ? (
              <div className="row">
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => void restorePrevious()}
                >
                  Restore previous narration
                </button>
                <span className="muted-small">
                  Kept from an earlier generation ({seconds(previous.durationMs)}).
                </span>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="muted-small">No generated narration attached yet.</p>
        )}

        {timing ? (
          <div className="stack">
            <h3>Narration timing</h3>
            <p className="muted-small">
              Measured narration {seconds(timing.measuredMs)} against {seconds(timing.plannedMs)} of
              planned scene time ({timing.deltaMs >= 0 ? '+' : ''}
              {(timing.deltaMs / 1000).toFixed(2)} s). {timing.lockedScenes} scene
              {timing.lockedScenes === 1 ? '' : 's'} locked, {timing.unlockedScenes} unlocked.
            </p>
            {timingOff ? (
              <>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => document.getElementById('script-narration')?.focus()}
                  >
                    Edit the script
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy}
                    onClick={() => setPending('generate')}
                  >
                    Regenerate from the saved script
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy || timing.unlockedScenes === 0}
                    onClick={() => setPending('fit')}
                  >
                    Fit unlocked scene durations
                  </button>
                </div>
                <p className="muted-small">
                  Regenerating speaks the same text again at the voice’s natural pace, so its length
                  will not change. Editing the script is the only way to shorten or lengthen the
                  narration.
                </p>
              </>
            ) : null}
          </div>
        ) : null}

        {usage ? (
          <p className="muted-small">
            Today: {usage.usedToday} of {usage.dailyLimit} narration generations, about{' '}
            {usd(usage.estimatedUsdToday)} estimated at the list price. {usage.usedThisMinute} of{' '}
            {usage.minuteLimit} used in the current minute.
          </p>
        ) : null}
        {usageError ? <p className="muted-small">{usageError}</p> : null}
      </div>

      {pending && copy ? (
        <Dialog
          title={copy.title}
          description={copy.description}
          onDismiss={() => setPending(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (pending === 'fit') fitTiming();
                  else void runGeneration(pending);
                }}
              >
                {pending === 'fit' ? 'Adjust unlocked scenes' : 'Generate'}
              </button>
            </>
          }
        />
      ) : null}
    </Panel>
  );
}
