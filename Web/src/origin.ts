export type OriginKind = 'asset' | 'file' | 'unknown';

export interface ParsedOrigin {
  kind: OriginKind;
  path: string;
  line: number;
}

const LINE_SUFFIX = /(?:\((\d+)\)|:(\d+))$/;
const FILE_EXTENSION = /\.(c|cc|cpp|cs|csv|h|hpp|inl|ini|json|py|rml|txt)$/i;

// Mirrors LocHubBridge::ParseOrigin in the plugin. Gather writes "Path/File.cpp(42)" for source text
// (FSourceLocation::ToString) and an object path such as "/Game/UI/WBP_Pause.WBP_Pause:WidgetTree.Text" for assets.
export function parseOrigin(origin: string): ParsedOrigin {
  let path = origin.trim().replaceAll('\\', '/');
  let line = 0;
  const suffix = LINE_SUFFIX.exec(path);
  // index > 1 keeps a drive letter ("D:") from being read as a line.
  if (suffix && suffix.index > 1) {
    line = Number(suffix[1] ?? suffix[2]);
    path = path.slice(0, suffix.index);
  }
  if (path.length === 0) return { kind: 'unknown', path: '', line: 0 };
  if (path.startsWith('/') && !FILE_EXTENSION.test(path)) {
    // /Script/ objects are native classes: there is no asset to open.
    if (path.startsWith('/Script/')) return { kind: 'unknown', path, line: 0 };
    return { kind: 'asset', path: path.split('.')[0] ?? path, line: 0 };
  }
  return { kind: 'file', path: path.replace(/^\/+/, ''), line };
}

export function originLabel(origin: ParsedOrigin): string {
  return origin.kind === 'file' && origin.line > 0 ? `${origin.path}:${origin.line}` : origin.path;
}

export interface DescribedOrigin extends ParsedOrigin {
  // Asset only: the raw text after "<packagePath>." (the object name and property path). Empty for file/unknown,
  // and empty when the raw origin has no dot following the package path.
  member: string;
}

export function describeOrigin(origin: string): DescribedOrigin {
  const parsed = parseOrigin(origin);
  if (parsed.kind !== 'asset') return { ...parsed, member: '' };
  const normalized = origin.trim().replaceAll('\\', '/');
  const prefix = `${parsed.path}.`;
  return { ...parsed, member: normalized.startsWith(prefix) ? normalized.slice(prefix.length) : '' };
}
