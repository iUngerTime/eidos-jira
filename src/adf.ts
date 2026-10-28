// Atlassian Document Format to markdown (Jira Pull REQ7): headings, lists,
// tables, code, quotes, and links as markdown writes them; a mention as the
// matched user's `@alias`; an embedded file as a link to its attachment; and
// a node this file does not know as the text it holds. Pure, so the same
// document always gives the same markdown.

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
}

export interface AdfContext {
  // a Jira account id to the alias of the root user matched to it; null leaves the mention's own text
  mention(accountId: string, text: string): string | null;
  // an embedded file (its media id and the file name Jira shows as its alt) to the address its link points at, and
  // whether it is drawn as an image there (one in the root); null for none known
  media(id: string, alt: string | null): { label: string; href: string; image?: boolean } | null;
}

const NONE: AdfContext = { mention: () => null, media: () => null };

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function inline(nodes: AdfNode[] | undefined, context: AdfContext): string {
  return (nodes ?? []).map((node) => inlineNode(node, context)).join('');
}

function marked(text: string, marks: AdfNode['marks']): string {
  let out = text;
  if (out === '') return out;
  const types = new Set((marks ?? []).map((mark) => mark.type));
  if (types.has('code')) out = '`' + out.replace(/`/g, '\\`') + '`';
  else {
    if (types.has('strong')) out = `**${out}**`;
    if (types.has('em')) out = `*${out}*`;
    if (types.has('strike')) out = `~~${out}~~`;
  }
  const link = (marks ?? []).find((mark) => mark.type === 'link');
  if (link) out = `[${out}](${str(link.attrs?.['href'])})`;
  return out;
}

function inlineNode(node: AdfNode, context: AdfContext): string {
  switch (node.type) {
    case 'text':
      return marked(str(node.text), node.marks);
    case 'hardBreak':
      return '  \n';
    case 'mention': {
      const id = str(node.attrs?.['id']);
      const text = str(node.attrs?.['text']).replace(/^@/, '');
      const alias = context.mention(id, text);
      return alias ? `@${alias}` : `@${text || id}`;
    }
    case 'emoji':
      return str(node.attrs?.['text']) || str(node.attrs?.['shortName']);
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard': {
      const url = str(node.attrs?.['url']);
      return url ? `<${url}>` : '';
    }
    case 'status':
      return `\`${str(node.attrs?.['text'])}\``;
    case 'date': {
      const stamp = Number(node.attrs?.['timestamp']);
      return Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : '';
    }
    case 'media':
    case 'mediaInline': {
      const found = context.media(str(node.attrs?.['id']), str(node.attrs?.['alt']) || null);
      if (found) return `${found.image ? '!' : ''}[${found.label}](${found.href})`;
      return str(node.attrs?.['alt']);
    }
    default:
      return node.text !== undefined ? marked(node.text, node.marks) : inline(node.content, context);
  }
}

const indent = (text: string, by: string): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? line : by + line))
    .join('\n');

function list(node: AdfNode, context: AdfContext, ordered: boolean): string {
  const start = Number(node.attrs?.['order']) || 1;
  return (node.content ?? [])
    .map((item, index) => {
      const bullet = ordered ? `${start + index}. ` : '- ';
      const body = blocks(item.content, context).trim();
      const [first = '', ...rest] = body.split('\n');
      return bullet + first + (rest.length > 0 ? '\n' + indent(rest.join('\n'), ' '.repeat(bullet.length)) : '');
    })
    .join('\n');
}

function cell(node: AdfNode, context: AdfContext): string {
  return blocks(node.content, context).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|');
}

function table(node: AdfNode, context: AdfContext): string {
  const rows = (node.content ?? []).filter((row) => row.type === 'tableRow').map((row) => (row.content ?? []).map((entry) => cell(entry, context)));
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: string[]): string => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`;
  const [head = [], ...body] = rows;
  return [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n');
}

function block(node: AdfNode, context: AdfContext): string {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content, context);
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.['level']) || 1, 1), 6);
      return `${'#'.repeat(level)} ${inline(node.content, context)}`;
    }
    case 'bulletList':
      return list(node, context, false);
    case 'orderedList':
      return list(node, context, true);
    case 'taskList':
      return (node.content ?? []).map((item) => `- [${item.attrs?.['state'] === 'DONE' ? 'x' : ' '}] ${inline(item.content, context)}`).join('\n');
    case 'decisionList':
      return (node.content ?? []).map((item) => `- ${inline(item.content, context)}`).join('\n');
    case 'codeBlock': {
      const text = (node.content ?? []).map((child) => str(child.text)).join('');
      return '```' + str(node.attrs?.['language']) + '\n' + text + '\n```';
    }
    case 'blockquote':
    case 'panel':
      return indent(blocks(node.content, context), '> ').replace(/^$/gm, '>');
    case 'rule':
      return '---';
    case 'table':
      return table(node, context);
    case 'expand':
    case 'nestedExpand': {
      const title = str(node.attrs?.['title']);
      const body = blocks(node.content, context);
      return title ? `**${title}**\n\n${body}` : body;
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return (node.content ?? []).map((child) => inlineNode(child, context)).join('\n');
    default:
      return node.content ? blocks(node.content, context) : inlineNode(node, context);
  }
}

function blocks(nodes: AdfNode[] | undefined, context: AdfContext): string {
  return (nodes ?? [])
    .map((node) => block(node, context))
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

// A rich-text value as Jira gives it (a document, or plain text from an older field) as markdown.
export function adfToMarkdown(value: unknown, context: AdfContext = NONE): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  const node = value as AdfNode;
  if (typeof node !== 'object' || typeof node.type !== 'string') return '';
  return (node.type === 'doc' ? blocks(node.content, context) : block(node, context)).replace(/[ \t]+$/gm, (spaces) => (spaces === '  ' ? spaces : '')).trim();
}
