import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ResultRecord } from '../shared/types';

/** Appends one JSON line per result, one file per spec, so parallel shards never collide. */
export class ResultStore {
  readonly records: ResultRecord[] = [];

  constructor(
    private readonly dir: string,
    private readonly redact: (text: string) => string = (text) => text,
  ) {}

  add(record: ResultRecord): void {
    // Keep only the redacted copy, so the terminal summary and HTML reports cannot show a secret either.
    const safe = this.redact(JSON.stringify(record));
    this.records.push(JSON.parse(safe) as ResultRecord);
    mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${path.basename(record.spec || 'unknown').replace(/[^\w.-]/g, '_')}.jsonl`);
    appendFileSync(file, `${safe}\n`);
  }

  forSpec(spec: string): ResultRecord[] {
    return this.records.filter((r) => r.spec === spec);
  }

  forLabel(label: string): ResultRecord[] {
    return this.records.filter((r) => r.label === label);
  }
}
