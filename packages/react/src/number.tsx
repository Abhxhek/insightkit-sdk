import type { ReactElement } from 'react';
import { formatValue } from './coerce.js';
import type { PlotModel } from './series.js';

export interface NumberTileProps {
  readonly model: PlotModel;
}

export const NumberTile = (props: NumberTileProps): ReactElement => {
  const series = props.model.series[0];
  const point = series?.points[0];
  const label = series?.name ?? props.model.xLabel ?? '';
  const category = point === undefined || point.label === '1' ? null : point.label;
  return (
    <div className="ik-state">
      {label === '' ? null : <p className="ik-hero-label">{label}</p>}
      <p className="ik-hero">{point === undefined ? '—' : formatValue(point.raw)}</p>
      {category === null ? null : <p className="ik-hero-label">{category}</p>}
    </div>
  );
};
