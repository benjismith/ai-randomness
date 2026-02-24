const SCRIPT_START: number = performance.now();

export function log(message: string): void {
  const elapsed = Math.floor(performance.now() - SCRIPT_START);
  console.log(`${elapsed}: ${message}`);
}
