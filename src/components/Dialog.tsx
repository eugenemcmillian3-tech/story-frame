import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getAttribute('aria-hidden') !== 'true',
  );
}

export function Dialog({
  title,
  description,
  children,
  actions,
  onDismiss,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog) {
      const [first] = focusableWithin(dialog);
      (first ?? dialog).focus();
    }
    return () => {
      // Hand focus back to whatever opened the dialog, not to the page body.
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = focusableWithin(dialog);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        // Nothing to tab to: keep the dialog itself focused.
        event.preventDefault();
        dialog.focus();
        return;
      }

      const active = document.activeElement;
      const inside = active instanceof HTMLElement && dialog.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="dialog-body">
          <h2>{title}</h2>
          {description ? <p className="dialog-description">{description}</p> : null}
          {children}
        </div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  );
}
