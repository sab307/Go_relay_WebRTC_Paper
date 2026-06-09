/**
 * modules/chart.js
 * ----------------
 * uPlot latency chart: initialisation, live updates, zoom/pan, dynamic
 * background (white = idle, dark = active twist), and cursor tooltip.
 */

import { CONFIG } from './config.js';
import { state }  from './state.js';

let uplot      = null;
let autoScroll = true;
let uData      = [[], [], [], [], []];

// ── Public API ────────────────────────────────────────────────────────────────

export function initChart() {
    const wrap = document.getElementById('chart');

    // Floating tooltip (appended to <body> so it isn't clipped by overflow:hidden)
    let tooltip = document.getElementById('chartTooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'chartTooltip';
        Object.assign(tooltip.style, {
            display: 'none', position: 'fixed', padding: '8px 12px',
            borderRadius: '6px', border: '1px solid #2a2a3a',
            fontFamily: "'JetBrains Mono', monospace", fontSize: '11px',
            pointerEvents: 'none', zIndex: '9999', whiteSpace: 'nowrap',
            lineHeight: '1.7', transition: 'background 0.2s, border-color 0.2s',
        });
        document.body.appendChild(tooltip);
    }

    const CYAN    = '#00f5d4';
    const MAGENTA = '#f72585';
    const BLUE    = '#4361ee';
    const ORANGE  = '#ff6b35';
    const GRID    = 'rgba(42,42,58,0.6)';
    const TICK    = '#8a8a9a';

    const SERIES_META = [
        { label: 'RTT',         color: CYAN    },
        { label: '→Python',     color: MAGENTA },
        { label: 'Python proc', color: BLUE    },
        { label: '←Python',     color: ORANGE  },
    ];

    const opts = {
        width:  wrap.clientWidth || 800,
        height: 260,
        cursor: {
            show: true, x: true, y: true,
            focus: { prox: 16 },
            drag:  { x: true, y: false, dist: 8, uni: 20 },
        },
        scales: {
            x: { time: false },
            y: { range: (_u, _min, max) => [0, Math.max((max || 0) * 1.15, 10)] },
        },
        axes: [
            {
                stroke: TICK, grid: { stroke: GRID, width: 1 }, ticks: { stroke: GRID, width: 1 }, size: 32,
                values: (u, vals) => {
                    const latest = u.data[0].length ? u.data[0][u.data[0].length - 1] : 0;
                    return vals.map(v => v == null ? '' : `-${(latest - v).toFixed(1)}s`);
                },
            },
            {
                stroke: TICK, grid: { stroke: GRID, width: 1 }, ticks: { stroke: GRID, width: 1 }, size: 52,
                values: (_u, vals) => vals.map(v => v == null ? '' : `${v.toFixed(1)}`),
                label: 'ms', labelSize: 14, labelFont: '11px Space Grotesk', font: '11px Space Grotesk',
            },
        ],
        series: [
            {},
            { label: 'RTT',         stroke: CYAN,    fill: 'rgba(0,245,212,0.07)', width: 2,   value: (_u, v) => v == null ? '--' : `${v.toFixed(2)} ms` },
            { label: '→Python',     stroke: MAGENTA, width: 1.5, value: (_u, v) => v == null ? '--' : `${v.toFixed(2)} ms` },
            { label: 'Python proc', stroke: BLUE,    width: 1.5, value: (_u, v) => v == null ? '--' : `${v.toFixed(2)} ms` },
            { label: '←Python',     stroke: ORANGE,  width: 1.5, value: (_u, v) => v == null ? '--' : `${v.toFixed(2)} ms` },
        ],
        legend: { show: true, live: true },
        hooks: {
            // Dynamic canvas background (destination-over paints behind all series)
            draw: [u => {
                u.ctx.save();
                u.ctx.globalCompositeOperation = 'destination-over';
                u.ctx.fillStyle = state.chartBgActive ? '#12121a' : '#ffffff';
                u.ctx.fillRect(0, 0, u.ctx.canvas.width, u.ctx.canvas.height);
                u.ctx.restore();
            }],
            // Floating cursor tooltip
            setCursor: [u => {
                const { left, top, idx } = u.cursor;
                if (idx == null || idx < 0 || left == null || !u.data[0].length) {
                    tooltip.style.display = 'none'; return;
                }
                const tSec = u.data[0][idx];
                if (tSec == null) { tooltip.style.display = 'none'; return; }
                const latest   = u.data[0][u.data[0].length - 1] ?? tSec;
                const isDark   = state.chartBgActive;
                const valColor  = isDark ? '#e8e8e8' : '#111111';
                const timeColor = isDark ? '#8a8a9a' : '#555555';
                const divider   = isDark ? '#2a2a3a' : '#cccccc';

                let html = `<div style="color:${timeColor};margin-bottom:5px;border-bottom:1px solid ${divider};padding-bottom:4px;">&minus;${(latest - tSec).toFixed(2)}s</div>`;
                for (let s = 0; s < SERIES_META.length; s++) {
                    const v = u.data[s + 1]?.[idx];
                    const valStr = (v != null && !isNaN(v)) ? `${v.toFixed(2)} ms` : '--';
                    html += `<div style="display:flex;justify-content:space-between;gap:16px;">
                        <span style="color:${SERIES_META[s].color}">${SERIES_META[s].label}</span>
                        <span style="color:${valColor};font-weight:600;">${valStr}</span>
                    </div>`;
                }
                tooltip.innerHTML = html;
                tooltip.style.background  = isDark ? 'rgba(10,10,20,0.95)' : 'rgba(248,248,255,0.97)';
                tooltip.style.borderColor = isDark ? '#2a2a3a' : '#bbbbcc';
                tooltip.style.boxShadow   = isDark ? '0 4px 16px rgba(0,0,0,0.6)' : '0 4px 16px rgba(0,0,0,0.15)';

                const cr = u.root.getBoundingClientRect();
                const px = cr.left + u.bbox.left + left;
                const py = cr.top  + u.bbox.top  + (top || 0);
                tooltip.style.display = 'block';
                const ttW = tooltip.offsetWidth || 180, ttH = tooltip.offsetHeight || 100;
                let ttL = px + 14, ttT = py - ttH / 2;
                if (ttL + ttW > window.innerWidth  - 8) ttL = px - ttW - 14;
                if (ttT < 4)                            ttT = 4;
                if (ttT + ttH > window.innerHeight - 4) ttT = window.innerHeight - ttH - 4;
                tooltip.style.left = `${ttL}px`;
                tooltip.style.top  = `${ttT}px`;
            }],
            setSelect: [() => { autoScroll = false; }],
        },
    };

    uplot = new uPlot(opts, uData, wrap);

    wrap.addEventListener('mouseleave', () => {
        const tt = document.getElementById('chartTooltip');
        if (tt) tt.style.display = 'none';
    });

    // Scroll-wheel zoom
    wrap.addEventListener('wheel', e => {
        e.preventDefault();
        if (!uplot) return;
        autoScroll = false;
        const xMin = uplot.scales.x.min, xMax = uplot.scales.x.max;
        const range  = xMax - xMin;
        const factor = e.deltaY < 0 ? 0.75 : 1.33;
        const rect   = uplot.root.getBoundingClientRect();
        const pct    = Math.max(0, Math.min(1, (e.clientX - rect.left - uplot.bbox.left) / uplot.bbox.width));
        const center = xMin + pct * range;
        const nr     = range * factor;
        uplot.setScale('x', { min: center - pct * nr, max: center + (1 - pct) * nr });
    }, { passive: false });

    new ResizeObserver(() => {
        if (uplot) uplot.setSize({ width: wrap.clientWidth, height: 260 });
    }).observe(wrap);
}

export function resetZoom() {
    autoScroll = true;
    if (!uplot || !uData[0].length) return;
    const latest = uData[0][uData[0].length - 1];
    uplot.setScale('x', { min: latest - CONFIG.chartWindowSec, max: latest });
}

/**
 * Switch the chart between idle (white) and active (dark) background
 * and update the IDLE / ACTIVE badge in the panel header.
 */
export function setChartActive(active) {
    state.chartBgActive = active;
    const badge = document.getElementById('chartStateBadge');
    if (badge) {
        badge.className = `chart-state-badge ${active ? 'active' : 'idle'}`;
        badge.innerHTML = `<span class="chart-state-dot"></span>${active ? 'ACTIVE' : 'IDLE'}`;
    }
    if (uplot) uplot.redraw(true);
}

export function updateChart(lat, nowMs) {
    if (!uplot) return;
    const t      = nowMs / 1000;
    const cutoff = t - CONFIG.chartWindowSec;

    uData[0].push(t);
    uData[1].push(lat.rtt);
    uData[2].push(lat.toPython);
    uData[3].push(lat.pythonMs);
    uData[4].push(lat.fromPython);

    let start = 0;
    while (start < uData[0].length && uData[0][start] < cutoff) start++;
    if (start > 0) uData = uData.map(arr => arr.slice(start));

    if (autoScroll) {
        uplot.setData(uData, false);
        uplot.setScale('x', { min: cutoff, max: t });
    } else {
        uplot.setData(uData, false);
    }
}