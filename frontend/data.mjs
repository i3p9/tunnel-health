export const DAY = 86400000;
export const ZONE = 'Asia/Dhaka';
export const names = { up: 'Connected', down: 'Down', inactive: 'Inactive', unknown: 'Unknown', unrecorded: 'Not recorded' };
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const stampFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, day: 'numeric', month: 'short' });
const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function dayKey(value) {
  return dayFormatter.format(new Date(value));
}

export function stamp(value) {
  return value != null && Number.isFinite(new Date(value).getTime()) ? stampFormatter.format(new Date(value)) : '—';
}

export function shortDate(value) {
  return dateFormatter.format(new Date(value));
}

export function time(value) {
  return timeFormatter.format(new Date(value));
}

export function duration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  if (seconds > 0 && seconds < 60) return '<1 min';
  const minutes = Math.max(0, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function overdue(current, now) {
  const checked = Date.parse(current?.scheduled_at);
  return !Number.isFinite(checked) || now - checked > 180000;
}

export function recordedDays(data) {
  if (!data.first_check_at || !data.current) return 0;
  return Math.max(1, Math.round((Date.parse(dayKey(data.current.scheduled_at)) - Date.parse(dayKey(data.first_check_at))) / DAY) + 1);
}

export function dailyRows(data, count, now) {
  const byDay = new Map(data.daily.map(row => [row.day, row]));
  const first = data.first_check_at ? dayKey(data.first_check_at) : null;
  const last = data.current ? dayKey(data.current.scheduled_at) : null;
  return Array.from({ length: count }, (_, i) => {
    const date = dayKey(now - (count - i - 1) * DAY);
    const source = byDay.get(date);
    const recorded = Boolean(first && last && date >= first && date <= last);
    let record = 'Recorded events';
    if (!first) record = 'No checks recorded';
    else if (date < first) record = 'Before recording began';
    else if (date > last) record = 'No checks received';
    else if (date === first && date === last) record = `${time(data.first_check_at)}–${time(data.current.scheduled_at)} only`;
    else if (date === first) record = `From ${time(data.first_check_at)}`;
    else if (date === last) record = `Through ${time(data.current.scheduled_at)}`;
    return { day: date, recorded, record,
      outage_count: recorded ? Number(source?.outage_count ?? 0) : null,
      recovered_seconds: recorded ? Number(source?.recovered_seconds ?? 0) : null };
  });
}

export function intervals(data, hours, now) {
  const start = now - hours * 3600000;
  const first = Date.parse(data.first_check_at);
  const events = data.transitions.map(row => ({ at: Date.parse(row.scheduled_at), status: names[row.status] ? row.status : 'unknown' }))
    .filter(row => Number.isFinite(row.at) && row.at <= now).sort((a, b) => a.at - b.at);
  const initial = events.filter(row => row.at <= start).at(-1)?.status ?? (Number.isFinite(first) && first <= start ? 'unknown' : 'unrecorded');
  const points = [{ at: start, status: initial }, ...events.filter(row => row.at > start)];
  if (overdue(data.current, now) && data.current) {
    // The first missed scheduled check begins the unobserved tail.
    points.push({ at: Math.max(start, Date.parse(data.current.scheduled_at) + 60000), status: 'unknown' });
  }
  points.sort((a, b) => a.at - b.at);
  const result = [];
  points.forEach((point, i) => {
    const end = Math.min(now, points[i + 1]?.at ?? now);
    if (end <= point.at) return;
    const previous = result.at(-1);
    if (previous?.status === point.status) previous.end = end;
    else result.push({ start: point.at, end, status: point.status });
  });
  return result;
}
