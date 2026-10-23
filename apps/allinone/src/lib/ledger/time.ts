const shanghaiOffset = "+08:00";

export function getCurrentShanghaiDateLocal() {
  return getCurrentShanghaiDateTimeLocal().slice(0, 10);
}

export function getCurrentShanghaiDateTimeLocal() {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function toShanghaiIsoString(input: string) {
  const value = input.trim();

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new Error("日期时间格式不正确。");
  }

  const parsed = new Date(`${value}:00${shanghaiOffset}`);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("日期时间无效。");
  }

  return parsed.toISOString();
}

export function toShanghaiDateStartIso(input: string) {
  const value = input.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("日期格式不正确。");
  }

  return new Date(`${value}T00:00:00${shanghaiOffset}`).toISOString();
}

export function toShanghaiDateEndExclusiveIso(input: string) {
  const start = new Date(toShanghaiDateStartIso(input));
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}

export function formatShanghaiDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

export function formatShanghaiDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

export function toDateTimeLocalValue(value: string) {
  const date = new Date(value);

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function buildDateTimeLocalValue(input?: string) {
  if (!input) {
    return getCurrentShanghaiDateTimeLocal();
  }

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return getCurrentShanghaiDateTimeLocal();
  }

  return toDateTimeLocalValue(input);
}

export function buildShanghaiTimestampSlug(now = getCurrentShanghaiDateTimeLocal()) {
  return now.replace(/[-:T]/g, "");
}
