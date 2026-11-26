export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A count with thousands separators, such as `16,000`. */
export function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

/** Text over a length limit, such as `21,105 characters; the limit is 16,000 (5,105 over)`. */
export function overLimit(length: number, limit: number): string {
  return `${formatCount(length)} characters; the limit is ${formatCount(limit)} (${formatCount(length - limit)} over)`;
}
