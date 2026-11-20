import { describe, expect, it, vi } from 'vitest';
import { downloadTextFile } from '../src/download';
import {
  PROJECT_DATA_DISCLAIMER,
  buildProjectDataExport,
  projectDataFilename,
  serializeProjectDataExport,
} from '../src/domain/exportData';
import { createProject } from '../src/domain/project';
import { SCHEMA_VERSION } from '../src/domain/types';
import { parseProjectJson } from '../src/domain/validation';

const project = createProject({
  title: 'Tide pools: a short explainer',
  mode: 'factual',
  targetDuration: 60,
  visualPreset: 'clean-educational',
});

describe('project data export', () => {
  it('produces valid, parseable JSON that round-trips through the validator', () => {
    const text = serializeProjectDataExport(project, '2026-01-01T00:00:00.000Z');
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toBeTypeOf('object');

    const exported = buildProjectDataExport(project, '2026-01-01T00:00:00.000Z');
    expect(exported.exportKind).toBe('project-data');
    expect(exported.schemaVersion).toBe(SCHEMA_VERSION);
    expect(exported.disclaimer).toBe(PROJECT_DATA_DISCLAIMER);
    expect(exported.disclaimer).toMatch(/not a media backup/i);

    const roundTrip = parseProjectJson(exported.project);
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) return;
    expect(roundTrip.value.id).toBe(project.id);
    expect(roundTrip.value.title).toBe(project.title);
  });

  it('never includes secret-like fields', () => {
    const text = serializeProjectDataExport(project).toLowerCase();
    for (const forbidden of ['api_key', 'apikey', 'secret', 'bearer ', 'password']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('uses a .json filename', () => {
    expect(projectDataFilename(project)).toMatch(/^[a-z0-9-]+-project-data-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('downloads a real JSON file through an anchor element', () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:storyframe-export');
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });

    let clicked: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked = this;
    });

    downloadTextFile(
      projectDataFilename(project),
      serializeProjectDataExport(project),
      'application/json',
    );

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toContain('application/json');
    expect(clicked).not.toBeNull();
    expect((clicked as unknown as HTMLAnchorElement).download).toMatch(/\.json$/);
  });
});
