import type { ChartSpec, ResultSet } from '@insightkit/protocol';
import type { CSSProperties, ReactElement } from 'react';
import { BarChart } from './bar.js';
import { formatNumber } from './coerce.js';
import { DataTable, Empty, Frame, Legend, TableFallback, type Theme, useMeasuredWidth } from './frame.js';
import { LineChart } from './line.js';
import { NumberTile } from './number.js';
import { buildPlot, type PlotModel } from './series.js';

const NAMES = { bar: 'Bar chart', line: 'Line chart', area: 'Area chart' } as const;

const describe = (model: PlotModel): string => {
  const head = NAMES[model.kind === 'line' ? 'line' : model.kind === 'area' ? 'area' : 'bar'];
  const series = model.series.length === 1 ? '1 series' : `${formatNumber(model.series.length)} series`;
  const over = `${formatNumber(model.categories.length)} ${model.categories.length === 1 ? 'category' : 'categories'}`;
  const missing = model.unplottable === 0 ? '' : `, ${formatNumber(model.unplottable)} not plottable`;
  return `${model.title === null ? head : `${head}: ${model.title}`}. ${series} over ${over}${missing}.`;
};

export interface ChartProps {
  readonly spec: ChartSpec;
  readonly data: ResultSet;
  readonly truncated?: boolean | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly theme?: Theme | undefined;
}

export const Chart = (props: ChartProps): ReactElement => {
  const model = buildPlot(props.spec, props.data, props.truncated === true);
  const { ref, width } = useMeasuredWidth(640);
  const empty = props.data.rows.length === 0;

  const visual = ((): ReactElement => {
    if (empty) return <Empty message="No rows came back for this question." />;
    if (model.kind === 'table') return <DataTable data={props.data} caption={model.title} />;
    if (model.kind === 'number') return <NumberTile model={model} />;
    if (model.kind === 'bar') return <BarChart model={model} width={width} label={describe(model)} />;
    return <LineChart model={model} width={width} label={describe(model)} />;
  })();

  return (
    <Frame
      title={model.kind === 'table' ? null : model.title}
      notes={model.notes}
      className={props.className}
      style={props.style}
      theme={props.theme}
      state={model.kind}
    >
      {model.kind === 'bar' || model.kind === 'line' || model.kind === 'area' ? (
        <Legend names={model.series.map((one) => one.name)} mark={model.kind === 'bar' ? 'rect' : 'line'} />
      ) : null}
      <div ref={ref}>{visual}</div>
      {model.kind === 'table' ? null : <TableFallback data={props.data} caption={model.title} />}
    </Frame>
  );
};
