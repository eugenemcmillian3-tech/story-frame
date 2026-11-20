import { computeScriptFingerprint, fingerprintText } from '../domain/fingerprint';
import { DEFAULT_AI_MODEL, isAiModelId } from './models';
import type { AiModelId } from './models';
import { AiError } from './types';
import type {
  AiAngleSnapshot,
  AiBriefInput,
  AiSourceInput,
  AiStoryNotesInput,
  AiOperation,
} from './types';
import type { Project, SceneLockKey } from '../domain/types';

export interface AnglesInput {
  brief: AiBriefInput;
  sourceNotes: AiSourceInput[];
  storyNotes: AiStoryNotesInput;
}

export interface ScriptInput extends AnglesInput {
  angle: AiAngleSnapshot;
}

export interface StoryboardInput {
  brief: AiBriefInput;
  script: { narration: string; fingerprint: string };
}

/** One scene as directed editing sees it: ids, editable components, and locks. */
export interface EditSceneInput {
  id: string;
  title: string;
  narration: string;
  visualDirection: string;
  onScreenText: string;
  plannedDuration: number;
  status: 'draft' | 'approved';
  locks: { narration: boolean; visuals: boolean; text: boolean; timing: boolean };
}

export interface EditInput {
  brief: AiBriefInput;
  request: string;
  script: { narration: string; locked: boolean };
  scenes: EditSceneInput[];
}

export type AiRequestPayload =
  | { operation: 'angles'; model: AiModelId; input: AnglesInput }
  | { operation: 'script'; model: AiModelId; input: ScriptInput }
  | { operation: 'storyboard'; model: AiModelId; input: StoryboardInput }
  | { operation: 'edit'; model: AiModelId; input: EditInput };

/** Deterministic stringify so the client and Worker fingerprint identical input. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function fingerprintPlanningInput(
  operation: AiOperation,
  input: unknown,
  model: AiModelId = DEFAULT_AI_MODEL,
): string {
  return fingerprintText(stableStringify({ operation, model, input }));
}

export function briefInput(project: Project): AiBriefInput {
  const brief = project.brief;
  return {
    topic: brief.topic,
    audience: brief.audience,
    goal: brief.goal,
    mode: brief.mode,
    targetDuration: brief.targetDuration,
    tone: brief.tone,
    visualPreset: brief.visualPreset,
  };
}

export function sourceInputs(project: Project): AiSourceInput[] {
  if (project.brief.mode !== 'factual') return [];
  return project.sourceNotes.slice(0, 20).map((note) => ({
    id: note.id,
    title: note.title,
    excerpt: note.excerpt,
    notes: note.notes,
  }));
}

export function storyNotesInput(project: Project): AiStoryNotesInput {
  if (project.brief.mode !== 'fiction') {
    return { characters: '', setting: '', continuity: '' };
  }
  return {
    characters: project.storyNotes.characters,
    setting: project.storyNotes.setting,
    continuity: project.storyNotes.continuity,
  };
}

export function buildAnglesInput(project: Project): AnglesInput {
  return {
    brief: briefInput(project),
    sourceNotes: sourceInputs(project),
    storyNotes: storyNotesInput(project),
  };
}

export function buildScriptInput(project: Project, angle: AiAngleSnapshot): ScriptInput {
  return { ...buildAnglesInput(project), angle };
}

export function buildStoryboardInput(project: Project): StoryboardInput {
  return {
    brief: briefInput(project),
    script: {
      narration: project.script.narration,
      fingerprint: project.script.fingerprint,
    },
  };
}

export function buildEditInput(project: Project, request: string): EditInput {
  return {
    brief: briefInput(project),
    request: request.trim().slice(0, 400),
    script: { narration: project.script.narration, locked: project.script.locked },
    scenes: project.storyboard.scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      narration: scene.narration,
      visualDirection: scene.visualDirection,
      onScreenText: scene.onScreenText,
      plannedDuration: scene.plannedDuration,
      status: scene.status,
      locks: { ...scene.locks },
    })),
  };
}

export function editInputFingerprint(
  project: Project,
  request: string,
  model: AiModelId = DEFAULT_AI_MODEL,
): string {
  return fingerprintPlanningInput('edit', buildEditInput(project, request), model);
}

export function angleInputFingerprint(
  project: Project,
  model: AiModelId = DEFAULT_AI_MODEL,
): string {
  return fingerprintPlanningInput('angles', buildAnglesInput(project), model);
}

export function scriptInputFingerprint(
  project: Project,
  angle: AiAngleSnapshot,
  model: AiModelId = DEFAULT_AI_MODEL,
): string {
  return fingerprintPlanningInput('script', buildScriptInput(project, angle), model);
}

export function storyboardInputFingerprint(
  project: Project,
  model: AiModelId = DEFAULT_AI_MODEL,
): string {
  return fingerprintPlanningInput('storyboard', buildStoryboardInput(project), model);
}

function invalid(message: string): AiError {
  return new AiError('invalid-input', message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(
  source: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
  required = true,
): string {
  const value = source[key];
  if (typeof value !== 'string') throw invalid(`${label} must be text.`);
  if (required && value.trim() === '') throw invalid(`${label} is required.`);
  if (value.length > maxLength) throw invalid(`${label} is too long.`);
  return value;
}

function readBrief(value: unknown): AiBriefInput {
  const brief = record(value, 'input.brief');
  const mode = brief.mode;
  if (mode !== 'factual' && mode !== 'fiction') throw invalid('input.brief.mode is invalid.');
  const target = brief.targetDuration;
  if (target !== 30 && target !== 45 && target !== 60 && target !== 90) {
    throw invalid('input.brief.targetDuration is invalid.');
  }
  const preset = brief.visualPreset;
  if (
    preset !== 'cinematic-explainer' &&
    preset !== 'illustrated-story' &&
    preset !== 'clean-educational'
  ) {
    throw invalid('input.brief.visualPreset is invalid.');
  }
  return {
    topic: text(brief, 'topic', 'input.brief.topic', 8000),
    audience: text(brief, 'audience', 'input.brief.audience', 500),
    goal: text(brief, 'goal', 'input.brief.goal', 1000),
    mode,
    targetDuration: target,
    tone: text(brief, 'tone', 'input.brief.tone', 300),
    visualPreset: preset,
  };
}

function readSources(value: unknown, mode: 'factual' | 'fiction'): AiSourceInput[] {
  if (!Array.isArray(value)) throw invalid('input.sourceNotes must be a list.');
  if (value.length > 20) throw invalid('input.sourceNotes has too many items.');
  if (mode === 'fiction' && value.length > 0) {
    throw invalid('Fiction requests cannot include source notes.');
  }
  const ids = new Set<string>();
  let totalChars = 0;
  return value.map((item, index) => {
    const source = record(item, `input.sourceNotes[${index}]`);
    const id = text(source, 'id', `input.sourceNotes[${index}].id`, 200);
    if (ids.has(id)) throw invalid('input.sourceNotes contains duplicate source IDs.');
    ids.add(id);
    const excerpt = text(source, 'excerpt', `input.sourceNotes[${index}].excerpt`, 30_000, false);
    const notes = text(source, 'notes', `input.sourceNotes[${index}].notes`, 4000, false);
    const title = text(source, 'title', `input.sourceNotes[${index}].title`, 400, false);
    totalChars += excerpt.length + notes.length + title.length;
    if (totalChars > 40_000) throw invalid('input.sourceNotes is too large.');
    return { id, title, excerpt, notes };
  });
}

function readStoryNotes(value: unknown, mode: 'factual' | 'fiction'): AiStoryNotesInput {
  const notes = record(value, 'input.storyNotes');
  if (mode !== 'fiction') return { characters: '', setting: '', continuity: '' };
  return {
    characters: text(notes, 'characters', 'input.storyNotes.characters', 4000, false),
    setting: text(notes, 'setting', 'input.storyNotes.setting', 4000, false),
    continuity: text(notes, 'continuity', 'input.storyNotes.continuity', 8000, false),
  };
}

function readAngle(value: unknown): AiAngleSnapshot {
  const angle = record(value, 'input.angle');
  return {
    title: text(angle, 'title', 'input.angle.title', 160),
    hook: text(angle, 'hook', 'input.angle.hook', 800),
    approach: text(angle, 'approach', 'input.angle.approach', 800),
    explanation: text(angle, 'explanation', 'input.angle.explanation', 1200),
  };
}

function readAnglesBase(input: unknown): { input: AnglesInput; mode: 'factual' | 'fiction' } {
  const recordValue = record(input, 'input');
  const brief = readBrief(recordValue.brief);
  return {
    input: {
      brief,
      sourceNotes: readSources(recordValue.sourceNotes, brief.mode),
      storyNotes: readStoryNotes(recordValue.storyNotes, brief.mode),
    },
    mode: brief.mode,
  };
}

/** Validate the request before any provider call. Unknown fields are ignored. */
export function parseAiRequest(value: unknown): AiRequestPayload {
  const root = record(value, 'request');
  const operation = root.operation;
  const requestedModel = root.model;
  if (requestedModel !== undefined && !isAiModelId(requestedModel)) {
    throw invalid('model is not one of the supported Ollama Cloud models.');
  }
  const model = requestedModel === undefined ? DEFAULT_AI_MODEL : requestedModel;
  if (operation === 'angles') {
    return { operation, model, input: readAnglesBase(root.input).input };
  }
  if (operation === 'script') {
    const base = readAnglesBase(root.input);
    const recordValue = record(root.input, 'input');
    return {
      operation,
      model,
      input: { ...base.input, angle: readAngle(recordValue.angle) },
    };
  }
  if (operation === 'edit') {
    const recordValue = record(root.input, 'input');
    const brief = readBrief(recordValue.brief);
    const request = text(recordValue, 'request', 'input.request', 400);
    const script = record(recordValue.script, 'input.script');
    const narration = text(script, 'narration', 'input.script.narration', 40_000, false);
    const locked = script.locked;
    if (typeof locked !== 'boolean') throw invalid('input.script.locked must be true or false.');
    if (!Array.isArray(recordValue.scenes)) throw invalid('input.scenes must be a list.');
    if (recordValue.scenes.length > 200) throw invalid('input.scenes has too many items.');
    const ids = new Set<string>();
    const scenes = recordValue.scenes.map((item, index) => {
      const path = `input.scenes[${index}]`;
      const scene = record(item, path);
      const id = text(scene, 'id', `${path}.id`, 200);
      if (ids.has(id)) throw invalid('input.scenes contains duplicate scene IDs.');
      ids.add(id);
      const status = scene.status;
      if (status !== 'draft' && status !== 'approved') {
        throw invalid(`${path}.status is invalid.`);
      }
      const locks = record(scene.locks, `${path}.locks`);
      const readLock = (key: SceneLockKey): boolean => {
        const value = locks[key];
        if (typeof value !== 'boolean') throw invalid(`${path}.locks.${key} must be true or false.`);
        return value;
      };
      const plannedDuration = scene.plannedDuration;
      if (
        typeof plannedDuration !== 'number' ||
        !Number.isFinite(plannedDuration) ||
        plannedDuration < 0 ||
        plannedDuration > 600
      ) {
        throw invalid(`${path}.plannedDuration must be between 0 and 600 seconds.`);
      }
      return {
        id,
        title: text(scene, 'title', `${path}.title`, 200, false),
        narration: text(scene, 'narration', `${path}.narration`, 8000, false),
        visualDirection: text(scene, 'visualDirection', `${path}.visualDirection`, 4000, false),
        onScreenText: text(scene, 'onScreenText', `${path}.onScreenText`, 500, false),
        plannedDuration,
        status: status as 'draft' | 'approved',
        locks: {
          narration: readLock('narration'),
          visuals: readLock('visuals'),
          text: readLock('text'),
          timing: readLock('timing'),
        },
      };
    });
    return { operation, model, input: { brief, request, script: { narration, locked }, scenes } };
  }
  if (operation === 'storyboard') {
    const recordValue = record(root.input, 'input');
    const brief = readBrief(recordValue.brief);
    const script = record(recordValue.script, 'input.script');
    const narration = text(script, 'narration', 'input.script.narration', 40_000);
    const fingerprint = text(script, 'fingerprint', 'input.script.fingerprint', 200);
    if (computeScriptFingerprint(narration) !== fingerprint) {
      throw invalid('input.script.fingerprint does not match the narration.');
    }
    return { operation, model, input: { brief, script: { narration, fingerprint } } };
  }
  throw invalid('operation must be angles, script, storyboard, or edit.');
}

export function requestFingerprint(payload: AiRequestPayload): string {
  return fingerprintPlanningInput(payload.operation, payload.input, payload.model);
}
