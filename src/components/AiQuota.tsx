import { useCallback, useEffect, useState } from 'react';
import { fetchQuota } from '../ai/api';
import type { AiQuota } from '../ai/api';

/** Reads the AI budget when the planner opens; callers refresh it after a request. */
export function useAiQuota(): { quota: AiQuota | null; refresh: () => void } {
  const [quota, setQuota] = useState<AiQuota | null>(null);
  const refresh = useCallback(() => {
    fetchQuota()
      .then(setQuota)
      .catch(() => {
        // The budget line is informative only; generation reports its own errors.
      });
  }, []);
  useEffect(refresh, [refresh]);
  return { quota, refresh };
}

export function QuotaMeter({ quota }: { quota: AiQuota | null }) {
  if (!quota) return null;
  return (
    <p className="muted-small ai-quota" role="status">
      AI budget: <strong>{quota.daily.remaining}</strong> of {quota.daily.limit} left today ·{' '}
      <strong>{quota.minute.remaining}</strong> of {quota.minute.limit} left this minute.
    </p>
  );
}
