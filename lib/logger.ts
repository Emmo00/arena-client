type Fields = Record<string, unknown>;

/** Prefix a scope tag so logs are greppable by subsystem. */
function tag(scope: string): string {
  return `[${scope}]`;
}

function stamp(): string {
  return new Date().toISOString();
}

function formatExtra(err?: unknown, fields?: Fields): string {
  const parts: string[] = [];
  if (err) parts.push(`error=${fmtErr(err)}`);
  if (fields && Object.keys(fields).length > 0) parts.push(JSON.stringify(fields));
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function fmtErr(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export const logger = {
  info(scope: string, msg: string, fields?: Fields): void {
    console.log(`${stamp()} ${tag(scope)} ${msg}${formatExtra(undefined, fields)}`);
  },
  warn(scope: string, msg: string, err?: unknown, fields?: Fields): void {
    console.warn(`${stamp()} ${tag(scope)} ${msg}${formatExtra(err, fields)}`);
  },
  error(scope: string, msg: string, err?: unknown, fields?: Fields): void {
    console.error(`${stamp()} ${tag(scope)} ${msg}${formatExtra(err, fields)}`);
  },
};
