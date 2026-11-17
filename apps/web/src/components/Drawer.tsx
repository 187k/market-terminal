import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Side panel over the dashboard (full screen on phones). Escape or a click on the backdrop
 * closes it; focus moves into it on open and back to where it was on close.
 */
export function Drawer({
  title,
  onClose,
  children,
  actions,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
      previous?.focus?.();
    };
  }, []);

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" tabIndex={-1} ref={panel}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <div className="drawer-actions">
            {actions}
            <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </header>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}
