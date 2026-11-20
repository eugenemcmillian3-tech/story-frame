import { useEffect, useRef, useState } from 'react';
import { Panel } from './ui';
import { formatBytes } from '../format';
import { updateAudioTrack } from '../domain/project';
import type { AudioTrackRole, Project } from '../domain/types';
import { ACCEPTED_AUDIO_MIME_TYPES, storeAudioFile } from '../media/audioAssets';
import { deleteAudioAsset, getAudioAsset } from '../media/mediaDb';
import type { AudioAssetRecord } from '../media/mediaDb';
import { cleanupProjectMedia } from '../media/cleanup';
import { useStore } from '../state/StoreProvider';

function seconds(ms: number | null): string {
  return ms === null ? 'not measured' : `${(ms / 1000).toFixed(2)} s`;
}

function AudioTrackField({
  project,
  role,
  onCleanup,
}: {
  project: Project;
  role: AudioTrackRole;
  onCleanup: () => void;
}) {
  const store = useStore();
  const track = project.audio[role];
  const label = role === 'narration' ? 'Narration' : 'Background music';
  const audioRef = useRef<HTMLAudioElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [record, setRecord] = useState<AudioAssetRecord | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [measuredMs, setMeasuredMs] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;
    setRecord(null);
    setUrl(null);
    setMissing(false);
    setError(null);
    setMeasuredMs(null);
    setPlaying(false);
    if (!track.assetId) return;

    setBusy(true);
    getAudioAsset(track.assetId)
      .then((found) => {
        if (!active) return;
        if (!found) {
          setMissing(true);
          return;
        }
        createdUrl = URL.createObjectURL(found.blob);
        setRecord(found);
        setUrl(createdUrl);
        setMeasuredMs(found.durationMs);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : 'The audio could not be read.');
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [track.assetId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = track.volume;
    audio.muted = track.muted;
  }, [track.volume, track.muted, record]);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const stored = await storeAudioFile(project.id, file);
      const applied = store.mutate((current) =>
        updateAudioTrack(current, role, {
          assetId: stored.id,
          fileName: stored.name,
          durationMs: stored.durationMs,
        }),
      );
      if (!applied.ok) {
        await deleteAudioAsset(stored.id).catch(() => undefined);
        setError(applied.message ?? 'The audio was not attached.');
        return;
      }
      onCleanup();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That audio file could not be stored.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleRemove = () => {
    audioRef.current?.pause();
    const applied = store.mutate((current) =>
      updateAudioTrack(current, role, {
        assetId: null,
        fileName: null,
        durationMs: null,
        muted: false,
      }),
    );
    if (!applied.ok) {
      setError(applied.message ?? 'The audio was not removed.');
      return;
    }
    setError(null);
    onCleanup();
  };

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    setError(null);
    try {
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This audio could not play.');
    }
  };

  const setVolume = (value: number) => {
    const applied = store.mutate((current) =>
      updateAudioTrack(current, role, { volume: value / 100 }),
    );
    if (!applied.ok) setError(applied.message ?? 'The volume could not be changed.');
  };

  const toggleMute = () => {
    const applied = store.mutate((current) =>
      updateAudioTrack(current, role, { muted: !track.muted }),
    );
    if (!applied.ok) setError(applied.message ?? 'Mute could not be changed.');
  };

  return (
    <fieldset className="field audio-track">
      <legend>{label}</legend>
      <p className="field-hint">
        Optional. {role === 'narration' ? 'One uploaded narration file.' : 'One uploaded music file.'}{' '}
        Tested with 48 kHz stereo WAV. WAV, MP3, M4A, AAC, OGG, WebM, or FLAC are accepted when this
        browser can decode them, up to 25 MB and 10 minutes. Stored in this browser only.
      </p>

      {missing ? (
        <p className="field-error" role="alert">
          This {role} track’s file is missing from this browser. Replace it or remove the reference.
        </p>
      ) : null}

      {record && url ? (
        <div className="audio-card">
          <div className="audio-meta">
            <strong>{record.name}</strong>
            <span>
              {seconds(measuredMs ?? record.durationMs)} · {formatBytes(record.byteSize)} ·{' '}
              {record.mimeType}
            </span>
            <span className="media-asset-id">Audio {record.id.slice(0, 16)}…</span>
          </div>
          <audio
            ref={audioRef}
            src={url}
            preload="metadata"
            onLoadedMetadata={(event) => {
              const duration = event.currentTarget.duration;
              if (Number.isFinite(duration) && duration > 0) {
                setMeasuredMs(Math.round(duration * 1000));
              }
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
          <div className="row audio-actions">
            <button type="button" className="btn btn-small" onClick={() => void togglePlay()}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" className="btn btn-small" onClick={toggleMute}>
              {track.muted ? 'Unmute' : 'Mute'}
            </button>
            <label className="volume-control">
              <span>Volume {Math.round(track.volume * 100)}%</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(track.volume * 100)}
                aria-label={`${label} volume`}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </label>
          </div>
        </div>
      ) : null}

      {!record && !missing && !busy ? (
        <p className="muted-small">No {role} audio attached yet.</p>
      ) : null}
      {busy ? <p className="muted-small">Checking audio…</p> : null}

      <div className="media-actions">
        <label className={busy ? 'btn btn-small media-pick is-disabled' : 'btn btn-small media-pick'}>
          {record ? 'Replace audio' : 'Attach audio'}
          <input
            ref={inputRef}
            type="file"
            className="visually-hidden"
            accept={ACCEPTED_AUDIO_MIME_TYPES.join(',')}
            aria-label={`${label} audio file`}
            disabled={busy}
            onChange={(event) => void handleFile(event.target.files?.[0])}
          />
        </label>
        {track.assetId !== null ? (
          <button
            type="button"
            className="btn btn-small btn-danger"
            disabled={busy}
            onClick={handleRemove}
          >
            Remove audio
          </button>
        ) : null}
      </div>

      {track.muted && record ? (
        <p className="muted-small">Muted: this track will not be encoded into the MP4.</p>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function AudioTracksPanel({ project }: { project: Project }) {
  const store = useStore();
  const cleanup = () => {
    void cleanupProjectMedia(store).catch(() => undefined);
  };

  return (
    <Panel
      title="Audio tracks"
      description="Optional uploaded narration and background music. Both start at zero. The storyboard duration stays authoritative."
    >
      <div className="audio-grid">
        <AudioTrackField project={project} role="narration" onCleanup={cleanup} />
        <AudioTrackField project={project} role="music" onCleanup={cleanup} />
      </div>
      <p className="muted-small">
        Audio is mixed locally when you render. Longer tracks are trimmed at the storyboard end;
        shorter tracks are followed by silence. Music does not loop and narration is not sped up.
        If the summed source peaks exceed 98% of full scale, both tracks are scaled down together.
        This conservative clipping protection is not final loudness normalization.
      </p>
    </Panel>
  );
}
