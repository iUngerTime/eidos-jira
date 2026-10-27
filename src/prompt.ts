// Asking a person for their sign-in in a terminal: the email shown as typed,
// the token hidden. Without a terminal (a script), the two are read from
// standard input as two lines, so a token is never an argument.
import { createInterface } from 'node:readline';

export async function readLines(count: number): Promise<string[]> {
  const lines: string[] = [];
  const reader = createInterface({ input: process.stdin });
  for await (const line of reader) {
    lines.push(line.trim());
    if (lines.length >= count) break;
  }
  reader.close();
  return lines;
}

export function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    output.write(question);
    let answer = '';
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');
    const done = (value: string | null): void => {
      input.setRawMode?.(wasRaw ?? false);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
      if (value === null) reject(new Error('cancelled'));
      else resolve(value.trim());
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done(answer);
        if (char === '\u0003') return done(null);
        if (char === '\u007f' || char === '\b') {
          if (answer.length > 0) {
            answer = answer.slice(0, -1);
            if (!hidden) output.write('\b \b');
          }
          continue;
        }
        answer += char;
        if (!hidden) output.write(char);
      }
    };
    input.on('data', onData);
  });
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} [y/N] `, false);
  return /^y(es)?$/i.test(answer);
}
