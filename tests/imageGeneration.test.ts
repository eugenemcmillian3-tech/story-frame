// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  IMAGE_MODEL,
  IMAGE_MODEL_LABEL,
  IMAGE_PROVIDER,
  IMAGE_SIZE,
  IMAGE_STEPS,
  IMAGE_USD_ESTIMATE,
  MAX_PROMPT_CHARS,
  buildSceneImagePrompt,
} from '../src/images/provider';
import { createSampleProject } from '../src/domain/sample';

describe('Workers AI image provider', () => {
  it('uses the one documented model and its limits', () => {
    expect(IMAGE_PROVIDER).toBe('cloudflare-workers-ai');
    expect(IMAGE_MODEL).toBe('@cf/black-forest-labs/flux-1-schnell');
    expect(IMAGE_MODEL_LABEL).toBe('FLUX.1 Schnell');
    expect(IMAGE_SIZE).toBe(1_024);
    expect(IMAGE_STEPS).toBe(4);
    expect(MAX_PROMPT_CHARS).toBe(2_048);
  });

  it('derives the estimate from the published per-tile and per-step rates', () => {
    // Four 512×512 tiles at $0.0000528 plus four steps per tile at $0.0001056.
    expect(IMAGE_USD_ESTIMATE).toBeCloseTo(4 * (0.0000528 + 4 * 0.0001056), 8);
    expect(IMAGE_USD_ESTIMATE).toBeCloseTo(0.0019008, 7);
  });
});

describe('scene image prompt', () => {
  const project = createSampleProject();
  const scene = project.storyboard.scenes[0];

  it('includes the visual direction, preset and format constraints', () => {
    const prompt = buildSceneImagePrompt({
      scene,
      brief: project.brief,
      styleId: 'preset',
    });
    expect(prompt).toContain(scene.visualDirection.trim());
    expect(prompt).toContain('Project preset');
    expect(prompt).toContain('No words');
    expect(prompt).not.toMatch(/\bhttps?:\/\//);
  });

  it('replaces the preset look with an explicit style setting', () => {
    const preset = buildSceneImagePrompt({ scene, brief: project.brief, styleId: 'preset' });
    const photo = buildSceneImagePrompt({
      scene,
      brief: project.brief,
      styleId: 'photo-editorial',
    });
    expect(photo).not.toBe(preset);
    expect(photo).toContain('Editorial photograph');
  });

  it('stays within the 2048-character prompt limit', () => {
    const longScene = { ...scene, visualDirection: 'x'.repeat(10_000) };
    const prompt = buildSceneImagePrompt({
      scene: longScene,
      brief: project.brief,
      styleId: 'cinema-still',
    });
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });
});
