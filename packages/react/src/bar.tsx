import type { ReactElement } from 'react';
import { estimateTextWidth, formatNumber, truncate } from './coerce.js';
import { horizontalBarPath, linearScale, project, round } from './scale.js';
import type { PlotModel } from './series.js';
import { plotValues } from './series.js';

const TICK = 11;

export interface BarChartProps {
  readonly model: PlotModel;
  readonly width: number;
  readonly label: string;
}

/**
 * Horizontal, not columns: a category name comes from a customer's database and may be long or
 * right-to-left, and a horizontal bar gives it a full line rather than a rotated, clipped tick.
 */
export const BarChart = (props: BarChartProps): ReactElement => {
  const { model, width } = props;
  const seriesCount = Math.max(1, model.series.length);
  const rowCount = Math.max(1, model.categories.length);
  // Bars thin as the chart grows so a ranking of thirty stays one card rather than one page.
  const budget = Math.floor(480 / (rowCount * seriesCount)) - 2;
  const thickness = Math.max(4, Math.min(22, Math.round(56 / seriesCount), budget));
  const band = seriesCount * (thickness + 2) - 2;
  const gap = Math.max(6, Math.min(14, Math.round(thickness * 0.8)));
  const labelWidth = Math.max(72, Math.min(200, Math.round(width * 0.32)));
  const plotLeft = labelWidth + 10;
  const plotRight = Math.max(plotLeft + 40, width - 6);
  const top = 6;
  const axisBand = 22;
  const rows = model.categories.length;
  const plotBottom = top + rows * (band + gap) - gap;
  const height = plotBottom + axisBand;
  const scale = linearScale(plotValues(model.series), { includeZero: true, tickCount: 4 });
  const zero = project(0, scale, plotLeft, plotRight);
  const maxChars = Math.max(3, Math.floor(labelWidth / (TICK * 0.56)));

  return (
    <svg className="ik-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={props.label}>
      {scale.ticks.map((tick, index) => {
        const x = round(project(tick, scale, plotLeft, plotRight));
        return (
          <g key={tick}>
            <line className="ik-grid-line" x1={x} x2={x} y1={top} y2={plotBottom} />
            <text
              className="ik-tick"
              x={x}
              y={plotBottom + 14}
              textAnchor={index === 0 ? 'start' : index === scale.ticks.length - 1 ? 'end' : 'middle'}
            >
              {formatNumber(tick)}
            </text>
          </g>
        );
      })}
      <line className="ik-axis-line" x1={round(zero)} x2={round(zero)} y1={top} y2={plotBottom} />
      {model.categories.map((category, row) => {
        const bandTop = top + row * (band + gap);
        return (
          <g key={`${category}-${row}`}>
            <text
              className="ik-tick"
              x={labelWidth}
              y={bandTop + band / 2 + 4}
              textAnchor="end"
              style={{ fill: 'var(--ik-ink-2)' }}
            >
              {truncate(category, maxChars)}
              <title>{category}</title>
            </text>
            {model.series.map((one, index) => {
              const point = one.points[row];
              if (point === undefined || point.value === null) return null;
              const end = project(point.value, scale, plotLeft, plotRight);
              const y = bandTop + index * (thickness + 2);
              const text = formatNumber(point.value);
              const tipX = point.value >= 0 ? end + 6 : end - 6;
              const fits =
                point.value >= 0
                  ? tipX + estimateTextWidth(text, TICK) <= plotRight
                  : tipX - estimateTextWidth(text, TICK) >= plotLeft;
              return (
                <g key={`${one.name}-${index}`}>
                  <path
                    className={`ik-mark ik-c${(index % 8) + 1}`}
                    d={horizontalBarPath(zero, end, y, thickness)}
                  >
                    <title>{`${category} · ${one.name}: ${text}`}</title>
                  </path>
                  {fits ? (
                    <text
                      className="ik-tip"
                      x={round(tipX)}
                      y={y + thickness / 2 + 4}
                      textAnchor={point.value >= 0 ? 'start' : 'end'}
                    >
                      {text}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
};
