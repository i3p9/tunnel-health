const zone = 'Asia/Dhaka';
const $ = id => document.getElementById(id);
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const timeOnly = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
let data = null;
let hours = 24;
let measure = 'outage_count';
const format = value => value ? dateTime.format(new Date(value)) : '—';
const age = (value, now) => value ? Math.max(0, now - Date.parse(value)) : Infinity;
const text = (id, value) => { $(id).textContent = value; };

function renderStatus(now) {
  const current = data.current;
  const stale = !current || age(current.scheduled_at, now) > 180000;
  const state = stale ? 'stale' : current.status;
  text('status', !current ? 'No data' : stale ? 'Check overdue' : ({ up: 'Connected', down: 'Down', inactive: 'Inactive', unknown: 'Unknown' }[current.status] ?? 'Unknown'));
  $('status').className = state;
  text('last-check', current ? format(current.observed_at) : 'NO CHECKS YET');
  text('raw-status', current?.raw_status?.toUpperCase() ?? '—');
  text('detail', current?.error?.replaceAll('_', ' ').toUpperCase() ?? 'NO ERROR');
  text('first-check', format(data.first_check_at));
  text('status-note', !current ? 'No checks have been recorded yet.' : stale
    ? 'The latest check is over three minutes old. Current connectivity is unconfirmed.'
    : current.status === 'down' ? 'The tunnel was reported down at the latest check.'
    : current.status === 'unknown' ? 'The latest check could not confirm tunnel connectivity.'
    : current.status === 'inactive' ? 'Cloudflare reports the tunnel as inactive.'
    : 'The latest check reported the tunnel connected.');
}

function renderStatistics(now) {
  const totals = data.totals;
  const days = data.first_check_at ? Math.max(1,
    (Date.parse(`${localDay(new Date(now))}T00:00:00Z`) - Date.parse(`${localDay(new Date(data.first_check_at))}T00:00:00Z`)) / 86400000 + 1) : 0;
  text('total-outages', String(totals.outage_count));
  const recentStart = localDay(new Date(now - 6 * 86400000));
  text('recent-outages', String(data.daily.filter(row => row.day >= recentStart).reduce((sum, row) => sum + row.outage_count, 0)));
  text('average-day', days ? (totals.outage_count / days).toFixed(1) : '—');
  text('average-duration', totals.recovered_count ? durationSeconds(totals.recovered_seconds / totals.recovered_count) : '—');
  text('longest-duration', totals.longest_seconds != null ? durationSeconds(totals.longest_seconds) : '—');
  text('total-duration', totals.recovered_count ? durationSeconds(totals.recovered_seconds) : '—');
}

const localDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
function renderDaily(now) {
  const today = localDay(new Date(now));
  const dayMap = new Map(data.daily.map(row => [row.day, row]));
  const days = Array.from({ length: 30 }, (_, i) => {
    const day = localDay(new Date(now - (29 - i) * 86400000));
    return { day, value: Number(dayMap.get(day)?.[measure] ?? 0) };
  });
  const max = Math.max(1, ...days.map(row => row.value));
  const chart = $('chart');
  chart.replaceChildren();
  for (const row of days) {
    const wrap = document.createElement('div');
    wrap.className = `bar-wrap${row.day === today ? ' today' : ''}`;
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.style.height = row.value ? `${Math.max(3, 100 * row.value / max)}%` : '0';
    wrap.title = `${row.day}: ${measure === 'outage_count' ? `${row.value} outage${row.value === 1 ? '' : 's'}` : durationSeconds(row.value) + ' recovered'}`;
    wrap.append(bar);
    chart.append(wrap);
  }
  chart.setAttribute('aria-label', `Daily ${measure === 'outage_count' ? 'outage counts' : 'recovered outage time'} over 30 days. Peak: ${measure === 'outage_count' ? max : durationSeconds(max)}.`);
  text('chart-start', days[0].day);
  text('chart-end', today);
}

function renderTimeline(now) {
  const start = now - hours * 3600000;
  const end = now;
  const events = data.transitions.map(row => ({ at: Date.parse(row.scheduled_at), status: row.status })).filter(row => Number.isFinite(row.at)).sort((a, b) => a.at - b.at);
  const points = [{ at: start, status: events.filter(row => row.at <= start).at(-1)?.status ?? 'unknown' }, ...events.filter(row => row.at > start && row.at < end)];
  const lastCheck = data.current && Date.parse(data.current.scheduled_at);
  if (lastCheck && lastCheck + 180000 < end) points.push({ at: Math.max(start, lastCheck + 180000), status: 'unknown' });
  points.sort((a, b) => a.at - b.at);
  const bar = $('timeline');
  bar.replaceChildren();
  for (let i = 0; i < points.length; i++) {
    const from = Math.max(start, points[i].at);
    const to = Math.min(end, points[i + 1]?.at ?? end);
    if (to <= from) continue;
    const segment = document.createElement('div');
    segment.className = `segment ${['up', 'down', 'inactive', 'unknown'].includes(points[i].status) ? points[i].status : 'unknown'}`;
    segment.style.left = `${100 * (from - start) / (end - start)}%`;
    segment.style.width = `${100 * (to - from) / (end - start)}%`;
    segment.title = `${points[i].status.toUpperCase()} · ${format(from)} to ${format(to)}`;
    bar.append(segment);
  }
  bar.setAttribute('aria-label', `${hours === 24 ? '24 hour' : '7 day'} status timeline. ${points.length} recorded sections.`);
  const ticks = $('ticks');
  ticks.replaceChildren();
  for (let i = 0; i < 5; i++) {
    const tick = document.createElement('span');
    tick.textContent = shortDate.format(new Date(start + (end - start) * i / 4));
    ticks.append(tick);
  }
}

function duration(start, end) {
  if (!end) return '—';
  return durationSeconds(Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000));
}

function durationSeconds(seconds) {
  const minutes = Math.max(0, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

function renderOutages(now) {
  const body = $('incidents-body');
  body.replaceChildren();
  if (!data.outages.length) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.textContent = 'No outages recorded.';
    return;
  }
  for (const outage of data.outages) {
    const row = body.insertRow();
    const outcome = outage.outcome === 'open' && age(data.current?.scheduled_at, now) > 180000 ? 'uncertain' : outage.outcome;
    row.insertCell().textContent = format(outage.first_down_at);
    row.insertCell().textContent = format(outage.recovered_at);
    row.insertCell().textContent = duration(outage.first_down_at, outage.recovered_at);
    const badge = document.createElement('span');
    badge.className = `outcome ${outcome}`;
    badge.textContent = outcome;
    row.insertCell().append(badge);
  }
}

function render() {
  if (!data) return;
  const now = Date.now();
  renderStatus(now);
  renderStatistics(now);
  renderDaily(now);
  renderTimeline(now);
  renderOutages(now);
  text('updated', `Updated ${timeOnly.format(new Date(data.generated_at))} BST`);
}

async function refresh() {
  try {
    const response = await fetch('/api/dashboard', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
    render();
    text('refresh-label', 'Updates every minute');
  } catch {
    text('refresh-label', 'Refresh failed; retrying');
    if (!data) {
      text('status', 'Unavailable');
      $('status').className = 'unknown';
      text('status-note', 'Dashboard data could not be loaded. Retrying in one minute.');
      $('incidents-body').replaceChildren();
    }
  }
}

document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => {
  hours = Number(button.dataset.range);
  document.querySelectorAll('[data-range]').forEach(item => item.classList.toggle('selected', item === button));
  render();
}));
document.querySelectorAll('[data-measure]').forEach(button => button.addEventListener('click', () => {
  measure = button.dataset.measure;
  document.querySelectorAll('[data-measure]').forEach(item => item.classList.toggle('selected', item === button));
  render();
}));
function clock() { text('clock', `${timeOnly.format(new Date())} BST`); }
clock();
setInterval(clock, 1000);
refresh();
setInterval(refresh, 60000);
