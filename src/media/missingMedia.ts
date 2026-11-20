import type { AudioTrackRole, Project } from '../domain/types';
import { getAssets, getAudioAssets } from './mediaDb';

export interface MissingMediaReport {
  /** Scenes whose attached image id has no stored image. */
  sceneIds: string[];
  /** Audio roles whose attached file id has no stored audio. */
  audioRoles: AudioTrackRole[];
}

export function isEmptyMissingMedia(report: MissingMediaReport): boolean {
  return report.sceneIds.length === 0 && report.audioRoles.length === 0;
}

/**
 * Compare the ids a project points at with the ids this browser actually has.
 * Project data lives in localStorage while media lives in IndexedDB, so one can
 * survive without the other.
 */
export function collectMissingMedia(
  project: Pick<Project, 'storyboard' | 'audio'>,
  presentImageIds: ReadonlySet<string>,
  presentAudioIds: ReadonlySet<string>,
): MissingMediaReport {
  const sceneIds = project.storyboard.scenes
    .filter((scene) => scene.imageAssetId !== null && !presentImageIds.has(scene.imageAssetId))
    .map((scene) => scene.id);
  const audioRoles = (['narration', 'music'] as const).filter((role) => {
    const assetId = project.audio[role].assetId;
    return assetId !== null && !presentAudioIds.has(assetId);
  });
  return { sceneIds, audioRoles };
}

/** Read the stored media for one project and report what is no longer there. */
export async function findMissingMedia(project: Project): Promise<MissingMediaReport> {
  const imageIds = [
    ...new Set(
      project.storyboard.scenes
        .map((scene) => scene.imageAssetId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const audioIds = [
    ...new Set(
      [project.audio.narration.assetId, project.audio.music.assetId].filter(
        (id): id is string => id !== null,
      ),
    ),
  ];
  const [assets, audioAssets] = await Promise.all([
    getAssets(imageIds),
    getAudioAssets(audioIds),
  ]);
  return collectMissingMedia(project, new Set(assets.keys()), new Set(audioAssets.keys()));
}

export function describeMissingMedia(report: MissingMediaReport, sceneCount: number): string {
  const parts: string[] = [];
  const sceneTotal = report.sceneIds.length;
  if (sceneTotal > 0) {
    parts.push(
      sceneTotal === 1
        ? `1 of ${sceneCount} scene images is missing from this browser`
        : `${sceneTotal} of ${sceneCount} scene images are missing from this browser`,
    );
  }
  if (report.audioRoles.length > 0) {
    const labels = report.audioRoles.map((role) =>
      role === 'narration' ? 'narration' : 'background music',
    );
    parts.push(`${labels.join(' and ')} audio is missing from this browser`);
  }
  const what = parts.join(', and ');
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}. The project itself is still here: re-attach or regenerate each missing item before you export.`;
}
