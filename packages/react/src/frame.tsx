import type { Cell, ResultSet } from '@insightkit/protocol';
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { formatNumber, formatValue, isNumericText, toLabel } from './coerce.js';
import { MAX_TABLE_ROWS } from './series.js';
import { ChartStyles } from './styles.js';

export type Theme = 'light' | 'dark' | 'auto';

export interface FrameProps {
  readonly title?: string | null | undefined;
  readonly notes?: readonly string[] | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly theme?: Theme | undefined;
  readonly state?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly children: ReactNode;
}

export const Frame = (props: FrameProps): ReactElement => {
  const notes = props.notes ?? [];
  return (
    <div
      className={props.className === undefined ? 'ik-root' : `ik-root ${props.className}`}
      data-ik-theme={props.theme === undefined || props.theme === 'auto' ? undefined : props.theme}
      data-ik-state={props.state}
      aria-busy={props.busy === true ? true : undefined}
      style={props.style}
    >
      <ChartStyles />
      {props.title === null || props.title === undefined ? null : <p className="ik-title">{props.title}</p>}
      {props.children}
      {notes.map((note) => (
        <p className="ik-note" key={note}>
          <span>{note}</span>
        </p>
      ))}
    </div>
  );
};

/** Measuring before paint keeps a server-rendered chart from flashing at its fallback width. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export const useMeasuredWidth = (fallback: number) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useIsomorphicLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const apply = (): void => {
      const measured = Math.round(node.getBoundingClientRect().width);
      if (measured > 0) setWidth(measured);
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { ref, width };
};

export interface LegendProps {
  readonly names: readonly string[];
  readonly mark: 'rect' | 'line';
}

export const Legend = (props: LegendProps): ReactElement | null => {
  if (props.names.length < 2) return null;
  return (
    <ul className="ik-legend">
      {props.names.map((name, index) => (
        <li key={`${name}-${index}`}>
          <span
            aria-hidden="true"
            className={`${props.mark === 'line' ? 'ik-key' : 'ik-swatch'} ik-b${(index % 8) + 1}`}
          />
          <span>{name}</span>
        </li>
      ))}
    </ul>
  );
};

export const Empty = (props: { readonly message: string }): ReactElement => (
  <p className="ik-empty">{props.message}</p>
);

const TableCell = (props: { readonly cell: Cell }): ReactElement => {
  if (props.cell === null)
    return (
      <td className="ik-nil" aria-label="null">
        —
      </td>
    );
  if (isNumericText(props.cell)) return <td className="ik-num">{formatValue(props.cell)}</td>;
  return <td>{toLabel(props.cell)}</td>;
};

export interface DataTableProps {
  readonly data: ResultSet;
  readonly caption?: string | null | undefined;
  readonly limit?: number | undefined;
}

export const DataTable = (props: DataTableProps): ReactElement => {
  const limit = props.limit ?? MAX_TABLE_ROWS;
  const shown = props.data.rows.slice(0, limit);
  const hidden = props.data.rows.length - shown.length;
  return (
    <div className="ik-table-wrap">
      <table className="ik-table">
        {props.caption === null || props.caption === undefined ? null : <caption>{props.caption}</caption>}
        <thead>
          <tr>
            {props.data.columns.map((column, index) => (
              <th scope="col" key={`${column}-${index}`}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {props.data.columns.map((column, cellIndex) => (
                <TableCell key={`${column}-${cellIndex}`} cell={row[cellIndex] ?? null} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? (
        <p className="ik-note">
          <span>{`Showing the first ${formatNumber(limit)} of ${formatNumber(props.data.rows.length)} rows.`}</span>
        </p>
      ) : null}
      {props.data.rows.length === 0 ? <p className="ik-empty">No rows.</p> : null}
    </div>
  );
};

export const TableFallback = (props: DataTableProps): ReactElement => (
  <details className="ik-details">
    <summary className="ik-summary">Show the data as a table</summary>
    <DataTable {...props} />
  </details>
);
