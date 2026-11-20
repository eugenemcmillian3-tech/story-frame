import { useEffect, useRef, useState } from 'react';
import { SelectField } from './ui';
import type { ImageFraming, Scene } from '../domain/types';
import { formatBytes } from '../format';
import { ACCEPTED_IMAGE_MIME_TYPES, storeSceneImage } from '../media/imageAssets';
import { deleteAsset, getAsset, putAsset } from '../media/mediaDb';
import type { MediaAssetRecord } from '../media/mediaDb';

interface LoadedImage {
  record: MediaAssetRecord | null;
  url: string | null;
  missing: boolean;
}

/**
 * Attach/replace/remove a scene image and choose fit/fill framing. The image
 * bytes live in IndexedDB; the scene stores only the stable asset id. A
 * replacement records the image it replaced, so one step of undo survives.
 */
export function SceneImageField({
  projectId,
  scene,
  locked,
  onChange,
  onCleanup,
}: {
  projectId: string;
  scene: Scene;
  locked: boolean;
  onChange: (patch: { imageAssetId?: string | null; imageFraming?: ImageFraming }) => boolean;
  onCleanup: () => void;
}) {
  const [image, setImage] = useState<LoadedImage>({ record: null, url: null, missing: false });
  const [previous, setPrevious] = useState<MediaAssetRecord | null>(null);
  const [previousUrl, setPreviousUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;
    let createdPreviousUrl: string | null = null;
    setImage({ record: null, url: null, missing: false });
    setPrevious(null);
    setPreviousUrl(null);
    setError(null);
    if (!scene.imageAssetId) return;

    setBusy(true);
    getAsset(scene.imageAssetId)
      .then(async (record) => {
        if (!active) return;
        if (!record) {
          setImage({ record: null, url: null, missing: true });
          return;
        }
        createdUrl = URL.createObjectURL(record.blob);
        setImage({ record, url: createdUrl, missing: false });
        if (record.replacesAssetId) {
          const replaced = await getAsset(record.replacesAssetId).catch(() => undefined);
          if (!active || !replaced) return;
          createdPreviousUrl = URL.createObjectURL(replaced.blob);
          setPrevious(replaced);
          setPreviousUrl(createdPreviousUrl);
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : 'The attached image could not be read.');
      })
      .finally(() => {
        if (active) setBusy(false);
      });

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      if (createdPreviousUrl) URL.revokeObjectURL(createdPreviousUrl);
    };
  }, [scene.imageAssetId]);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const record = await storeSceneImage(projectId, file);
      if (image.record) {
        // Keep the replaced upload recoverable from the new record.
        await putAsset({ ...record, replacesAssetId: image.record.id });
      }
      const applied = onChange({ imageAssetId: record.id });
      if (!applied) {
        await deleteAsset(record.id).catch(() => undefined);
        setError('The image was not attached because the scene’s Visuals lock blocks changes.');
        return;
      }
      onCleanup();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That image could not be stored.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleRemove = () => {
    setError(null);
    if (!onChange({ imageAssetId: null })) {
      setError('The image was not removed because the scene’s Visuals lock blocks changes.');
      return;
    }
    onCleanup();
  };

  const handleFraming = (framing: ImageFraming) => {
    setError(null);
    if (!onChange({ imageFraming: framing })) {
      setError('The framing was not changed because the scene’s Visuals lock blocks changes.');
    }
  };

  /**
   * Point the scene back at the replaced image. The newer image is linked as the
   * restored image's predecessor first, so it stays recoverable too.
   */
  const handleRestorePrevious = async () => {
    if (!image.record || !previous) return;
    setError(null);
    setBusy(true);
    try {
      const current = image.record;
      await putAsset({ ...previous, replacesAssetId: current.id });
      await putAsset({ ...current, replacesAssetId: null });
      if (!onChange({ imageAssetId: previous.id })) {
        await putAsset({ ...previous, replacesAssetId: current.id });
        await putAsset({ ...current, replacesAssetId: previous.id });
        setError('The previous image was not restored because the scene’s Visuals lock blocks changes.');
        return;
      }
      onCleanup();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The previous image could not be restored.');
    } finally {
      setBusy(false);
    }
  };

  const generation = image.record?.generation ?? null;

  return (
    <fieldset className="field scene-media">
      <legend>Scene image</legend>
      <p className="field-hint">
        JPEG or PNG, up to 8 MB and 4096 px per side. Stored in this browser only. Every scene needs
        an image before the project can render. You can upload an image or attach one generated
        above; both use the same storage and render path.
      </p>

      {locked ? (
        <p className="media-locked" role="status">
          Visuals are locked. Unlock Visuals to attach, replace, remove, or reframe this image.
        </p>
      ) : null}

      {image.missing ? (
        <p className="field-error" role="alert">
          This scene’s image is missing from this browser. Replace it or remove the reference.
        </p>
      ) : null}

      {image.record && image.url ? (
        <div className="media-card">
          <img
            className="media-thumb"
            src={image.url}
            alt={`Attached scene image: ${image.record.name}`}
          />
          <div className="media-meta">
            <strong>{image.record.name}</strong>
            <span>
              {image.record.width}×{image.record.height} · {formatBytes(image.record.byteSize)} ·{' '}
              {image.record.mimeType}
            </span>
            <span className="media-asset-id">Asset {image.record.id.slice(0, 16)}…</span>
            {generation ? (
              <>
                <span>
                  Generated with {generation.provider} · {generation.model}
                </span>
                <details className="ai-note">
                  <summary>Generation details</summary>
                  <p className="muted-small">{generation.prompt}</p>
                  <ul className="plain-list muted-small">
                    <li>Job {generation.jobId}</li>
                    <li>
                      {generation.width}×{generation.height} · {generation.outputFormat} · style{' '}
                      {generation.style}
                    </li>
                    <li>Generated {new Date(generation.generatedAt).toLocaleString()}</li>
                    {generation.inferenceSeconds !== null ? (
                      <li>Provider runtime {generation.inferenceSeconds.toFixed(1)}s</li>
                    ) : null}
                  </ul>
                </details>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {!image.record && !image.missing && !busy ? (
        <p className="muted-small">No image attached yet.</p>
      ) : null}

      <div className="media-actions">
        <label className={locked || busy ? 'btn btn-small media-pick is-disabled' : 'btn btn-small media-pick'}>
          {busy ? 'Checking image…' : image.record ? 'Replace image' : 'Attach image'}
          <input
            ref={inputRef}
            type="file"
            className="visually-hidden"
            accept={ACCEPTED_IMAGE_MIME_TYPES.join(',')}
            aria-label="Scene image file"
            disabled={locked || busy}
            onChange={(event) => void handleFile(event.target.files?.[0])}
          />
        </label>
        {image.record || image.missing ? (
          <button
            type="button"
            className="btn btn-small btn-danger"
            disabled={locked || busy}
            onClick={handleRemove}
          >
            Remove image
          </button>
        ) : null}
        {previous && previousUrl ? (
          <button
            type="button"
            className="btn btn-small"
            disabled={locked || busy}
            onClick={() => void handleRestorePrevious()}
          >
            Restore previous image
          </button>
        ) : null}
      </div>

      {previous && previousUrl ? (
        <div className="media-card">
          <img
            className="media-thumb"
            src={previousUrl}
            alt={`Previous scene image: ${previous.name}`}
          />
          <div className="media-meta">
            <span>Replaced image, kept for restore</span>
            <strong>{previous.name}</strong>
            <span>
              {previous.width}×{previous.height} · {formatBytes(previous.byteSize)}
            </span>
          </div>
        </div>
      ) : null}

      {image.record ? (
        <SelectField
          id={`scene-image-framing-${scene.id}`}
          label="Image framing"
          value={scene.imageFraming}
          disabled={locked || busy}
          onChange={(event) => handleFraming(event.target.value as ImageFraming)}
          hint="Fit shows the whole image with bars. Fill crops it to cover the 9:16 frame."
        >
          <option value="fit">Fit — whole image</option>
          <option value="fill">Fill — cover the frame</option>
        </SelectField>
      ) : null}

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
