/**
 * Provider boundaries for later phases. Interfaces only: no endpoints, no
 * credentials, no network calls, and nothing in the UI depends on a provider's
 * field names. Every method is expected to be asynchronous because real
 * providers will be.
 */
import type { AssetType, Brief, Project, Scene, VisualPreset } from '../domain/types';

export interface ProviderDescriptor {
  /** Stable provider id chosen when a real integration is added. */
  id: string;
  label: string;
  /** False until a provider is implemented and configured. */
  connected: boolean;
}

export interface CreativeAngle {
  id: string;
  title: string;
  summary: string;
}

export interface ScriptGenerationRequest {
  brief: Brief;
  angles: CreativeAngle[];
}

export interface ScriptGenerationResult {
  narration: string;
}

export interface ScriptGenerationProvider extends ProviderDescriptor {
  generateScript(request: ScriptGenerationRequest): Promise<ScriptGenerationResult>;
}

export interface StoryboardGenerationRequest {
  brief: Brief;
  scriptNarration: string;
}

export interface StoryboardGenerationResult {
  scenes: Array<Omit<Scene, 'id' | 'locks' | 'status' | 'assetRef'>>;
}

export interface StoryboardGenerationProvider extends ProviderDescriptor {
  generateStoryboard(
    request: StoryboardGenerationRequest,
  ): Promise<StoryboardGenerationResult>;
}

export interface VisualGenerationRequest {
  brief: Brief;
  scene: Pick<Scene, 'id' | 'title' | 'visualDirection' | 'onScreenText'>;
  preset: VisualPreset;
  assetType: AssetType;
}

export interface VisualGenerationResult {
  /** Opaque provider asset reference; never a local file path assumption. */
  assetId: string;
  mimeType: string;
}

export interface VisualGenerationProvider extends ProviderDescriptor {
  generateVisual(request: VisualGenerationRequest): Promise<VisualGenerationResult>;
}

export interface NarrationGenerationRequest {
  text: string;
  voiceLabel: string;
}

export interface NarrationGenerationResult {
  assetId: string;
  /** Measured duration, once real audio exists. */
  durationSeconds: number;
}

export interface NarrationGenerationProvider extends ProviderDescriptor {
  generateNarration(
    request: NarrationGenerationRequest,
  ): Promise<NarrationGenerationResult>;
}

export interface RenderRequest {
  project: Project;
  exportPreset: '9:16';
}

export interface RenderResult {
  assetId: string;
  durationSeconds: number;
}

export interface RenderingProvider extends ProviderDescriptor {
  render(request: RenderRequest): Promise<RenderResult>;
}

export interface ProviderRegistry {
  script: ScriptGenerationProvider | null;
  storyboard: StoryboardGenerationProvider | null;
  visuals: VisualGenerationProvider | null;
  narration: NarrationGenerationProvider | null;
  rendering: RenderingProvider | null;
}

/** This milestone ships no providers. */
export const UNCONNECTED_PROVIDERS: ProviderRegistry = {
  script: null,
  storyboard: null,
  visuals: null,
  narration: null,
  rendering: null,
};
