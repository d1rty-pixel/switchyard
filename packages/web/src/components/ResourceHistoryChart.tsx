import { useMemo, useState } from 'react';
import type { ResourceHistoryBucket, ResourceMetric } from '@/lib/types';
import { formatClock, formatResource } from '@/lib/format';
import { RESOURCE_METRIC_INFO } from '@/lib/resources';

const WIDTH = 280;
const HEIGHT = 64;

interface Point {
  bucket: ResourceHistoryBucket;
  average: number;
  max: number;
}

/** One metric's timeline: average line, max as a lighter ceiling, hover crosshair. */
function MetricChart({ metric, buckets }: { metric: ResourceMetric; buckets: ResourceHistoryBucket[] }) {
  const info = RESOURCE_METRIC_INFO[metric];
  const [hover, setHover] = useState<number | null>(null);

  const points = useMemo<Point[]>(
    () =>
      buckets.map((bucket) => {
        const value = bucket.values[metric];
        return { bucket, average: value?.average ?? 0, max: value?.max ?? 0 };
      }),
    [buckets, metric],
  );

  const domainMax = useMemo(() => {
    const observed = Math.max(0, ...points.map((point) => point.max));
    // Headroom keeps a flat-line series from hugging the top edge.
    return observed > 0 ? observed * 1.15 : 1;
  }, [points]);

  const stepX = points.length > 1 ? WIDTH / (points.length - 1) : WIDTH;
  const y = (value: number) => HEIGHT - (Math.min(value, domainMax) / domainMax) * HEIGHT;

  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${index * stepX},${y(point.average)}`).join(' ');
  const areaPath =
    points.length > 0
      ? `${linePath} L${(points.length - 1) * stepX},${HEIGHT} L0,${HEIGHT} Z`
      : '';

  const active = hover !== null ? points[hover] : undefined;
  const latest = points[points.length - 1];

  return (
    <div className="rounded-lg border border-border bg-muted/40 px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] text-muted-foreground">{info.label}</span>
        <span className="tabular-nums text-[13px] font-medium text-foreground">
          {active ? formatResource(active.average, info.unit) : latest ? formatResource(latest.average, info.unit) : '—'}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="mt-1.5 h-16 w-full touch-none"
        onPointerMove={(event) => {
          if (points.length === 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const fraction = (event.clientX - rect.left) / rect.width;
          const index = Math.round(fraction * (points.length - 1));
          setHover(Math.min(points.length - 1, Math.max(0, index)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {points.length > 1 && (
          <>
            <path d={areaPath} fill="var(--tone-info)" fillOpacity={0.12} stroke="none" />
            <path d={linePath} fill="none" stroke="var(--tone-info)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {active && (
          <>
            <line x1={hover! * stepX} x2={hover! * stepX} y1={0} y2={HEIGHT} stroke="var(--border)" strokeWidth={1} />
            <circle cx={hover! * stepX} cy={y(active.average)} r={3} fill="var(--tone-info)" />
          </>
        )}
      </svg>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {active
          ? `${formatClock(active.bucket.at)} · avg ${formatResource(active.average, info.unit)} · peak ${formatResource(active.max, info.unit)}`
          : points.length > 1
            ? `${formatClock(points[0]?.bucket.at)} – ${formatClock(latest?.bucket.at)}`
            : 'Not enough samples yet.'}
      </p>
    </div>
  );
}

/** Timeline graph for each metric the service currently reports. Replaces the flat snapshot view. */
export function ResourceHistoryChart({ metrics, buckets }: { metrics: ResourceMetric[]; buckets: ResourceHistoryBucket[] }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {metrics.map((metric) => (
        <MetricChart key={metric} metric={metric} buckets={buckets} />
      ))}
    </div>
  );
}
