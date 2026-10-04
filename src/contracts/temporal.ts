import type { Json } from "../contracts.js";

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

/** Calendar comparisons preserve the written date; instants require a known offset. */
export function temporalValue(
  value: Json,
  mode: "date" | "datetime" | "calendar_date" | "instant",
): string | undefined {
  if (typeof value !== "string" || value.length > 80) return undefined;
  if (validDate(value))
    return mode === "date" || mode === "calendar_date" ? value : undefined;
  if (mode === "date") return undefined;
  const match =
    /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})?$/.exec(
      value,
    );
  if (!match || !validDate(match[1]!)) return undefined;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59)
    return undefined;
  const zone = match[6];
  if (
    zone &&
    !/^[Zz]$/.test(zone) &&
    (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)
  )
    return undefined;
  if (mode === "calendar_date") return match[1];
  if (!zone || zone === "-00:00" || value[10] === " ") return undefined;
  const milliseconds = Date.parse(
    `${match[1]}T${match[2]}:${match[3]}:${match[4]}${zone}`,
  );
  if (!Number.isFinite(milliseconds)) return undefined;
  const fraction = (match[5] ?? "").replace(/0+$/, "").padEnd(3, "0");
  return new Date(milliseconds)
    .toISOString()
    .replace(/\.000Z$/, `.${fraction}Z`);
}
