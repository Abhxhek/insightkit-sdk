import type { ReactElement } from 'react';
import { estimateTextWidth, formatNumber, truncate } from './coerce.js';
import { linearScale, project, round } from './scale.js';
import type { PlotModel } from './series.js';
import { MARKER_LIMIT, plotValues, segmentsOf } from './series.js';

const TICK = 11;

export interface LineChartProps {
  readonly model: PlotModel;
  readonly width: number;
  readonly label: string;
}

/**
 * The x axis is evenly spaced by row position, never by a parsed date: `2026-09-05` has no
 * timezone, so turning it into an instant here is exactly the off-by-one-day ADR 0007 avoids.
 */
export const LineChart = (props: LineChartProps): ReactElement => {
  const { model, width } = props;
  const area = model.kind === 'area';
  const height = Math.max(160, Math.min(360, Math.round(width * 0.42)));
  const padRight = 14;
  const padTop = 8;
  const padBottom = 24;
  const count = model.categories.length;
  const scale = linearScale(plotValues(model.series), { includeZero: area, tickCount: 4 });
  // The gutter follows the widest tick, because digit grouping is the host's locale, not ours.
  const gutter = scale.ticks.reduce(
    (wide, tick) => Math.max(wide, estimateTextWidth(formatNumber(tick), TICK)),
    0,
  );
  const plotLeft = Math.min(Math.round(width * 0.35), Math.round(gutter) + 14);
  const plotRight = Math.max(plotLeft + 40, width - padRight);
  const plotTop = padTop;
  const plotBottom = height - padBottom;
  const x = (index: number): number =>
    count <= 1 ? (plotLeft + plotRight) / 2 : plotLeft + (index * (plotRight - plotLeft)) / (count - 1);
  const y = (value: number): number => project(value, scale, plotBottom, plotTop);
  const baseline = Math.max(plotTop, Math.min(plotBottom, y(Math.max(scale.min, 0))));
  const tickEvery = Math.max(1, Math.ceil(count / 6));
  const maxChars = Math.max(
    4,
    Math.floor((plotRight - plotLeft) / Math.max(1, count / tickEvery) / (TICK * 0.56)),
  );

  return (
    <svg className="ik-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={props.label}>
      {scale.ticks.map((tick) => {
        const ty = round(y(tick));
        return (
          <g key={tick}>
            <line className="ik-grid-line" x1={plotLeft} x2={plotRight} y1={ty} y2={ty} />
            <text className="ik-tick" x={plotLeft - 8} y={ty + 4} textAnchor="end">
              {formatNumber(tick)}
            </text>
          </g>
        );
      })}
      <line className="ik-axis-line" x1={plotLeft} x2={plotRight} y1={plotBottom} y2={plotBottom} />
      {model.categories.map((category, index) =>
        index % tickEvery === 0 ? (
          <text
            className="ik-tick"
            key={`${category}-${index}`}
            x={round(x(index))}
            y={plotBottom + 15}
            textAnchor={index === 0 ? 'start' : index >= count - 1 ? 'end' : 'middle'}
          >
            {truncate(category, maxChars)}
            <title>{category}</title>
          </text>
        ) : null,
      )}
      {model.series.map((one, index) => {
        const colour = `ik-c${(index % 8) + 1}`;
        const segments = segmentsOf(one.points);
        const last = [...one.points].reverse().find((p) => p.value !== null) ?? null;
        const lastValue = last === null ? null : last.value;
        const lastIndex = last === null ? -1 : one.points.lastIndexOf(last);
        const endText = lastValue === null ? '' : formatNumber(lastValue);
        const endFits =
          lastIndex >= 0 && x(lastIndex) + 6 + estimateTextWidth(endText, TICK) <= plotRight + padRight;
        return (
          <g key={`${one.name}-${index}`}>
            {segments.map((segment) => {
              const coords = segment.values.map(
                (value, offset) => `${round(x(segment.start + offset))},${round(y(value))}`,
              );
              const first = round(x(segment.start));
              const end = round(x(segment.start + segment.values.length - 1));
              return (
                <g key={`${segment.start}`}>
                  {area ? (
                    <path
                      className={`ik-area ${colour}`}
                      d={`M${first},${round(baseline)} L${coords.join(' L')} L${end},${round(baseline)} Z`}
                    />
                  ) : null}
                  <polyline className={`ik-line ${colour}`} points={coords.join(' ')} />
                </g>
              );
            })}
            {count <= MARKER_LIMIT
              ? one.points.map((p, i) =>
                  p.value === null ? null : (
                    <circle
                      className={`ik-mark ik-dot ${colour}`}
                      key={`${p.label}-${i}`}
                      cx={round(x(i))}
                      cy={round(y(p.value))}
                      r={4}
                    >
                      <title>{`${p.label} · ${one.name}: ${formatNumber(p.value)}`}</title>
                    </circle>
                  ),
                )
              : null}
            {endFits && lastIndex >= 0 && lastValue !== null ? (
              <text className="ik-tip" x={round(x(lastIndex)) + 6} y={round(y(lastValue)) - 6}>
                {endText}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
};
