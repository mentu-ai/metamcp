type LogLevel = 'info' | 'warn' | 'error';

export function log(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    component: 'metamcp',
    msg,
    ...fields,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}
