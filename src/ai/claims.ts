import { AiError } from './types';
import type { AiClaim, AiSourceInput } from './types';

function invalid(message: string): AiError {
  return new AiError('invalid-input', message);
}

export function claimSourceOptions(sources: AiSourceInput[]): AiSourceInput[] {
  return sources.filter((source) => source.excerpt.trim() !== '');
}

/**
 * Attach a user-chosen, verbatim excerpt from a supplied source to a claim.
 * A matching excerpt only proves the supplied text contains it; it does not
 * prove the claim is true or that the source entails it. Conflicting claims
 * stay conflicting so the conflict is not silently papered over.
 */
export function attachClaimSource(
  claim: AiClaim,
  sources: AiSourceInput[],
  sourceId: string,
  excerptText: string,
): AiClaim {
  const source = claimSourceOptions(sources).find((entry) => entry.id === sourceId);
  if (!source) throw invalid('Choose one of the pasted source excerpts.');
  const excerpt = excerptText.trim();
  if (excerpt === '') throw invalid('Paste a verbatim excerpt from the chosen source.');
  if (!source.excerpt.includes(excerpt)) {
    throw invalid('The excerpt must be an exact, verbatim part of that source excerpt.');
  }
  const excerpts = claim.excerpts.some(
    (entry) => entry.sourceId === sourceId && entry.excerpt === excerpt,
  )
    ? claim.excerpts
    : [...claim.excerpts, { sourceId, excerpt }];
  const sourceIds = claim.sourceIds.includes(sourceId)
    ? claim.sourceIds
    : [...claim.sourceIds, sourceId];
  const status = claim.status === 'conflicting' ? 'conflicting' : 'supported';
  return {
    ...claim,
    sourceIds,
    excerpts,
    status,
    resolution: status === 'supported' ? 'supported' : claim.resolution,
  };
}

/** Remove every excerpt a claim cites from one source. */
export function removeClaimSource(claim: AiClaim, sourceId: string): AiClaim {
  const excerpts = claim.excerpts.filter((entry) => entry.sourceId !== sourceId);
  const stillUsed = excerpts.some((entry) => entry.sourceId === sourceId);
  const sourceIds = stillUsed
    ? claim.sourceIds
    : claim.sourceIds.filter((id) => id !== sourceId);
  const status = excerpts.length === 0 && claim.status === 'supported' ? 'missing' : claim.status;
  return {
    ...claim,
    sourceIds,
    excerpts,
    status,
    resolution: status === 'supported' ? 'supported' : null,
  };
}
