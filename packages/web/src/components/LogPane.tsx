import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, Copy, Loader2, Pause, Play, ScrollText, WrapText } from 'lucide-react';
import clsx from 'clsx';
import { useLogs } from '../lib/hooks';
import { formatClock } from '../lib/format';

const TAIL_OPTIONS = [100, 200, 500, 1000];

/** Log tail viewer: pull-based, with optional 4 s auto-refresh. */
export function LogPane({ serviceId, enabled }: { serviceId: string; enabled: boolean }) {
  const [tail, setTail] = useState(200);
  const [auto, setAuto] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const query = useLogs(serviceId, tail, enabled, auto);
  const lines = query.data?.lines ?? [];

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
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line-soft px-4 py-2">
        <span className="mono mr-auto flex min-w-0 items-center gap-1.5 truncate text-faint">
          <ScrollText className="size-3.5 shrink-0" />
          <span className="truncate">{query.data?.source ?? 'logs'}</span>
        </span>

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
          <p className="text-faint">No log output.</p>
        )}

        {lines.map((line, index) => (
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
        <span className="num">{lines.length} lines</span>
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
