// Markdown + YAML front-matter codec for `.relay/` records: files-only Markdown,
// diffable and human-readable. The front-matter block is the
// authoritative machine record; the Markdown body is a generated human-readable
// rendering and is NOT parsed back, so it can hold a friendly summary without
// risking round-trip fidelity.
//
// Delimiter safety: a `.relay/` record's body, and any string field rendered as a
// YAML block scalar, is indented under its key — so a bare `---` at column 0
// never appears inside the front-matter block and reliably delimits it. We rely
// on that rather than counting fences.
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const FENCE = '---';

export interface ParsedFrontmatter {
  data: unknown;
  body: string;
}

export function serializeFrontmatter(data: unknown, body: string): string {
  // stringifyYaml already terminates with a newline.
  const yaml = stringifyYaml(data);
  const trimmedBody = body.replace(/^\n+/, '').replace(/\n+$/, '');
  return `${FENCE}\n${yaml}${FENCE}\n\n${trimmedBody}\n`;
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split('\n');
  if (lines[0] !== FENCE) {
    throw new Error('record does not begin with a front-matter fence');
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FENCE) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new Error('unterminated front-matter block');
  }
  const yaml = lines.slice(1, end).join('\n');
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '');
  return { data: parseYaml(yaml), body };
}
