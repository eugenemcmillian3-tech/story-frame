import { useEffect, useState } from 'react';
import type { Project } from '../domain/types';
import { describeMissingMedia, findMissingMedia, isEmptyMissingMedia } from '../media/missingMedia';
import type { MissingMediaReport } from '../media/missingMedia';

/**
 * Project data and media are stored in different places, so the scene list can
 * claim an image is attached while the bytes are gone. Say so here instead of
 * letting the user discover it at export.
 */
export function MissingMediaNotice({ project }: { project: Project }) {
  const [missing, setMissing] = useState<MissingMediaReport | null>(null);
  const signature = [
    ...project.storyboard.scenes.map((scene) => scene.imageAssetId ?? ''),
    project.audio.narration.assetId ?? '',
    project.audio.music.assetId ?? '',
  ].join('|');

  useEffect(() => {
    let current = true;
    findMissingMedia(project)
      .then((report) => {
        if (current) setMissing(report);
      })
      .catch(() => {
        if (current) setMissing(null);
      });
    return () => {
      current = false;
    };
    // The signature covers every id the project points at; the project object
    // itself changes on every edit and would refetch for unrelated ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  if (!missing || isEmptyMissingMedia(missing)) return null;

  return (
    <div className="review-banner is-stale" role="status">
      <div>
        <strong>Media missing from this browser</strong>
        <p>{describeMissingMedia(missing, project.storyboard.scenes.length)}</p>
      </div>
    </div>
  );
}
