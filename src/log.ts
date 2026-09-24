// One JSON object per request on stdout (guide § 5 rule 9). The shape is the
// whole contract: nothing else about the request is ever written. In
// particular the key, the raw request target, and the target URL's query
// string never reach a log line, because they are never fields here.

export interface RequestLog {
  readonly ts: string;
  readonly tenant: string | null;
  /** Hostname of the target only. */
  readonly host: string | null;
  readonly relayStatus: number;
  readonly upstreamStatus: number | null;
  readonly elapsedMs: number;
  readonly bytes: number;
  readonly blocked: string | null;
}

export function writeRequestLog(entry: RequestLog, out: { write(chunk: string): unknown } = process.stdout): void {
  out.write(`${JSON.stringify(entry)}\n`);
}
