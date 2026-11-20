import { AiError } from './types';
import type {
  AiAngleSnapshot,
  AiClaim,
  AiClaimExcerpt,
  AiScriptSegment,
  AiSourceInput,
  ClaimStatus,
  ScriptSegmentKind,
  StoryboardProposalScene,
} from './types';
import type { AssetType, TargetDuration } from '../domain/types';

const ASSET_TYPES: readonly AssetType[] = [
  'image',
  'video-clip',
  'diagram',
  'title-card',
  'b-roll',
];
const SEGMENT_KINDS: readonly ScriptSegmentKind[] = ['hook', 'body', 'ending'];
const CLAIM_STATUSES: readonly ClaimStatus[] = ['supported', 'missing', 'conflicting'];

export interface AngleTokens {
  angles: AiAngleSnapshot[];
}

export interface ScriptTokens {
  mode: 'script' | 'outline';
  segments: Array<{ kind: ScriptSegmentKind; text: string; claims: AiClaim[] }>;
  outline: string[];
  missingInformation: string[];
  warnings: string[];
}

export interface StoryboardTokens {
  scenes: Array<{
    title: string;
    narration: string;
    visualDirection: string;
    assetType: AssetType;
    onScreenText: string;
    plannedDuration: number;
  }>;
  warnings: string[];
}

function invalid(message: string): AiError {
  return new AiError('invalid-response', message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${label} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function text(
  source: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
  options: { optional?: boolean } = {},
): string {
  const value = source[key];
  if (value === undefined && options.optional) return '';
  if (typeof value !== 'string') throw invalid(`${label} must be text.`);
  const trimmed = value.trim();
  if (!options.optional && trimmed === '') throw invalid(`${label} is empty.`);
  if (value.length > maxLength) throw invalid(`${label} is too long.`);
  return options.optional ? value : trimmed;
}

function list(
  source: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
  options: { optional?: boolean } = {},
): unknown[] {
  const value = source[key];
  if (value === undefined && options.optional) return [];
  if (!Array.isArray(value)) throw invalid(`${label} must be a list.`);
  if (value.length > maxLength) throw invalid(`${label} has too many items.`);
  return value;
}

function stringList(
  source: Record<string, unknown>,
  key: string,
  label: string,
  maxItems: number,
  maxLength: number,
): string[] {
  return list(source, key, label, maxItems).map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '' || item.length > maxLength) {
      throw invalid(`${label}[${index}] must be short, non-empty text.`);
    }
    return item.trim();
  });
}

/** Whitespace normalization allowed when scene narration reconstructs the script. */
export function normalizeNarrationWhitespace(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

export function parseAngleTokens(value: unknown): AngleTokens {
  const root = record(value, 'Angles response');
  const angles = list(root, 'angles', 'angles', 3);
  if (angles.length !== 3) throw invalid('The provider must return exactly three angles.');
  const parsed = angles.map((item, index) => {
    const angle = record(item, `angles[${index}]`);
    return {
      title: text(angle, 'title', `angles[${index}].title`, 160),
      hook: text(angle, 'hook', `angles[${index}].hook`, 800),
      approach: text(angle, 'approach', `angles[${index}].approach`, 800),
      explanation: text(angle, 'explanation', `angles[${index}].explanation`, 1200),
    };
  });
  const directions = new Set(
    parsed.map((angle) => `${angle.title.toLowerCase()}\n${angle.approach.toLowerCase()}`),
  );
  if (directions.size !== 3) throw invalid('The provider returned angles that are not distinct.');
  return { angles: parsed };
}

function parseClaims(
  source: Record<string, unknown>,
  mode: 'factual' | 'fiction',
  sources: AiSourceInput[],
  label: string,
): AiClaim[] {
  if (mode === 'fiction') {
    const raw = source.claims;
    if (raw !== undefined && (!Array.isArray(raw) || raw.length > 0)) {
      throw invalid('Fiction scripts must not include factual citations.');
    }
    return [];
  }
  const sourceById = new Map(sources.map((entry) => [entry.id, entry]));
  const claims = list(source, 'claims', `${label}.claims`, 20);
  return claims.map((item, index) => {
    const claim = record(item, `${label}.claims[${index}]`);
    const claimText = text(claim, 'text', `${label}.claims[${index}].text`, 1000);
    const statusValue = claim.status;
    if (
      typeof statusValue !== 'string' ||
      !(CLAIM_STATUSES as readonly string[]).includes(statusValue)
    ) {
      throw invalid(`${label}.claims[${index}].status is not a known evidence status.`);
    }
    const status = statusValue as ClaimStatus;
    const sourceIds = list(claim, 'sourceIds', `${label}.claims[${index}].sourceIds`, 10).map(
      (id, idIndex) => {
        if (typeof id !== 'string' || !sourceById.has(id)) {
          throw invalid(
            `${label}.claims[${index}].sourceIds[${idIndex}] does not match a supplied source ID.`,
          );
        }
        return id;
      },
    );
    const excerpts: AiClaimExcerpt[] = list(
      claim,
      'excerpts',
      `${label}.claims[${index}].excerpts`,
      10,
    ).map((entry, excerptIndex) => {
      const excerpt = record(entry, `${label}.claims[${index}].excerpts[${excerptIndex}]`);
      const sourceId = text(
        excerpt,
        'sourceId',
        `${label}.claims[${index}].excerpts[${excerptIndex}].sourceId`,
        200,
      );
      const excerptText = text(
        excerpt,
        'excerpt',
        `${label}.claims[${index}].excerpts[${excerptIndex}].excerpt`,
        1200,
      );
      const source = sourceById.get(sourceId);
      if (!source) {
        throw invalid(
          `${label}.claims[${index}].excerpts[${excerptIndex}] cites an unknown source ID.`,
        );
      }
      if (!source.excerpt.includes(excerptText)) {
        throw invalid(
          `${label}.claims[${index}].excerpts[${excerptIndex}] is not a verbatim part of its supplied excerpt.`,
        );
      }
      return { sourceId, excerpt: excerptText };
    });
    if (status === 'supported' && (sourceIds.length === 0 || excerpts.length === 0)) {
      throw invalid(
        `${label}.claims[${index}] is marked supported but has no source IDs or verbatim excerpts.`,
      );
    }
    return {
      id: `clm_${index + 1}`,
      text: claimText,
      sourceIds: Array.from(new Set(sourceIds)),
      excerpts,
      status,
      note: text(claim, 'note', `${label}.claims[${index}].note`, 800, { optional: true }),
      resolution: status === 'supported' ? 'supported' : null,
    };
  });
}

export function parseScriptTokens(
  value: unknown,
  options: { mode: 'factual' | 'fiction'; sources: AiSourceInput[] },
): ScriptTokens {
  const root = record(value, 'Script response');
  const modeValue = root.mode;
  if (modeValue !== 'script' && modeValue !== 'outline') {
    throw invalid('The provider must return mode "script" or "outline".');
  }
  const warnings = stringList(root, 'warnings', 'warnings', 12, 800);
  if (modeValue === 'outline') {
    if (options.mode === 'fiction') {
      throw invalid('Fiction script requests must return mode "script", not an outline.');
    }
    return {
      mode: 'outline',
      segments: [],
      outline: stringList(root, 'outline', 'outline', 20, 1200),
      missingInformation: stringList(
        root,
        'missingInformation',
        'missingInformation',
        20,
        800,
      ),
      warnings,
    };
  }
  if (options.mode === 'fiction' && options.sources.length > 0) {
    // Source notes are not sent in fiction mode; this guards against a caller mix-up.
    throw invalid('Fiction script requests cannot include source notes.');
  }
  const segmentsRaw = list(root, 'segments', 'segments', 20);
  if (segmentsRaw.length === 0) throw invalid('The script response has no segments.');
  const segments: ScriptTokens['segments'] = segmentsRaw.map((item, index) => {
    const segment = record(item, `segments[${index}]`);
    const kindValue = segment.kind;
    if (
      typeof kindValue !== 'string' ||
      !(SEGMENT_KINDS as readonly string[]).includes(kindValue)
    ) {
      throw invalid(`segments[${index}].kind must be hook, body, or ending.`);
    }
    return {
      kind: kindValue as ScriptSegmentKind,
      text: text(segment, 'text', `segments[${index}].text`, 8000),
      claims: parseClaims(segment, options.mode, options.sources, `segments[${index}]`),
    };
  });
  const narration = segments.map((segment) => segment.text).join('\n\n');
  if (narration.length > 40_000) throw invalid('The generated script is too long.');
  return {
    mode: 'script',
    segments,
    outline: [],
    missingInformation: [],
    warnings,
  };
}

export function scriptNarration(segments: AiScriptSegment[]): string {
  return segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n\n');
}

export function parseStoryboardTokens(value: unknown, script: string): StoryboardTokens {
  const root = record(value, 'Storyboard response');
  const scenesRaw = list(root, 'scenes', 'scenes', 20);
  if (scenesRaw.length === 0) throw invalid('The storyboard response has no scenes.');
  const warnings = stringList(root, 'warnings', 'warnings', 12, 800);
  const scenes = scenesRaw.map((item, index) => {
    const scene = record(item, `scenes[${index}]`);
    for (const forbidden of ['mediaId', 'imageAssetId', 'assetRef', 'url', 'stockUrl']) {
      if (scene[forbidden] !== undefined && scene[forbidden] !== null && scene[forbidden] !== '') {
        throw invalid(`scenes[${index}] must not invent media IDs or URLs.`);
      }
    }
    const visualDirection = text(
      scene,
      'visualDirection',
      `scenes[${index}].visualDirection`,
      4000,
    );
    if (/(?:https?:\/\/|www\.)/i.test(visualDirection)) {
      throw invalid(`scenes[${index}] must not include stock or media URLs.`);
    }
    const assetValue = scene.assetType;
    if (
      typeof assetValue !== 'string' ||
      !(ASSET_TYPES as readonly string[]).includes(assetValue)
    ) {
      throw invalid(`scenes[${index}].assetType is not a supported asset type.`);
    }
    const plannedDuration = scene.plannedDuration;
    if (
      typeof plannedDuration !== 'number' ||
      !Number.isFinite(plannedDuration) ||
      plannedDuration < 1 ||
      plannedDuration > 600
    ) {
      throw invalid(`scenes[${index}].plannedDuration must be between 1 and 600 seconds.`);
    }
    return {
      title: text(scene, 'title', `scenes[${index}].title`, 200),
      narration: text(scene, 'narration', `scenes[${index}].narration`, 8000),
      visualDirection,
      assetType: assetValue as AssetType,
      onScreenText: text(scene, 'onScreenText', `scenes[${index}].onScreenText`, 500, {
        optional: true,
      }),
      plannedDuration: Math.round(plannedDuration),
    };
  });
  const reconstructed = normalizeNarrationWhitespace(
    scenes.map((scene) => scene.narration).join(' '),
  );
  if (reconstructed !== normalizeNarrationWhitespace(script)) {
    throw invalid(
      'Scene narration does not reconstruct the saved script in order. Only whitespace may change.',
    );
  }
  return { scenes, warnings };
}

export function pacingWarnings(
  scenes: Pick<StoryboardProposalScene, 'plannedDuration'>[],
  target: TargetDuration,
): string[] {
  const total = scenes.reduce((sum, scene) => sum + scene.plannedDuration, 0);
  const threshold = Math.max(5, Math.round(target * 0.2));
  const warnings: string[] = [];
  if (Math.abs(total - target) > threshold) {
    warnings.push(
      `Planned total is ${total}s against a ${target}s target (more than ${threshold}s difference).`,
    );
  }
  const shortScenes = scenes.filter((scene) => scene.plannedDuration < 3).length;
  if (shortScenes > 0) {
    warnings.push(`${shortScenes} scene${shortScenes === 1 ? '' : 's'} is under 3 seconds; pacing may feel rushed.`);
  }
  return warnings;
}

export function unresolvedClaims(segments: AiScriptSegment[]): AiClaim[] {
  return segments.flatMap((segment) =>
    segment.claims.filter(
      (claim) => claim.status !== 'supported' && claim.resolution !== 'speculation',
    ),
  );
}

export function scriptHasUnsupportedClaims(segments: AiScriptSegment[]): boolean {
  return unresolvedClaims(segments).length > 0;
}
