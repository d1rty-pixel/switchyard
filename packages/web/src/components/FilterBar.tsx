import { ArrowDownUp, FilterX } from 'lucide-react';
import clsx from 'clsx';
import { iconFor } from '../lib/icons';
import { STATE_ORDER, stateStyle } from '../lib/status';
import { StatusIndicator } from './StatusIndicator';
import type { GroupDefinition, ServiceState } from '../lib/types';

export type SortMode = 'group' | 'name' | 'status' | 'recent';

export const SORT_LABELS: Record<SortMode, string> = {
  group: 'Group',
  name: 'Name',
  status: 'Status',
  recent: 'Last action',
};

export interface Filters {
  group: string | null;
  states: ServiceState[];
  types: string[];
  sort: SortMode;
}

export interface FilterBarProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  groups: GroupDefinition[];
  groupCounts: Map<string, number>;
  stateCounts: Map<string, number>;
  types: { type: string; label: string }[];
  total: number;
  visible: number;
}

export function FilterBar({
  filters,
  onChange,
  groups,
  groupCounts,
  stateCounts,
  types,
  total,
  visible,
}: FilterBarProps) {
  const toggleState = (state: ServiceState) => {
    const states = filters.states.includes(state)
      ? filters.states.filter((entry) => entry !== state)
      : [...filters.states, state];
    onChange({ ...filters, states });
  };

  const toggleType = (type: string) => {
    const nextTypes = filters.types.includes(type)
      ? filters.types.filter((entry) => entry !== type)
      : [...filters.types, type];
    onChange({ ...filters, types: nextTypes });
  };

  const active = filters.group !== null || filters.states.length > 0 || filters.types.length > 0;

  return (
    <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
      {/* Groups */}
      <div className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-surface/50 p-1">
        <Pill active={filters.group === null} onClick={() => onChange({ ...filters, group: null })}>
          All
          <Count value={total} />
        </Pill>
        {groups.map((group) => {
          const count = groupCounts.get(group.id) ?? 0;
          if (count === 0) return null;
          const Icon = iconFor(group.icon);
          return (
            <Pill
              key={group.id}
              active={filters.group === group.id}
              onClick={() => onChange({ ...filters, group: filters.group === group.id ? null : group.id })}
              title={group.description}
            >
              <Icon className="size-3.5 opacity-70" />
              {group.name}
              <Count value={count} />
            </Pill>
          );
        })}
      </div>

      {/* States */}
      <div className="flex flex-wrap items-center gap-1">
        {STATE_ORDER.map((state) => {
          const count = stateCounts.get(state) ?? 0;
          if (count === 0 && !filters.states.includes(state)) return null;
          const style = stateStyle(state);
          const selected = filters.states.includes(state);
          return (
            <button
              key={state}
              type="button"
              onClick={() => toggleState(state)}
              title={style.hint}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] transition-all',
                selected ? style.chip : 'border-line-soft bg-surface/40 text-muted hover:text-ink',
              )}
            >
              <StatusIndicator state={state} size={8} />
              {style.label}
              <span className="num text-[10.5px] opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Providers */}
      {types.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          {types.map((entry) => (
            <button
              key={entry.type}
              type="button"
              onClick={() => toggleType(entry.type)}
              className={clsx(
                'rounded-lg border px-2 py-1 text-[11.5px] transition-colors',
                filters.types.includes(entry.type)
                  ? 'border-route/40 bg-route/12 text-route'
                  : 'border-line-soft bg-surface/40 text-muted hover:text-ink',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {active && (
          <button
            type="button"
            onClick={() => onChange({ ...filters, group: null, states: [], types: [] })}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-soft px-2 py-1 text-[11.5px] text-muted transition-colors hover:text-ink"
          >
            <FilterX className="size-3.5" />
            Clear
          </button>
        )}

        <label className="flex items-center gap-1.5 rounded-lg border border-line bg-surface/50 px-2 py-1 text-[11.5px] text-muted">
          <ArrowDownUp className="size-3.5" />
          <span className="sr-only">Sort by</span>
          <select
            value={filters.sort}
            onChange={(event) => onChange({ ...filters, sort: event.target.value as SortMode })}
            className="cursor-pointer bg-transparent text-ink-2 focus:outline-none"
          >
            {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
              <option key={mode} value={mode} className="bg-surface text-ink">
                {SORT_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>

        <span className="num text-[12px] text-faint">
          {visible === total ? `${total} services` : `${visible} of ${total}`}
        </span>
      </div>
    </div>
  );
}

function Pill({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] font-medium transition-colors',
        active ? 'bg-surface-3 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]' : 'text-muted hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

function Count({ value }: { value: number }) {
  return <span className="num text-[10.5px] text-faint">{value}</span>;
}
