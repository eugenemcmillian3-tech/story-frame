import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QuotaMeter } from '../src/components/AiQuota';

afterEach(cleanup);

function normalize(element: HTMLElement): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('AI quota meter', () => {
  it('shows what is left in both windows', () => {
    render(
      <QuotaMeter
        quota={{
          daily: { used: 4, limit: 40, remaining: 36 },
          minute: { used: 2, limit: 6, remaining: 4 },
        }}
      />,
    );
    expect(normalize(screen.getByRole('status'))).toBe(
      'AI budget: 36 of 40 left today · 4 of 6 left this minute.',
    );
  });

  it('shows zero instead of hiding an exhausted window', () => {
    render(
      <QuotaMeter
        quota={{
          daily: { used: 40, limit: 40, remaining: 0 },
          minute: { used: 6, limit: 6, remaining: 0 },
        }}
      />,
    );
    const text = normalize(screen.getByRole('status'));
    expect(text).toContain('0 of 40 left today');
    expect(text).toContain('0 of 6 left this minute');
  });

  it('renders nothing until the budget is known', () => {
    const { container } = render(<QuotaMeter quota={null} />);
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
