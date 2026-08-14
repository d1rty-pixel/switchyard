import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Boxes,
  Check,
  Copy,
  Loader2,
  Pause,
  Play,
  ScrollText,
  Search,
  WrapText,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { useLogs } from '@/lib/hooks';
import { formatClock } from '@/lib/format';
import type { ChildStatus } from '@/lib/types';

const TAIL_OPTIONS = [100, 200, 500, 1000];

export interface LogContainerOption {
  /** Value sent to the API — the compose service key when there is one, else the display name. */
  value: string;
  label: string;
}

export function containerOptionsFrom(children: ChildStatus[]): LogContainerOption[] {
  return children.map((child) => ({ value: child.service ?? child.name, label: child.name }));
}

/** Log tail viewer: pull-based, with optional 4 s auto-refresh. */
export function LogPane({
  serviceId,
  enabled,
  containerOptions = [],
}: {
  serviceId: string;
  enabled: boolean;
  containerOptions?: LogContainerOption[];
}) {
  const [tail, setTail] = useState(200);
  const [auto, setAuto] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState('');
  const [containers, setContainers] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // A container that disappears from the stack (recreated, scaled down) should
  // not keep silently filtering logs down to nothing.
  useEffect(() => {
    const known = new Set(containerOptions.map((option) => option.value));
    setContainers((current) => current.filter((value) => known.has(value)));
  }, [containerOptions]);

  const query = useLogs(serviceId, tail, enabled, auto, containers);
  const allLines = query.data?.lines ?? [];

  // Client-side substring filter — the tail is already capped server-side, so
  // there is nothing to gain from pushing this to the API.
  const needle = filter.trim().toLowerCase();
  // Keep each surviving line's position in the unfiltered tail, so the
  // gutter still reads as "line N of the fetched output" rather than
  // renumbering from 1 whenever the filter narrows the view.
  const lines = useMemo(
    () =>
      allLines
        .map((line, index) => ({ line, index }))
        .filter((entry) => !needle || entry.line.toLowerCase().includes(needle)),
    [allLines, needle],
  );

  useEffect(() => {
    const element = scroller.current;
    if (!element || !pinnedToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [lines.length, query.dataUpdatedAt]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.map((entry) => entry.line).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        <span className="font-mono flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
          <ScrollText className="size-3.5 shrink-0" />
          <span className="truncate">{query.data?.source ?? 'logs'}</span>
        </span>

        <div className="ml-2 flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2 py-1">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter lines…"
            aria-label="Filter log lines"
            className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[12.5px] text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          />
          {filter && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setFilter('')}
              aria-label="Clear filter"
              className="text-muted-foreground hover:bg-transparent hover:text-foreground"
            >
              <X />
            </Button>
          )}
        </div>

        {containerOptions.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-label="Filter by container"
                className={cn(
                  'rounded-lg border text-[12px]',
                  containers.length > 0
                    ? 'border-primary/35 bg-primary/12 text-primary'
                    : 'border-border bg-muted/60 text-muted-foreground hover:text-foreground',
                )}
              >
                <Boxes />
                {containers.length > 0 ? `${containers.length} / ${containerOptions.length}` : 'All containers'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem onSelect={() => setContainers([])}>All containers</DropdownMenuItem>
              <DropdownMenuSeparator />
              {containerOptions.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={containers.includes(option.value)}
                  // Keep the menu open: picking containers is usually several
                  // clicks, and a menu that closes on each one makes that work.
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) =>
                    setContainers((current) =>
                      checked ? [...current, option.value] : current.filter((value) => value !== option.value),
                    )
                  }
                >
                  <span className="min-w-0 truncate">{option.label}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <ToggleGroup
          type="single"
          value={String(tail)}
          onValueChange={(value) => value && setTail(Number(value))}
          className="rounded-lg border border-border bg-muted/60 p-0.5"
        >
          {TAIL_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option}
              value={String(option)}
              className="tabular-nums h-auto rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-muted-foreground hover:text-foreground data-[state=on]:bg-secondary data-[state=on]:text-foreground"
            >
              {option}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <IconToggle active={auto} onClick={() => setAuto((value) => !value)} label={auto ? 'Pause auto-refresh' : 'Resume auto-refresh'}>
          {auto ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </IconToggle>
        <IconToggle active={wrap} onClick={() => setWrap((value) => !value)} label="Toggle line wrapping">
          <WrapText className="size-3.5" />
        </IconToggle>
        <IconToggle
          active={false}
          onClick={() => {
            pinnedToBottom.current = true;
            const element = scroller.current;
            if (element) element.scrollTop = element.scrollHeight;
          }}
          label="Jump to newest"
        >
          <ArrowDownToLine className="size-3.5" />
        </IconToggle>
        <IconToggle active={copied} onClick={copy} label="Copy log tail">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </IconToggle>
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="font-mono min-h-0 flex-1 overflow-auto bg-muted px-4 py-3 leading-[1.65] text-muted-foreground"
      >
        {query.isPending && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> reading logs…
          </p>
        )}

        {query.isError && (
          <p className="text-bad">
            {(query.error as Error).message}
          </p>
        )}

        {!query.isPending && !query.isError && lines.length === 0 && (
          <p className="text-muted-foreground">{needle ? 'No lines match the filter.' : 'No log output.'}</p>
        )}

        {lines.map(({ line, index }) => (
          <div
            key={`${index}-${line.slice(0, 24)}`}
            className={cn(
              'group flex gap-3',
              !wrap && 'whitespace-pre',
              wrap && 'whitespace-pre-wrap break-words',
              /\b(error|fatal|panic|failed|denied)\b/i.test(line) && 'text-bad/90',
              /\b(warn|warning|deprecated)\b/i.test(line) && 'text-warn/90',
            )}
          >
            <span className="tabular-nums w-8 shrink-0 select-none text-right text-muted-foreground/50">{index + 1}</span>
            <span className="min-w-0">{line || ' '}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-1.5 text-[11.5px] text-muted-foreground">
        <span className="tabular-nums">{needle ? `${lines.length} / ${allLines.length} lines` : `${lines.length} lines`}</span>
        <span className="flex items-center gap-2">
          {query.isFetching && <Loader2 className="size-3 animate-spin" />}
          updated {formatClock(query.data?.fetchedAt)}
        </span>
      </div>
    </div>
  );
}

function IconToggle({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="icon-sm"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'rounded-lg border',
        active ? 'border-primary/35 bg-primary/12 text-primary' : 'border-border bg-muted/60 text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </Button>
  );
}
