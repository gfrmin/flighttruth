/** Wall-clock time at an IANA zone → UTC ISO minute. */
export function localToUtc(date: string, time: string, tz: string): string {
  const m = time.match(/(\d{1,2})[:.](\d{2})\s?([AaPp][Mm])?/)!;
  const meridiem = m[3]?.toUpperCase();
  const hour = (Number(m[1]) % (meridiem ? 12 : 24)) + (meridiem === 'PM' ? 12 : 0);
  const [y, mo, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, hour, Number(m[2]));
  const offsetAt = (ms: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
        .formatToParts(new Date(ms)).map((x) => [x.type, x.value])
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms;
  };
  const guess = wall - offsetAt(wall);
  return new Date(wall - offsetAt(guess)).toISOString();
}

/** YYYY-MM-DD of a UTC instant as seen in an IANA zone. */
export const localDate = (utc: string | number | Date, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utc));
