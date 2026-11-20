import type { Project } from '../domain/types';
import { deleteAsset, deleteAudioAsset, listAllAssets, listAllAudioAssets } from './mediaDb';

/** Every image asset id still referenced by a scene in any readable project. */
export function referencedAssetIds(projects: Array<Pick<Project, 'storyboard'>>): Set<string> {
  const referenced = new Set<string>();
  for (const project of projects) {
    const boards = [project.storyboard.scenes, project.storyboard.previous?.scenes ?? []];
    for (const scenes of boards) {
      for (const scene of scenes) {
        if (scene.imageAssetId) referenced.add(scene.imageAssetId);
      }
    }
  }
  return referenced;
}

/** Every uploaded narration or music asset still referenced by any project. */
export function referencedAudioAssetIds(projects: Array<Pick<Project, 'audio'>>): Set<string> {
  const referenced = new Set<string>();
  for (const project of projects) {
    for (const track of [project.audio.narration, project.audio.music]) {
      if (track.assetId) referenced.add(track.assetId);
    }
  }
  return referenced;
}

/**
 * Delete stored images and audio no project refers to any more. Assets may be shared by
 * duplicated scenes and projects, so references are counted across every
 * readable project. Callers must not run this while any project is unreadable:
 * its references could not be counted, and deleting its images would lose data.
 */
export interface ProjectMediaCleanupSource {
  hasUnreadableProjects(): boolean;
  listAllProjects(): Project[];
  getActiveProject(): Project | null;
  flush(): Promise<unknown>;
}

/**
 * Persist pending project edits, then delete images no scene references. The
 * flush matters: a just-attached image is only referenced once its scene saves.
 */
export async function cleanupProjectMedia(store: ProjectMediaCleanupSource): Promise<string[]> {
  if (store.hasUnreadableProjects()) return [];
  await store.flush();
  const projects = store.listAllProjects();
  const active = store.getActiveProject();
  if (active) {
    const index = projects.findIndex((candidate) => candidate.id === active.id);
    if (index === -1) projects.push(active);
    else projects[index] = active;
  }
  const [images, audio] = await Promise.all([
    cleanupUnreferencedAssets(projects),
    cleanupUnreferencedAudio(projects),
  ]);
  return [...images, ...audio];
}

async function cleanupUnreferencedAssets(projects: Project[]): Promise<string[]> {
  const referenced = referencedAssetIds(projects);
  const assets = await listAllAssets();
  // A replaced image is still reachable from the scene's current image, so its
  // whole replacement chain has to survive cleanup for undo to work.
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  for (const id of [...referenced]) {
    let cursor = byId.get(id)?.replacesAssetId ?? null;
    let guard = 0;
    while (cursor && !referenced.has(cursor) && guard < 50) {
      referenced.add(cursor);
      cursor = byId.get(cursor)?.replacesAssetId ?? null;
      guard += 1;
    }
  }
  const deleted: string[] = [];
  for (const asset of assets) {
    if (referenced.has(asset.id)) continue;
    await deleteAsset(asset.id);
    deleted.push(asset.id);
  }
  return deleted;
}

async function cleanupUnreferencedAudio(projects: Project[]): Promise<string[]> {
  const referenced = referencedAudioAssetIds(projects);
  const assets = await listAllAudioAssets();
  const deleted: string[] = [];
  for (const asset of assets) {
    if (referenced.has(asset.id)) continue;
    await deleteAudioAsset(asset.id);
    deleted.push(asset.id);
  }
  return deleted;
}
