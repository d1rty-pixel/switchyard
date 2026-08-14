import { ArrowDownUp, FilterX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { iconFor } from '@/lib/icons';
import { STATE_ORDER, stateStyle } from '@/lib/status';
import { StatusIndicator } from './StatusIndicator';
import type { GroupDefinition, ServiceState } from '@/lib/types';

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

/** Unselected chip, shared by the state and provider toggles. */
const IDLE_CHIP = 'border-line-soft bg-surface/40 text-ink-3 hover:text-ink';

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
  const active = filters.group !== null || filters.states.length > 0 || filters.types.length > 0;

  return (
    <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
      {/* Groups — a single choice, where "All" is the absence of one. */}
      <ToggleGroup
        type="single"
        value={filters.group ?? 'all'}
        onValueChange={(value) => onChange({ ...filters, group: !value || value === 'all' ? null : value })}
        className="flex-wrap gap-1 rounded-xl border border-line bg-surface/50 p-1"
      >
        <Pill value="all">
          All
          <Count value={total} />
        </Pill>
        {groups.map((group) => {
          const count = groupCounts.get(group.id) ?? 0;
          if (count === 0) return null;
          const Icon = iconFor(group.icon);
          return (
            <Pill key={group.id} value={group.id} title={group.description}>
              <Icon className="size-3.5 opacity-70" />
              {group.name}
              <Count value={count} />
            </Pill>
          );
        })}
      </ToggleGroup>

      {/* States */}
      <ToggleGroup
        type="multiple"
        value={filters.states}
        onValueChange={(states) => onChange({ ...filters, states: states as ServiceState[] })}
        className="flex-wrap gap-1"
      >
        {STATE_ORDER.map((state) => {
          const count = stateCounts.get(state) ?? 0;
          if (count === 0 && !filters.states.includes(state)) return null;
          const style = stateStyle(state);
          const selected = filters.states.includes(state);
          return (
            <ToggleGroupItem
              key={state}
              value={state}
              title={style.hint}
              className={cn(
                'h-auto gap-1.5 rounded-lg border px-2 py-1 text-[12.5px]',
                selected ? style.chip : IDLE_CHIP,
              )}
            >
              <StatusIndicator state={state} size={8} />
              {style.label}
              <span className="num text-[11.5px] opacity-70">{count}</span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>

      {/* Providers */}
      {types.length > 1 && (
        <ToggleGroup
          type="multiple"
          value={filters.types}
          onValueChange={(nextTypes) => onChange({ ...filters, types: nextTypes })}
          className="flex-wrap gap-1"
        >
          {types.map((entry) => (
            <ToggleGroupItem
              key={entry.type}
              value={entry.type}
              className={cn(
                'h-auto rounded-lg border px-2 py-1 text-[12.5px]',
                filters.types.includes(entry.type) ? 'border-route/40 bg-route/12 text-route' : IDLE_CHIP,
              )}
            >
              {entry.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      <div className="ml-auto flex items-center gap-2">
        {active && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange({ ...filters, group: null, states: [], types: [] })}
            className="rounded-lg border-line-soft bg-transparent text-[12.5px] text-ink-3 hover:text-ink"
          >
            <FilterX />
            Clear
          </Button>
        )}

        <Select value={filters.sort} onValueChange={(sort) => onChange({ ...filters, sort: sort as SortMode })}>
          <SelectTrigger
            size="sm"
            aria-label="Sort by"
            className="h-auto gap-1.5 rounded-lg border-line bg-surface/50 px-2 py-1 text-[12.5px] text-ink-2"
          >
            <ArrowDownUp className="size-3.5 text-ink-3" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="glass bg-surface-2/97">
            {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {SORT_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="num text-[12px] text-faint">
          {visible === total ? `${total} services` : `${visible} of ${total}`}
        </span>
      </div>
    </div>
  );
}

function Pill({ value, title, children }: { value: string; title?: string; children: React.ReactNode }) {
  return (
    <ToggleGroupItem
      value={value}
      title={title}
      className="h-auto gap-1.5 rounded-lg border-0 bg-transparent px-2.5 py-1 text-[13px] font-medium text-ink-3 hover:text-ink data-[state=on]:bg-surface-3 data-[state=on]:text-ink data-[state=on]:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
    >
      {children}
    </ToggleGroupItem>
  );
}

function Count({ value }: { value: number }) {
  return <span className="num text-[11.5px] text-faint">{value}</span>;
}
