// Argument names of an FText format pattern; a backtick escapes the brace (TextFormatter.h).
export function formatArgs(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/(?<!`)\{([^{}|`]+)\}/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}
