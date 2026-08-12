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
import clsx from 'clsx';
import { useLogs } from '../lib/hooks';
import { formatClock } from '../lib/format';
import type { ChildStatus } from '../lib/types';

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
  const [pickerOpen, setPickerOpen] = useState(false);
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
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line-soft px-4 py-2">
        <span className="mono flex min-w-0 items-center gap-1.5 truncate text-faint">
          <ScrollText className="size-3.5 shrink-0" />
          <span className="truncate">{query.data?.source ?? 'logs'}</span>
        </span>

        <div className="ml-2 flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line bg-surface-2/60 px-2 py-1">
          <Search className="size-3.5 shrink-0 text-faint" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter lines…"
            aria-label="Filter log lines"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink placeholder:text-faint focus:outline-none"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter('')}
              aria-label="Clear filter"
              className="rounded p-0.5 text-faint hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {containerOptions.length > 1 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setPickerOpen((value) => !value)}
              aria-label="Filter by container"
              className={clsx(
                'flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px] transition-colors',
                containers.length > 0
                  ? 'border-signal/35 bg-signal/12 text-signal'
                  : 'border-line bg-surface-2/60 text-muted hover:text-ink',
              )}
            >
              <Boxes className="size-3.5" />
              {containers.length > 0 ? `${containers.length} / ${containerOptions.length}` : 'All containers'}
            </button>

            {pickerOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setPickerOpen(false)} />
                <div className="absolute right-0 z-20 mt-1.5 min-w-[180px] rounded-lg border border-line bg-surface-2 p-1 shadow-lg">
                  <button
                    type="button"
                    onClick={() => setContainers([])}
                    className="flex w-full items-center rounded-md px-2 py-1 text-left text-[12.5px] text-muted hover:bg-surface-3 hover:text-ink"
                  >
                    All containers
                  </button>
                  <div className="my-1 border-t border-line-soft" />
                  {containerOptions.map((option) => {
                    const checked = containers.includes(option.value);
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() =>
                          setContainers((current) =>
                            checked ? current.filter((value) => value !== option.value) : [...current, option.value],
                          )
                        }
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-ink hover:bg-surface-3"
                      >
                        <span
                          className={clsx(
                            'flex size-3.5 shrink-0 items-center justify-center rounded border',
                            checked ? 'border-signal bg-signal text-white' : 'border-line',
                          )}
                        >
                          {checked && <Check className="size-2.5" />}
                        </span>
                        <span className="min-w-0 truncate">{option.label}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex items-center rounded-lg border border-line bg-surface-2/60 p-0.5">
          {TAIL_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTail(option)}
              className={clsx(
                'num rounded-md px-1.5 py-0.5 text-[12px] transition-colors',
                tail === option ? 'bg-surface-3 text-ink' : 'text-muted hover:text-ink',
              )}
            >
              {option}
            </button>
          ))}
        </div>

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
        className="mono min-h-0 flex-1 overflow-auto bg-base/60 px-4 py-3 leading-[1.65] text-ink-2"
      >
        {query.isPending && (
          <p className="flex items-center gap-2 text-faint">
            <Loader2 className="size-3.5 animate-spin" /> reading logs…
          </p>
        )}

        {query.isError && (
          <p className="text-st-failed">
            {(query.error as Error).message}
          </p>
        )}

        {!query.isPending && !query.isError && lines.length === 0 && (
          <p className="text-faint">{needle ? 'No lines match the filter.' : 'No log output.'}</p>
        )}

        {lines.map(({ line, index }) => (
          <div
            key={`${index}-${line.slice(0, 24)}`}
            className={clsx(
              'group flex gap-3',
              !wrap && 'whitespace-pre',
              wrap && 'whitespace-pre-wrap break-words',
              /\b(error|fatal|panic|failed|denied)\b/i.test(line) && 'text-st-failed/90',
              /\b(warn|warning|deprecated)\b/i.test(line) && 'text-st-degraded/90',
            )}
          >
            <span className="num w-8 shrink-0 select-none text-right text-faint/50">{index + 1}</span>
            <span className="min-w-0">{line || ' '}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-line-soft px-4 py-1.5 text-[11.5px] text-faint">
        <span className="num">{needle ? `${lines.length} / ${allLines.length} lines` : `${lines.length} lines`}</span>
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
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={clsx(
        'rounded-lg border p-1.5 transition-colors',
        active
          ? 'border-signal/35 bg-signal/12 text-signal'
          : 'border-line bg-surface-2/60 text-muted hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
