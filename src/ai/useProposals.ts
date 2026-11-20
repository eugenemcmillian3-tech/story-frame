import { useCallback, useEffect, useState } from 'react';
import { loadProposals, saveProposals } from './proposalStore';
import type { ProjectProposals } from './types';

export function useProposalStore(projectId: string): {
  proposals: ProjectProposals;
  storageError: string | null;
  commit: (next: ProjectProposals) => void;
  clearStorageError: () => void;
  reset: () => void;
} {
  const [proposals, setProposals] = useState<ProjectProposals>(
    () => loadProposals(projectId).proposals,
  );
  const [storageError, setStorageError] = useState<string | null>(null);

  useEffect(() => {
    const loaded = loadProposals(projectId);
    setProposals(loaded.proposals);
    setStorageError(loaded.error);
  }, [projectId]);

  const commit = useCallback((next: ProjectProposals) => {
    setProposals(next);
    const result = saveProposals(next);
    setStorageError(result.error);
  }, []);

  const reset = useCallback(() => {
    const loaded = loadProposals(projectId);
    setProposals(loaded.proposals);
    setStorageError(loaded.error);
  }, [projectId]);

  return {
    proposals,
    storageError,
    commit,
    clearStorageError: () => setStorageError(null),
    reset,
  };
}
