function offsetMinutes(timezone: string): number | undefined {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(timezone);
  if (!match) return undefined;
  const value = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -value : value;
}

function utcParts(date: Date) {
  const two = (number: number) => String(number).padStart(2, '0');
  return {
    date: `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`,
    time: `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`,
  };
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const magnitude = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(magnitude / 60)).padStart(2, '0')}:${String(magnitude % 60).padStart(2, '0')}`;
}

export function timeContext(timezone: string, date = new Date()) {
  const offset = offsetMinutes(timezone);
  if (offset !== undefined) {
    const local = utcParts(new Date(date.getTime() + offset * 60_000));
    return {
      timezone,
      utc: date.toISOString(),
      local_date: local.date,
      local_time: local.time,
      local_display: `${local.date} ${local.time} ${offsetLabel(offset)}`,
      offset: offsetLabel(offset),
    };
  }
  const localParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    localParts.find((part) => part.type === type)?.value ?? '';

  const localDate = `${value('year')}-${value('month')}-${value('day')}`;
  const localTime = `${value('hour')}:${value('minute')}:${value('second')}`;
  const localOffset = value('timeZoneName').replace('GMT', 'UTC');

  return {
    timezone,
    utc: date.toISOString(),
    local_date: localDate,
    local_time: localTime,
    local_display: `${localDate} ${localTime} ${localOffset}`,
    offset: localOffset,
  };
}

export function formatInTimezone(iso: string | undefined, timezone: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const offset = offsetMinutes(timezone);
  if (offset !== undefined) {
    const local = utcParts(new Date(d.getTime() + offset * 60_000));
    return `${local.date} ${local.time} ${offsetLabel(offset)}`;
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  }).format(d);
}
