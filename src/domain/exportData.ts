import { PRODUCT } from '../brand';
import { SCHEMA_VERSION } from './types';
import type { Project } from './types';

export const PROJECT_DATA_EXPORT_KIND = 'project-data';

export const PROJECT_DATA_DISCLAIMER =
  'Project data only: brief, script, notes, storyboard metadata, and audio settings. This file does not contain uploaded images, narration audio binaries, music audio binaries, or rendered video, and is not a media backup.';

export interface ProjectDataExport {
  product: string;
  exportKind: typeof PROJECT_DATA_EXPORT_KIND;
  schemaVersion: number;
  exportedAt: string;
  disclaimer: string;
  project: Project;
}

export function buildProjectDataExport(
  project: Project,
  now: string = new Date().toISOString(),
): ProjectDataExport {
  return {
    product: PRODUCT.name,
    exportKind: PROJECT_DATA_EXPORT_KIND,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now,
    disclaimer: PROJECT_DATA_DISCLAIMER,
    project,
  };
}

export function serializeProjectDataExport(
  project: Project,
  now: string = new Date().toISOString(),
): string {
  return `${JSON.stringify(buildProjectDataExport(project, now), null, 2)}\n`;
}

export function projectDataFilename(project: Project): string {
  const slug = project.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 10);
  return `${slug || 'storyframe-project'}-project-data-${stamp}.json`;
}
