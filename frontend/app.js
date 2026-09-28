import { DAY, dayKey, stamp, shortDate, time, duration, overdue, recordedDays, dailyRows, intervals, names } from './data.mjs';

const $ = id => document.getElementById(id);
const set = (id, value) => { $(id).textContent = value; };
const svgNS = 'http://www.w3.org/2000/svg';
let data;
let selectedDay;
let fetching = false;
let fetchFailed = false;

function svgNode(name, attrs, value) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
  if (value != null) node.textContent = value;
  return node;
}

function tableMessage(id, columns, message) {
  const body = $(id);
  body.replaceChildren();
  const cell = body.insertRow().insertCell();
  cell.colSpan = columns;
  cell.textContent = message;
}

function cells(body, values) {
  const row = body.insertRow();
  values.forEach(value => { row.insertCell().textContent = value; });
  return row;
}

function currentState(now) {
  const current = data.current;
  const stale = overdue(current, now);
  const state = !current ? 'unrecorded' : stale ? 'stale' : current.status;
  set('status', !current ? 'No checks yet' : stale ? 'Check overdue' : names[state] ?? 'Unknown');
  $('status').className = `condition ${state}`;
  set('last-check', stamp(current?.observed_at));
  set('raw-status', current?.raw_status ?? '—');
}

function statistics() {
  const totals = data.totals;
  const days = recordedDays(data);
  set('record-span', days ? `${shortDate(data.first_check_at)}–${shortDate(data.current.scheduled_at)} · ${days} calendar day${days === 1 ? '' : 's'}` : 'No recorded history');
  set('total-outages', days ? totals.outage_count : '—');
  set('average-day', days ? (totals.outage_count / days).toFixed(1) : '—');
  set('recoveries', days ? totals.recovered_count ?? 0 : '—');
  set('average-duration', totals.recovered_count ? duration(totals.recovered_seconds / totals.recovered_count) : '—');
  set('longest-duration', duration(totals.longest_seconds));
  set('total-duration', totals.recovered_count ? duration(totals.recovered_seconds) : '—');
}

function describeDay(row) {
  const date = shortDate(`${row.day}T12:00:00+06:00`);
  return !row.recorded ? `${date} · ${row.record}`
    : `${date} · ${row.outage_count} outage${row.outage_count === 1 ? '' : 's'}`;
}

function daily(now) {
  const rows = dailyRows(data, Number($('days').value), now);
  const values = rows.map(row => row.recorded ? row.outage_count : 0);
  const peak = Math.max(1, ...values);
  const magnitude = 10 ** Math.floor(Math.log10(peak / 4));
  const step = Math.max(1, Math.ceil(([1, 2, 2.5, 5, 10].find(value => value * magnitude >= peak / 4) ?? 10) * magnitude));
  const ceiling = Math.ceil(peak / step) * step;
  const tickCount = Math.round(ceiling / step);
  const host = $('chart');
  const focusedDay = host.contains(document.activeElement) ? document.activeElement.getAttribute('data-day') : null;
  const width = Math.max(300, host.clientWidth);
  const height = 242;
  const left = 38, top = 12, bottom = 207, right = width - 8;
  const cell = (right - left) / rows.length;
  const chart = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': 'Detected outages by day. Select a day for figures.' });

  // Blank time before/after available records is explicitly different from zero.
  rows.forEach((row, i) => {
    if (!row.recorded) chart.append(svgNode('rect', { x: left + i * cell, y: top, width: cell, height: bottom - top, class: 'unrecorded-area' }));
  });
  for (let i = 0; i <= tickCount; i++) {
    const y = bottom - i * (bottom - top) / tickCount;
    chart.append(svgNode('line', { x1: left, x2: right, y1: y, y2: y, class: i ? 'grid' : 'axis' }));
    chart.append(svgNode('text', { x: left - 9, y: y + 4, 'text-anchor': 'end' }, i * step));
  }
  if (selectedDay && !rows.some(row => row.day === selectedDay)) selectedDay = null;
  const activate = (row, group) => {
    selectedDay = row.day;
    chart.querySelectorAll('[aria-pressed]').forEach(node => node.setAttribute('aria-pressed', String(node === group)));
    set('day-readout', describeDay(row));
    $('day-readout').hidden = false;
  };
  rows.forEach((row, i) => {
    const x = left + i * cell;
    const group = svgNode('g', { class: 'day', tabindex: '0', role: 'button', 'data-day': row.day, 'aria-label': describeDay(row), 'aria-pressed': String(row.day === selectedDay) });
    const barHeight = values[i] / ceiling * (bottom - top);
    if (row.recorded && values[i] > 0) group.append(svgNode('rect', { x: x + cell * .22, y: bottom - barHeight, width: cell * .56, height: barHeight, class: 'bar' }));
    if (row.recorded && !values[i]) group.append(svgNode('line', { x1: x + cell * .35, x2: x + cell * .65, y1: bottom, y2: bottom, class: 'axis' }));
    if (!row.recorded && (rows.length === 7 || i % 5 === 0)) group.append(svgNode('text', { x: x + cell / 2, y: bottom - 7, 'text-anchor': 'middle', class: 'unrecorded-label' }, '—'));
    group.append(svgNode('rect', { x: x + 1, y: top, width: Math.max(1, cell - 2), height: bottom - top, class: 'hit' }));
    group.addEventListener('click', () => activate(row, group));
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(row, group); }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const groups = [...chart.querySelectorAll('.day')];
        const next = groups[i + (event.key === 'ArrowRight' ? 1 : -1)];
        next?.focus();
      }
    });
    chart.append(group);
    const stride = rows.length === 7 && width >= 500 ? 1 : rows.length === 7 ? 2 : width >= 600 ? 5 : 10;
    if (i % stride === 0 || i === rows.length - 1) {
      // Suppress a penultimate label if it would collide with the final date.
      if (i !== rows.length - 1 && rows.length - 1 - i < stride) return;
      chart.append(svgNode('text', { x: x + cell / 2, y: bottom + 24, 'text-anchor': rows.length === 7 ? 'middle' : i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle' }, shortDate(`${row.day}T12:00:00+06:00`)));
    }
  });
  host.replaceChildren(chart);
  if (focusedDay) chart.querySelector(`[data-day="${focusedDay}"]`)?.focus({ preventScroll: true });
  const selected = rows.find(row => row.day === selectedDay);
  set('day-readout', selected ? describeDay(selected) : '');
  $('day-readout').hidden = !selected;
  $('chart-key').hidden = !rows.some(row => !row.recorded);
  const body = $('daily-rows');
  body.replaceChildren();
  rows.toReversed().forEach(row => {
    const tr = cells(body, [shortDate(`${row.day}T12:00:00+06:00`), row.recorded ? row.outage_count : '—', row.record]);
    tr.cells[1].className = 'number';
  });
}

function history(now) {
  const hours = Number($('hours').value);
  const periods = intervals(data, hours, now);
  const host = $('timeline');
  host.replaceChildren();
  periods.forEach(period => {
    const block = document.createElement('span');
    block.className = `segment ${period.status}`;
    block.style.width = `${100 * (period.end - period.start) / (hours * 3600000)}%`;
    block.title = `${names[period.status]}: ${stamp(period.start)} to ${stamp(period.end)}`;
    host.append(block);
  });
  host.setAttribute('role', 'img');
  host.setAttribute('aria-label', `${hours}-hour connection history. Read the state intervals table below for exact values.`);
  $('ticks').replaceChildren();
  for (const value of [now - hours * 3600000, now]) {
    const tick = document.createElement('span');
    tick.textContent = `${shortDate(value)}, ${time(value)}`;
    $('ticks').append(tick);
  }
  const body = $('interval-rows');
  body.replaceChildren();
  periods.toReversed().forEach(period => cells(body, [stamp(period.start), stamp(period.end), names[period.status]]));
}

function outages(now) {
  const body = $('incidents-body');
  if (!data.outages.length) {
    tableMessage('incidents-body', 4, data.current ? 'No outages have been recorded.' : 'No checks have been recorded yet.');
    return;
  }
  body.replaceChildren();
  data.outages.forEach(outage => {
    const outcome = outage.outcome === 'open' && overdue(data.current, now) ? 'uncertain' : outage.outcome;
    const seconds = outage.recovered_at ? (Date.parse(outage.recovered_at) - Date.parse(outage.first_down_at)) / 1000 : null;
    const row = cells(body, [stamp(outage.first_down_at), stamp(outage.recovered_at), duration(seconds), { open: 'Ongoing', recovered: 'Recovered', uncertain: 'Uncertain' }[outcome] ?? 'Uncertain']);
    row.cells[2].className = 'number';
    row.cells[3].className = `outcome-${outcome}`;
  });
}

function render() {
  if (!data) return;
  const now = Date.now();
  currentState(now);
  statistics();
  daily(now);
  history(now);
  outages(now);
  set('updated', `Fetched ${time(data.generated_at)} BST`);
}

async function refresh() {
  if (fetching) return;
  fetching = true;
  $('refresh').disabled = true;
  set('refresh', 'Fetching…');
  try {
    const response = await fetch('/api/dashboard', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (!Array.isArray(next.daily) || !Array.isArray(next.transitions) || !Array.isArray(next.outages) || !next.totals) throw new Error('Incomplete response');
    data = next;
    fetchFailed = false;
    $('notice').hidden = true;
    render();
  } catch {
    fetchFailed = true;
    $('notice').hidden = false;
    set('notice', data ? `Refresh failed. Last fetched ${stamp(data.generated_at)}.` : 'Could not load records. Try again.');
    if (data) render();
    else {
      set('status', 'Unavailable');
      set('chart', 'Daily records unavailable.');
      set('day-readout', '');
      set('timeline', 'Connection history unavailable.');
      tableMessage('daily-rows', 3, 'Records unavailable.');
      tableMessage('interval-rows', 3, 'Records unavailable.');
      tableMessage('incidents-body', 4, 'Records unavailable.');
    }
  } finally {
    fetching = false;
    $('refresh').disabled = false;
    set('refresh', fetchFailed ? 'Retry' : 'Refresh');
  }
}

$('refresh').addEventListener('click', refresh);
$('days').addEventListener('change', () => { if (data) daily(Date.now()); });
$('hours').addEventListener('change', () => { if (data) history(Date.now()); });
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (data) daily(Date.now()); }, 150);
});
// Freshness still changes when a request fails or the browser loses connectivity.
setInterval(() => { if (data) { currentState(Date.now()); history(Date.now()); outages(Date.now()); } }, 15000);
setInterval(refresh, 60000);
refresh();
