// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  IMAGE_PROVIDER_LABELS,
  MAX_PROMPT_CHARS,
  buildSceneImagePrompt,
  imageModel,
  modelLabel,
} from '../src/images/provider';
import { createSampleProject } from '../src/domain/sample';

describe('image provider registry', () => {
  it('offers both providers, each with a verified model', () => {
    const cloudflare = IMAGE_MODELS.filter((model) => model.provider === 'workers-ai');
    const leonardo = IMAGE_MODELS.filter((model) => model.provider === 'leonardo');
    expect(cloudflare).toHaveLength(1);
    expect(leonardo).toHaveLength(2);
    expect(IMAGE_PROVIDER_LABELS['workers-ai']).toBe('Cloudflare Workers AI');
    expect(IMAGE_PROVIDER_LABELS.leonardo).toBe('Leonardo.Ai');
    expect(DEFAULT_IMAGE_MODEL).toBe('cf-flux-schnell');
  });

  it('records the provider’s own model names and lifecycles', () => {
    expect(imageModel('cf-flux-schnell')).toMatchObject({
      model: '@cf/black-forest-labs/flux-1-schnell',
      lifecycle: 'sync',
      steps: 4,
      width: 1_024,
      height: 1_024,
    });
    expect(imageModel('leonardo-phoenix')).toMatchObject({
      model: 'phoenix-v1.0',
      lifecycle: 'async',
      quality: 'FAST',
      width: 1_024,
      height: 1_792,
      usdEstimate: null,
      reportsCredits: true,
    });
    expect(imageModel('leonardo-lucid-origin')?.model).toBe('lucid-origin');
    expect(modelLabel('phoenix-v1.0')).toBe('Leonardo Phoenix 1.0');
    expect(modelLabel('@cf/black-forest-labs/flux-1-schnell')).toBe('FLUX.1 Schnell');
  });

  it('only quotes a price where the provider publishes one', () => {
    // Four 512×512 tiles at $0.0000528 plus four steps per tile at $0.0001056.
    expect(imageModel('cf-flux-schnell')?.usdEstimate).toBeCloseTo(0.0019008, 7);
    expect(imageModel('leonardo-phoenix')?.usdEstimate).toBeNull();
    expect(imageModel('leonardo-lucid-origin')?.usdEstimate).toBeNull();
  });

  it('honours each provider’s prompt limit', () => {
    expect(imageModel('cf-flux-schnell')?.maxPromptChars).toBe(2_048);
    expect(imageModel('leonardo-phoenix')?.maxPromptChars).toBe(2_000);
    expect(MAX_PROMPT_CHARS).toBe(2_048);
  });
});

describe('scene image prompt', () => {
  const project = createSampleProject();
  const scene = project.storyboard.scenes[0];

  it('includes the visual direction, preset and format constraints', () => {
    const prompt = buildSceneImagePrompt({ scene, brief: project.brief, styleId: 'preset' });
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

  it('stays within the longest prompt the providers accept', () => {
    const longScene = { ...scene, visualDirection: 'x'.repeat(10_000) };
    const prompt = buildSceneImagePrompt({
      scene: longScene,
      brief: project.brief,
      styleId: 'cinema-still',
    });
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });
});
