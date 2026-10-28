// Installs the built release under an app data folder, as `eidos plugin
// install` places one: `<app data>/plugins/jira/<version>/`. The folder is
// EIDOS_APP_DATA's when it is set, so trying the plugin never touches the
// app data a person's real roots use unless they mean it to.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const version = /^version:\s*(\S+)/m.exec(readFileSync('manifest.yaml', 'utf8'))?.[1];
const appData =
  process.env.EIDOS_APP_DATA ??
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'eidosmd')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? os.homedir(), 'eidosmd')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'eidosmd'));
const dir = path.join(appData, 'plugins', 'jira', version);
mkdirSync(dir, { recursive: true });
for (const file of ['manifest.yaml', 'cli.js', 'app.js', 'page.js', 'instructions.md']) copyFileSync(path.join('dist', file), path.join(dir, file));
console.log(`installed jira ${version} in ${dir}`);
