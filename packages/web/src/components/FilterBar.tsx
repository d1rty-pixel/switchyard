import { ArrowDownUp, FilterX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
const IDLE_CHIP = 'border-border bg-card/40 text-muted-foreground hover:text-foreground';

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
        className="flex-wrap gap-1"
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
            <Tooltip key={state}>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value={state}
                  className={cn(
                    'h-auto gap-1.5 rounded-lg border px-2 py-1 text-[12.5px]',
                    selected ? style.chip : IDLE_CHIP,
                  )}
                >
                  <StatusIndicator state={state} size={8} />
                  {style.label}
                  <span className="tabular-nums text-[11.5px] opacity-70">{count}</span>
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>{style.hint}</TooltipContent>
            </Tooltip>
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
                filters.types.includes(entry.type) ? 'border-border bg-secondary text-secondary-foreground' : IDLE_CHIP,
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
            className="rounded-lg border-border bg-transparent text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            <FilterX />
            Clear
          </Button>
        )}

        <Select value={filters.sort} onValueChange={(sort) => onChange({ ...filters, sort: sort as SortMode })}>
          <SelectTrigger
            size="sm"
            aria-label="Sort by"
            className="h-auto gap-1.5 rounded-lg border-border bg-card/50 px-2 py-1 text-[12.5px] text-muted-foreground"
          >
            <ArrowDownUp className="size-3.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" sideOffset={4}>
            {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {SORT_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="tabular-nums text-[12px] text-muted-foreground">
          {visible === total ? `${total} services` : `${visible} of ${total}`}
        </span>
      </div>
    </div>
  );
}

function Pill({ value, title, children }: { value: string; title?: string; children: React.ReactNode }) {
  const item = (
    <ToggleGroupItem
      value={value}
      className="h-auto gap-1.5 rounded-lg border-0 bg-transparent px-2.5 py-1 text-[13px] font-medium text-muted-foreground hover:text-foreground data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
    >
      {children}
    </ToggleGroupItem>
  );

  if (!title) return item;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function Count({ value }: { value: number }) {
  return <span className="tabular-nums text-[11.5px] text-muted-foreground">{value}</span>;
}
