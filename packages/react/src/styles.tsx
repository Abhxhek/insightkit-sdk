import type { ReactElement } from 'react';

const LIGHT = `--ik-surface:#fcfcfb;--ik-ink:#0b0b0b;--ik-ink-2:#52514e;--ik-muted:#898781;
--ik-grid:#e1e0d9;--ik-axis:#c3c2b7;--ik-border:rgba(11,11,11,0.10);--ik-wash:rgba(11,11,11,0.04);
--ik-critical:#d03b3b;--ik-warning:#fab219;
--ik-s1:#2a78d6;--ik-s2:#eb6834;--ik-s3:#1baf7a;--ik-s4:#eda100;
--ik-s5:#e87ba4;--ik-s6:#008300;--ik-s7:#4a3aa7;--ik-s8:#e34948;`;

const DARK = `--ik-surface:#1a1a19;--ik-ink:#ffffff;--ik-ink-2:#c3c2b7;--ik-muted:#898781;
--ik-grid:#2c2c2a;--ik-axis:#383835;--ik-border:rgba(255,255,255,0.10);--ik-wash:rgba(255,255,255,0.06);
--ik-critical:#d03b3b;--ik-warning:#fab219;
--ik-s1:#3987e5;--ik-s2:#d95926;--ik-s3:#199e70;--ik-s4:#c98500;
--ik-s5:#d55181;--ik-s6:#008300;--ik-s7:#9085e9;--ik-s8:#e66767;`;

export const INSIGHTKIT_CSS = `
.ik-root{color-scheme:light;${LIGHT}
font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:1.45;
color:var(--ik-ink);background:var(--ik-surface);border:1px solid var(--ik-border);border-radius:10px;
padding:14px 16px 12px;margin:0;box-sizing:border-box;width:100%;max-width:100%;min-width:0;}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .ik-root:not([data-ik-theme="light"]){color-scheme:dark;${DARK}}}
:root[data-theme="dark"] .ik-root:not([data-ik-theme="light"]){color-scheme:dark;${DARK}}
.ik-root[data-ik-theme="dark"]{color-scheme:dark;${DARK}}
.ik-root *{box-sizing:border-box;}
.ik-title{font-size:13px;font-weight:600;color:var(--ik-ink);margin:0 0 2px;}
.ik-sub{font-size:12px;color:var(--ik-ink-2);margin:0 0 10px;}
.ik-note{font-size:12px;color:var(--ik-ink-2);margin:8px 0 0;display:flex;gap:6px;align-items:flex-start;}
.ik-note::before{content:"!";flex:0 0 auto;width:14px;height:14px;border-radius:50%;font-size:10px;
line-height:14px;text-align:center;font-weight:700;color:var(--ik-surface);background:var(--ik-muted);}
.ik-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 8px;padding:0;list-style:none;
font-size:12px;color:var(--ik-ink-2);}
.ik-legend li{display:flex;align-items:center;gap:6px;}
.ik-swatch{width:10px;height:10px;border-radius:2px;flex:0 0 auto;}
.ik-key{width:14px;height:2px;border-radius:1px;flex:0 0 auto;}
.ik-svg{display:block;width:100%;height:auto;overflow:visible;}
.ik-tick{font-size:11px;fill:var(--ik-muted);font-variant-numeric:tabular-nums;}
.ik-tip{font-size:11px;fill:var(--ik-ink-2);font-variant-numeric:tabular-nums;}
.ik-grid-line{stroke:var(--ik-grid);stroke-width:1;shape-rendering:crispEdges;}
.ik-axis-line{stroke:var(--ik-axis);stroke-width:1;shape-rendering:crispEdges;}
.ik-mark{transition:none;}
.ik-mark:hover{filter:brightness(1.08);}
circle.ik-dot{stroke:var(--ik-surface);stroke-width:2;}
polyline.ik-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round;}
path.ik-area{stroke:none;fill-opacity:0.1;}
.ik-c1{fill:var(--ik-s1);stroke:var(--ik-s1);}
.ik-c2{fill:var(--ik-s2);stroke:var(--ik-s2);}
.ik-c3{fill:var(--ik-s3);stroke:var(--ik-s3);}
.ik-c4{fill:var(--ik-s4);stroke:var(--ik-s4);}
.ik-c5{fill:var(--ik-s5);stroke:var(--ik-s5);}
.ik-c6{fill:var(--ik-s6);stroke:var(--ik-s6);}
.ik-c7{fill:var(--ik-s7);stroke:var(--ik-s7);}
.ik-c8{fill:var(--ik-s8);stroke:var(--ik-s8);}
.ik-b1{background:var(--ik-s1);}.ik-b2{background:var(--ik-s2);}.ik-b3{background:var(--ik-s3);}
.ik-b4{background:var(--ik-s4);}.ik-b5{background:var(--ik-s5);}.ik-b6{background:var(--ik-s6);}
.ik-b7{background:var(--ik-s7);}.ik-b8{background:var(--ik-s8);}
.ik-hero{font-size:44px;font-weight:600;letter-spacing:-0.02em;color:var(--ik-ink);margin:2px 0 0;
overflow-wrap:anywhere;}
.ik-hero-label{font-size:12px;color:var(--ik-ink-2);margin:0;}
.ik-details{margin:10px 0 0;}
.ik-summary{font-size:12px;color:var(--ik-ink-2);cursor:pointer;}
.ik-table-wrap{overflow-x:auto;min-width:0;margin-top:8px;}
.ik-table{border-collapse:collapse;width:100%;font-size:12px;}
.ik-table caption{text-align:left;font-weight:600;color:var(--ik-ink);padding-bottom:6px;}
.ik-table th,.ik-table td{text-align:left;padding:5px 10px 5px 0;border-bottom:1px solid var(--ik-grid);
vertical-align:top;overflow-wrap:anywhere;}
.ik-table th{color:var(--ik-ink-2);font-weight:600;white-space:nowrap;}
.ik-table td.ik-num{text-align:right;font-variant-numeric:tabular-nums;padding-right:0;}
.ik-table td.ik-nil{color:var(--ik-muted);}
.ik-empty{color:var(--ik-ink-2);font-size:12px;padding:22px 0;text-align:center;}
.ik-state{display:flex;flex-direction:column;gap:6px;}
.ik-state p{margin:0;}
.ik-state-head{font-weight:600;}
.ik-root[data-ik-state="failed"] .ik-state-head{color:var(--ik-critical);}
.ik-busy{opacity:0.55;}
.ik-retry{align-self:flex-start;margin-top:4px;font:inherit;font-size:12px;color:var(--ik-ink);
background:var(--ik-wash);border:1px solid var(--ik-border);border-radius:6px;padding:4px 10px;cursor:pointer;}
@media (forced-colors:active){.ik-mark,.ik-line{forced-color-adjust:none;}.ik-root{border-color:CanvasText;}}
`;

export const ChartStyles = (): ReactElement => <style>{INSIGHTKIT_CSS}</style>;
