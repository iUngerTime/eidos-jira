// What this plugin reads of the host and of the plugins it works through.
// A plugin from outside imports nothing of the CLI but `eidosmd/plugin`, so
// the Backlog's, Comments', and Assets' APIs, which it reaches through
// `host.plugin(name)`, are described here as far as it uses them.
export type StatusCategory = 'todo' | 'in_progress' | 'done';

export interface SectionDeclaration {
  key: string;
  title: string;
  type: 'text' | 'checklist' | 'links';
}

export interface BoardSettings {
  statuses: string[];
  columns: Array<{ name: string; statuses: string[] }>;
  default_status: string;
  priorities: string[];
  milestones: Array<{ name: string; date: string | null }>;
  properties: Array<{ name: string; type: string; options: string[] | null }>;
  sections: SectionDeclaration[];
  types: Array<{ name: string; title: string; sections: SectionDeclaration[]; prefix: string | null }>;
  status_categories: Record<string, StatusCategory>;
  link_types: Array<{ name: string; outward: string; inward: string }>;
}

export interface TaskView {
  name: string;
  id: string | null;
  file: string;
  title: string;
  type: string;
  status: string | null;
  assignee: string[];
  milestone: string | null;
  priority: string | null;
  parent: string | null;
  updated: string | null;
  links: Array<{ type: string; task: string; direction: 'outward' | 'inward' }>;
  properties: Record<string, unknown>;
  sections: Array<SectionDeclaration & { text: string; present: boolean }>;
}

export interface TaskFields {
  title?: string;
  type?: string;
  status?: string | null;
  assignee?: string[];
  milestone?: string | null;
  priority?: string | null;
  parent?: string | null;
  properties?: Record<string, unknown>;
  sections?: Record<string, string>;
  id?: string;
  created?: string;
  updated?: string;
  tool?: Record<string, unknown>;
}

export interface BacklogApi {
  folder(): string;
  settings(): BoardSettings;
  tasks(): TaskView[];
  get(name: string): TaskView;
  create(fields: TaskFields & { title: string }): TaskView;
  set(name: string, fields: TaskFields): TaskView;
  link(name: string, type: string, other: string, direction?: 'outward' | 'inward'): TaskView;
  unlink(name: string, type: string, other: string, direction?: 'outward' | 'inward'): TaskView;
  milestones(): Array<{ name: string; date: string | null }>;
  addMilestone(milestone: { name: string; date?: string | null }): Promise<unknown>;
  addProperty(declaration: { name: string; type: string; options?: string[]; applies_to?: string[]; meaning?: string }): Promise<BoardSettings>;
}

export interface Author {
  name: string;
  role: string | null;
  user: string | null;
}

export interface Message {
  author: string;
  user?: string;
  text: string;
  at: string;
  external?: string;
}

export interface ThreadView {
  id: string;
  target: { host: string; id: string };
  messages: Message[];
}

export interface MessageOrigin {
  written?: string;
  external?: string;
  thread?: string;
}

export interface CommentsApi {
  threads(target: { host: string; id: string }): ThreadView[];
  thread(id: string): ThreadView;
  start(target: { host: string; id: string }, at: null, text: string, as?: Author, origin?: MessageOrigin): ThreadView;
  reply(thread: string, text: string, as?: Author, origin?: MessageOrigin): ThreadView;
  editMessage(thread: string, index: number, text: string): ThreadView;
  removeMessage(thread: string, index: number): ThreadView | null;
  authorAs(key: string): Author | null;
  // who signs a message written now: the acting user, else the git identity matched to a listed user
  author(): Author;
}

export interface AssetsApi {
  folders(): Array<{ name: string }>;
  files(): Array<{ path: string; name: string; links: Array<{ kind: string; ref: string }> }>;
  add(folder: string, name: string, data: Uint8Array): { path: string };
  link(relPath: string, link: { kind: 'task'; ref: string }): unknown;
}
