/**
 * Directed editing: a request becomes a bounded list of allowlisted commands,
 * previewed against the project, then applied atomically.
 *
 * Nothing here trusts the model with free-form project fields. Each command can
 * set exactly one component of one target, and the domain functions below own
 * every write: locks are enforced by `updateScene`/`replaceScriptNarration`, not
 * by the caller. A plan carries the project state it was planned against, so a
 * plan made before an edit can never be applied on top of unrelated changes.
 */
import { DomainError } from './errors';
import { fingerprintText } from './fingerprint';
import { estimateRuntimeSeconds, formatDuration, totalPlannedDuration } from './duration';
import { newId } from './ids';
import { replaceScriptNarration, updateAudioTrack } from './project';
import { setSceneStatus, updateScene } from './storyboard';
import { MAX_EDIT_HISTORY, SCENE_LOCK_KEYS } from './constants';
import { estimateNarrationUsd } from '../narration/provider';
import type {
  EditBlockedTarget,
  EditCommand,
  EditRecord,
  EditSnapshot,
  Project,
  Scene,
  SceneLockKey,
} from './types';

export type { EditBlockedTarget, EditCommand, EditRecord, EditSnapshot } from './types';

export const MAX_EDIT_REQUEST_CHARS = 400;
/**
 * A one- or two-word boundary can match the wrong place in a script, so a
 * scoped rewrite needs enough unchanged text to identify the split.
 */
export const MIN_SCRIPT_BOUNDARY_CHARS = 12;

/** The project state a plan was made against. Any edit invalidates the plan. */
export function editProjectFingerprint(project: Project): string {
  return fingerprintText(
    JSON.stringify({
      script: project.script.narration,
      locked: project.script.locked,
      scenes: project.storyboard.scenes.map((scene) => ({
        id: scene.id,
        title: scene.title,
        narration: scene.narration,
        visualDirection: scene.visualDirection,
        onScreenText: scene.onScreenText,
        plannedDuration: scene.plannedDuration,
        imageAssetId: scene.imageAssetId,
        status: scene.status,
        locks: scene.locks,
      })),
      audio: {
        narration: project.audio.narration.assetId,
        music: project.audio.music.assetId,
      },
      reviewed: project.storyboard.reviewedScriptFingerprint,
    }),
  );
}

/** Where a conflict came from: a command, a verified provider target, or the request text. */
export interface LockConflict {
  message: string;
  source: 'command' | 'provider' | 'request';
}

export interface EditPlan {
  id: string;
  request: string;
  model: string;
  /** Project state the commands were planned against. */
  projectFingerprint: string;
  /** Fingerprint of the request payload, from the provider round trip. */
  inputFingerprint: string;
  createdAt: string;
  commands: EditCommand[];
  /** Provider-named locks behind an empty command list; verified before use. */
  blocked?: EditBlockedTarget[];
  /** The provider named the narration script lock instead of a scene. */
  blockedScript?: boolean;
}

function invalid(message: string): DomainError {
  return new DomainError('invalid-value', message);
}

function sceneIndex(project: Project, sceneId: string): number {
  const index = project.storyboard.scenes.findIndex((scene) => scene.id === sceneId);
  if (index === -1) throw invalid('That scene is no longer in the storyboard.');
  return index;
}

export function sceneLabel(project: Project, sceneId: string): string {
  const index = sceneIndex(project, sceneId);
  const scene = project.storyboard.scenes[index] as Scene;
  return `Scene ${index + 1} (“${scene.title}”)`;
}

/** The new whole script a `script.replace` command produces, verified. */
export function composeScript(project: Project, command: EditCommand): string {
  if (command.kind !== 'script.replace') throw invalid('That command does not replace the script.');
  const current = project.script.narration;
  if (command.scope === 'all') return command.text.trim();
  if (command.boundary.trim().length < MIN_SCRIPT_BOUNDARY_CHARS) {
    throw invalid(
      `That edit needs at least ${MIN_SCRIPT_BOUNDARY_CHARS} characters of the exact script text it keeps unchanged, so the split can be verified.`,
    );
  }
  if (command.scope === 'opening') {
    if (!current.endsWith(command.boundary)) {
      throw invalid('The script text this opening edit keeps no longer matches the saved script.');
    }
    return `${command.text.trim()}${command.boundary}`;
  }
  if (!current.startsWith(command.boundary)) {
    throw invalid('The script text this ending edit keeps no longer matches the saved script.');
  }
  return `${command.boundary}${command.text.trim()}`;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface EditPreview {
  affected: string[];
  preserved: string[];
  lockConflicts: LockConflict[];
  timing: string[];
  regenerations: string[];
  estimatedUsage: {
    planningRequests: number;
    narrationCharacters: number;
    narrationUsd: number | null;
    imageGenerations: number;
  };
  stale: boolean;
  applicable: boolean;
  alternatives: string[];
}

function lockedComponents(project: Project, command: EditCommand): string[] {
  if (command.kind === 'script.replace') {
    return project.script.locked ? ['script'] : [];
  }
  const scene = project.storyboard.scenes[sceneIndex(project, command.sceneId)] as Scene;
  if (command.kind === 'scene.visual' && scene.locks.visuals) return ['visuals'];
  if (command.kind === 'scene.text' && scene.locks.text) return ['text'];
  if (command.kind === 'scene.duration' && scene.locks.timing) return ['timing'];
  return [];
}

const LOCKED_COMPONENT_LABELS: Record<SceneLockKey, string> = {
  narration: 'narration',
  visuals: 'visual direction',
  text: 'on-screen text',
  timing: 'planned duration',
};

/** Words that name the component a request is about, in the user's own terms. */
const COMPONENT_PATTERNS: ReadonlyArray<{ component: SceneLockKey; pattern: RegExp }> = [
  { component: 'visuals', pattern: /\b(?:visuals?|images?|shots?|frames?|pictures?|close-?ups?)\b/ },
  { component: 'text', pattern: /\b(?:on-?screen text|captions?|title cards?|text)\b/ },
  { component: 'timing', pattern: /\b(?:timing|duration|seconds?|longer|shorter|length)\b/ },
  { component: 'narration', pattern: /\b(?:narration|voice-?overs?)\b/ },
];

/** `scene 2`, `Scene #2` and `scene 2's` all point at position 2. */
function referencedScenePositions(project: Project, text: string): number[] {
  const positions = new Set<number>();
  for (const match of text.matchAll(/scene\s*#?\s*(\d+)/g)) {
    const position = Number(match[1]) - 1;
    if (position >= 0 && position < project.storyboard.scenes.length) positions.add(position);
  }
  return [...positions].sort((a, b) => a - b);
}

/**
 * A zero-command plan can mean the provider refused because the target is
 * locked, but its explanation is prose the domain must not trust. This fallback
 * reads only the request and the project: an explicit scene number plus the
 * component word. Titles are deliberately not matched — a substring such as
 * “close” in “close-up” is worse than an empty list, and the panel explains the
 * refusal in the provider's words right above this section.
 */
function inferLockConflicts(
  project: Project,
  request: string,
): { conflicts: string[]; alternatives: string[] } {
  const text = request.toLowerCase();
  const requested = COMPONENT_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ component }) => component,
  );
  const conflicts: string[] = [];
  const alternatives: string[] = [];
  const positions = referencedScenePositions(project, text);

  for (const position of positions) {
    const scene = project.storyboard.scenes[position] as Scene;
    const locked = SCENE_LOCK_KEYS.filter(
      (component) =>
        scene.locks[component] && (requested.length === 0 || requested.includes(component)),
    );
    for (const component of locked) {
      conflicts.push(
        `${sceneLabel(project, scene.id)} ${LOCKED_COMPONENT_LABELS[component]} is locked.`,
      );
      alternatives.push(
        `Unlock ${component} on Scene ${position + 1} yourself, or limit the request to unlocked scenes.`,
      );
    }
  }

  // “Rewrite” is script-level only when it names no scene; otherwise it is a
  // request about that scene, which the scene locks above already cover.
  const scriptLevel = /\bscript\b/.test(text) || (/\brewrite\b/.test(text) && positions.length === 0);
  if (project.script.locked && scriptLevel) {
    conflicts.push('The narration script is locked.');
    alternatives.push(
      'Unlock the script yourself, then plan the change again; this app never unlocks it for you.',
    );
  }

  return { conflicts: [...new Set(conflicts)], alternatives: [...new Set(alternatives)] };
}

function describeCommand(project: Project, command: EditCommand): string {
  if (command.kind === 'script.replace') {
    if (command.scope === 'all') return 'Whole narration script';
    return command.scope === 'opening'
      ? 'Opening of the narration script'
      : 'Ending of the narration script';
  }
  const label = sceneLabel(project, command.sceneId);
  if (command.kind === 'scene.visual') return `${label} visual direction`;
  if (command.kind === 'scene.text') return `${label} on-screen text`;
  return `${label} planned duration`;
}

export function previewEditPlan(project: Project, plan: EditPlan): EditPreview {
  const affected: string[] = [];
  const lockConflicts: LockConflict[] = [];
  const alternatives: string[] = [];
  const timing: string[] = [];
  const regenerations: string[] = [];
  const plannedBefore = totalPlannedDuration(project);
  let plannedAfter = plannedBefore;
  let scriptAfter: string | null = null;
  let imageGenerations = 0;
  let invalid = false;

  const named = new Set<string>();

  for (const command of plan.commands) {
    let description: string;
    try {
      description = describeCommand(project, command);
    } catch (error) {
      invalid = true;
      affected.push('A scene that is no longer in the storyboard');
      alternatives.push(
        'Name scenes by their position in the current storyboard, then plan the change again.',
      );
      continue;
    }
    affected.push(description);

    const locks = lockedComponents(project, command);
    if (locks.length > 0) {
      lockConflicts.push({
        message:
          command.kind === 'script.replace'
            ? 'The narration script is locked.'
            : `${description} is locked.`,
        source: 'command',
      });
      alternatives.push(
        command.kind === 'script.replace'
          ? 'Unlock the script yourself, then plan the change again; this app never unlocks it for you.'
          : `Unlock ${locks.join(', ')} on ${description.split(' ').slice(0, 2).join(' ')} yourself, or limit the request to unlocked scenes.`,
      );
      continue;
    }

    if (command.kind === 'scene.visual') {
      named.add(command.sceneId);
      const scene = project.storyboard.scenes[sceneIndex(project, command.sceneId)] as Scene;
      if (scene.imageAssetId) {
        imageGenerations += 1;
        affected.push(`${sceneLabel(project, command.sceneId)} attached image (cleared, kept for undo)`);
      }
      regenerations.push(`Check or regenerate the image for ${sceneLabel(project, command.sceneId)}`);
    } else if (command.kind === 'scene.text') {
      named.add(command.sceneId);
    } else if (command.kind === 'scene.duration') {
      named.add(command.sceneId);
      const scene = project.storyboard.scenes[sceneIndex(project, command.sceneId)] as Scene;
      plannedAfter += command.plannedDuration - scene.plannedDuration;
    } else {
      try {
        const currentNarration: string = scriptAfter ?? project.script.narration;
        const composed: string =
          command.scope === 'all'
            ? command.text.trim()
            : composeScript(
                { ...project, script: { ...project.script, narration: currentNarration } },
                command,
              );
        plannedAfter = plannedAfter - Math.round(estimateRuntimeSeconds(currentNarration)) + Math.round(estimateRuntimeSeconds(composed));
        scriptAfter = composed;
      } catch (error) {
        invalid = true;
        alternatives.push(
          error instanceof Error
            ? `${error.message} Ask for a rewrite of the whole script instead, or regenerate the plan from the current script.`
            : 'The script changed. Plan the change again.',
        );
      }
    }
  }

  const lockedScenes = project.storyboard.scenes.filter((scene) =>
    Object.values(scene.locks).some(Boolean),
  );
  const preserved: string[] = [
    'Brief, source notes, and story notes',
    'Locks are never changed by a plan',
  ];
  const untouchedScenes = project.storyboard.scenes.filter((scene) => !named.has(scene.id));
  if (untouchedScenes.length > 0) {
    preserved.push(
      `Narration, text, timing, and images of ${untouchedScenes.length} other scene${untouchedScenes.length === 1 ? '' : 's'}`,
    );
  }
  const approvedUntouched = untouchedScenes.filter((scene) => scene.status === 'approved');
  if (approvedUntouched.length > 0) {
    preserved.push(
      `Approval of ${approvedUntouched.length} untouched approved scene${approvedUntouched.length === 1 ? '' : 's'}`,
    );
  }
  if (lockedScenes.length > 0) {
    preserved.push(
      `${lockedScenes.length} locked scene${lockedScenes.length === 1 ? '' : 's'} keep${lockedScenes.length === 1 ? 's' : ''} their locked components`,
    );
  }

  const totalAfter = Math.round(plannedAfter);
  const totalBefore = Math.round(plannedBefore);
  if (totalAfter !== totalBefore) {
    timing.push(
      `Planned total ${formatDuration(totalBefore)} → ${formatDuration(totalAfter)} (${totalAfter > totalBefore ? '+' : ''}${totalAfter - totalBefore}s).`,
    );
  } else {
    timing.push(`Planned total stays ${formatDuration(totalBefore)}.`);
  }
  const markedScenes = project.storyboard.scenes.filter((scene) => named.has(scene.id));
  if (markedScenes.length > 0) {
    timing.push(
      `${markedScenes.length} edited scene${markedScenes.length === 1 ? '' : 's'} return to draft until approved again.`,
    );
  }
  if (scriptAfter !== null) {
    timing.push(
      `Narration estimate ${formatDuration(Math.round(estimateRuntimeSeconds(project.script.narration)))} → ${formatDuration(Math.round(estimateRuntimeSeconds(scriptAfter)))}.`,
    );
    regenerations.push('Narration audio (the saved script changed)');
    regenerations.push('Storyboard review (the scene narration no longer reconstructs the script)');
  }
  regenerations.push('Rendered video (composition changed)');

  const narrationCharacters = scriptAfter === null ? 0 : scriptAfter.length;
  const stale = plan.projectFingerprint !== editProjectFingerprint(project);
  if (stale) {
    alternatives.push('The project changed after this plan was made. Plan the change again.');
  }
  if (plan.commands.length === 0) {
    const blocked = plan.blocked ?? [];
    const namedScript = plan.blockedScript === true;
    if (namedScript && project.script.locked) {
      lockConflicts.push({ message: 'The narration script is locked.', source: 'provider' });
      alternatives.push(
        'Unlock the script yourself, then plan the change again; this app never unlocks it for you.',
      );
    }
    for (const target of blocked) {
      const position = project.storyboard.scenes.findIndex((scene) => scene.id === target.sceneId);
      if (position === -1) continue;
      const scene = project.storyboard.scenes[position] as Scene;
      if (!scene.locks[target.component]) continue;
      lockConflicts.push({
        message: `${sceneLabel(project, scene.id)} ${LOCKED_COMPONENT_LABELS[target.component]} is locked.`,
        source: 'provider',
      });
      alternatives.push(
        `Unlock ${target.component} on Scene ${position + 1} yourself, or limit the request to unlocked scenes.`,
      );
    }
    // Only guess from the request when the provider named no target at all.
    const providerNamedTarget = namedScript || blocked.length > 0;
    if (!providerNamedTarget) {
      const inferred = inferLockConflicts(project, plan.request);
      lockConflicts.push(
        ...inferred.conflicts.map((message) => ({ message, source: 'request' as const })),
      );
      alternatives.push(...inferred.alternatives);
    }
    affected.push('Nothing: the plan has no commands');
    alternatives.push('Describe the change in terms of a scene, the script, or on-screen text.');
  }
  if (affected.length === 0) {
    alternatives.push('Describe the change in terms of a scene, the script, or on-screen text.');
  }

  if (
    lockedScenes.length > 0 &&
    alternatives.every((entry) => !entry.startsWith('The plan is limited'))
  ) {
    alternatives.push(
      `The plan is limited to unlocked components: ${lockedScenes
        .map((scene) => scene.title)
        .slice(0, 3)
        .join(', ')} stay as they are.`,
    );
  }

  return {
    affected,
    preserved,
    lockConflicts,
    timing,
    regenerations,
    estimatedUsage: {
      planningRequests: 1,
      narrationCharacters,
      narrationUsd: narrationCharacters > 0 ? estimateNarrationUsd(narrationCharacters) : null,
      imageGenerations,
    },
    stale,
    applicable: !stale && !invalid && lockConflicts.length === 0 && plan.commands.length > 0,
    alternatives: [...new Set(alternatives)],
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function snapshot(project: Project): EditSnapshot {
  return {
    scriptNarration: project.script.narration,
    scenes: project.storyboard.scenes.map((scene) => ({ ...scene, locks: { ...scene.locks } })),
    audio: {
      narration: { ...project.audio.narration },
      music: { ...project.audio.music },
    },
    reviewedScriptFingerprint: project.storyboard.reviewedScriptFingerprint,
    reviewedAt: project.storyboard.reviewedAt,
  };
}

function applyCommand(project: Project, command: EditCommand, now: string): Project {
  if (command.kind === 'script.replace') {
    // Composing from the script before this command keeps chained plan commands honest.
    return replaceScriptNarration(project, composeScript(project, command), {
      archivePrevious: true,
      now,
    });
  }
  if (command.kind === 'scene.visual') {
    return updateScene(
      project,
      command.sceneId,
      { visualDirection: command.visualDirection, imageAssetId: null },
      now,
    );
  }
  if (command.kind === 'scene.text') {
    return updateScene(project, command.sceneId, { onScreenText: command.onScreenText }, now);
  }
  return updateScene(
    project,
    command.sceneId,
    { plannedDuration: command.plannedDuration },
    now,
  );
}

export interface ApplyEditResult {
  project: Project;
  record: EditRecord;
}

/**
 * Apply every command or nothing at all. Locks and freshness are checked first;
 * the returned project is the only write, so a failure leaves the input intact.
 */
export function applyEditPlan(
  project: Project,
  plan: EditPlan,
  options: { now: string; historyLimit?: number },
): ApplyEditResult {
  if (plan.projectFingerprint !== editProjectFingerprint(project)) {
    throw new DomainError(
      'stale-plan',
      'The project changed after this plan was made. Plan the change again before applying it.',
    );
  }
  if (plan.commands.length === 0) throw invalid('The plan has no changes to apply.');
  const preview = previewEditPlan(project, plan);
  if (preview.lockConflicts.length > 0) {
    throw new DomainError(
      'scene-locked',
      preview.lockConflicts.map((conflict) => conflict.message).join(' '),
    );
  }
  if (!preview.applicable) {
    throw invalid(
      preview.alternatives[0] ?? 'That change cannot be applied to the current project.',
    );
  }

  const before = snapshot(project);
  let next = project;
  for (const command of plan.commands) next = applyCommand(next, command, options.now);
  if (next === project) throw invalid('That plan would not change anything.');

  const record: EditRecord = {
    id: newId('edit'),
    request: plan.request.slice(0, MAX_EDIT_REQUEST_CHARS),
    commands: plan.commands.map((command) => command.kind),
    appliedAt: options.now,
    before,
  };
  const historyLimit = Math.max(1, options.historyLimit ?? MAX_EDIT_HISTORY);
  return {
    project: {
      ...next,
      updatedAt: options.now,
      editHistory: [record, ...project.editHistory].slice(0, historyLimit),
    },
    record,
  };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function restoreScenes(current: Project, before: Scene[], now: string): Project {
  const currentIds = current.storyboard.scenes.map((scene) => scene.id).join('|');
  const beforeIds = before.map((scene) => scene.id).join('|');
  if (currentIds !== beforeIds) {
    throw invalid(
      'This edit changed the set of scenes, so it cannot be undone here. Restore the project data export instead.',
    );
  }
  let next = current;
  before.forEach((snapshotScene, index) => {
    const scene = next.storyboard.scenes[index] as Scene;
    const patch = {
      ...(snapshotScene.narration !== scene.narration ? { narration: snapshotScene.narration } : {}),
      ...(snapshotScene.visualDirection !== scene.visualDirection
        ? { visualDirection: snapshotScene.visualDirection }
        : {}),
      ...(snapshotScene.assetType !== scene.assetType ? { assetType: snapshotScene.assetType } : {}),
      ...(snapshotScene.onScreenText !== scene.onScreenText
        ? { onScreenText: snapshotScene.onScreenText }
        : {}),
      ...(snapshotScene.plannedDuration !== scene.plannedDuration
        ? { plannedDuration: snapshotScene.plannedDuration }
        : {}),
      ...(snapshotScene.imageAssetId !== scene.imageAssetId
        ? { imageAssetId: snapshotScene.imageAssetId }
        : {}),
      ...(snapshotScene.imageFraming !== scene.imageFraming
        ? { imageFraming: snapshotScene.imageFraming }
        : {}),
    };
    if (Object.keys(patch).length > 0) next = updateScene(next, scene.id, patch, now);
    if (snapshotScene.status !== scene.status) {
      next = setSceneStatus(next, scene.id, snapshotScene.status, now);
    }
  });
  return next;
}

/**
 * Restore the components one edit changed, through the same lock-checked domain
 * functions. Removing the record bounds the history; older records stay usable.
 */
export function undoEdit(
  project: Project,
  editId: string,
  options: { now: string },
): Project {
  const record = project.editHistory.find((entry) => entry.id === editId);
  if (!record) throw invalid('That edit is no longer in the undo history.');
  const now = options.now;
  let next = project;

  next = restoreScenes(next, record.before.scenes, now);

  if (next.script.narration !== record.before.scriptNarration) {
    next = replaceScriptNarration(next, record.before.scriptNarration, {
      archivePrevious: true,
      now,
    });
  }
  for (const role of ['narration', 'music'] as const) {
    const wanted = record.before.audio[role];
    const current = next.audio[role];
    if (
      current.assetId !== wanted.assetId ||
      current.fileName !== wanted.fileName ||
      current.durationMs !== wanted.durationMs ||
      current.volume !== wanted.volume ||
      current.muted !== wanted.muted ||
      current.generated !== wanted.generated
    ) {
      next = updateAudioTrack(next, role, { ...wanted }, now);
    }
  }

  return {
    ...next,
    updatedAt: now,
    storyboard: {
      ...next.storyboard,
      reviewedScriptFingerprint: record.before.reviewedScriptFingerprint,
      reviewedAt: record.before.reviewedAt,
    },
    editHistory: project.editHistory.filter((entry) => entry.id !== editId),
  };
}
