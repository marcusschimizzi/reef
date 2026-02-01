let counter = 0;

export function nextId(): string {
  counter += 1;
  return `job-${counter}`;
}
