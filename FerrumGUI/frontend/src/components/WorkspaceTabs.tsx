import type { LucideIcon } from 'lucide-react';

type Tab<T extends string> = { id: T; label: string; icon: LucideIcon; badge?: string };

export function WorkspaceTabs<T extends string>({ tabs, active, onChange, label, prefix, className = '' }: {
  tabs: Tab<T>[]; active: T; onChange: (id: T) => void; label: string; prefix: string; className?: string;
}) {
  return (
    <div className={`workspace-tabs ${className}`} role="tablist" aria-label={label}>
      {tabs.map(({ id, label: tabLabel, icon: Icon, badge }, index) => (
        <button key={id} type="button" role="tab" id={`${prefix}-tab-${id}`} aria-controls={`${prefix}-panel-${id}`}
          aria-selected={active === id} tabIndex={active === id ? 0 : -1} className={active === id ? 'selected' : ''}
          onClick={() => onChange(id)} onKeyDown={(event) => {
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
              : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
            if (next !== null) {
              event.preventDefault();
              onChange(tabs[next].id);
              document.getElementById(`${prefix}-tab-${tabs[next].id}`)?.focus();
            }
          }}>
          <Icon size={17} aria-hidden="true" /><span>{tabLabel}</span>{badge && <span className="tab-badge" aria-hidden="true">{badge}</span>}
        </button>
      ))}
    </div>
  );
}
