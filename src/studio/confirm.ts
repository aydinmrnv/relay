import { createInterface } from 'node:readline';

/**
 * Asking the person at the terminal before a studio starts anything.
 *
 * A paired studio holds a token, and a token can end up somewhere it should
 * not: lifted from the browser's storage by a script injected into the
 * studio, or handed to whoever now holds the studio's hostname. The token
 * alone must not be enough to run agents on this machine. So the first time
 * a studio asks this `relay connect` to start a run or write files into the
 * repository, the question is put where only the person sitting at the
 * machine can answer it: the terminal `relay connect` is running in.
 *
 * It is asked once per studio per start, not once per run. That is the
 * trade: a person presses Run in a browser and expects it to run, and being
 * asked every time would train them to answer without reading. What it buys
 * is that nothing starts on a machine whose owner has not, since the last
 * time they started `relay connect`, said yes to that studio.
 *
 * Where there is no terminal to ask in (`--json` piped to another program, a
 * service), the answer is no, unless `RELAY_CONNECT_CONFIRM=never` says the
 * person has decided a paired studio is enough.
 */

export interface ConfirmRequest {
  /** The studio's origin, or null for a caller that is not a browser. */
  origin: string | null;
  action: 'run' | 'install' | 'approve';
  /** What is being asked for, already stripped of anything a terminal would act on. */
  summary: string;
}

export type ConfirmAnswer = { allowed: true } | { allowed: false; reason: string; /** Whether a person was actually asked and said no, or did not answer. */ asked: boolean };

export type Confirm = (request: ConfirmRequest) => Promise<ConfirmAnswer>;

/** The environment variable that turns the question off (`never`) for a machine with nobody at its terminal. */
export const CONFIRM_VARIABLE = 'RELAY_CONNECT_CONFIRM';

export interface TerminalIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  /** How long the question waits for an answer. */
  timeoutMs?: number;
  /** How long after the question is printed a line is taken to have been typed before it, and ignored. */
  guardMs?: number;
}

/**
 * Nobody reads a three-line question and answers it in under this. A line
 * that arrives sooner was typed before the question was on the screen.
 */
const GUARD_MS = 750;

/**
 * Text from a studio, made safe to print: a request body is whatever the
 * caller sent, and a terminal acts on escape sequences. Control characters
 * and the Unicode direction overrides become spaces, and it is cut short.
 */
export function printable(value: unknown, max = 120): string {
  const text = typeof value === 'string' ? value : '';
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The default `Confirm`: a yes/no question on the terminal.
 *
 * It writes to stderr, so `relay connect --json` keeps a clean stdout, and
 * reads a line from stdin in the terminal's ordinary line mode: Ctrl-C still
 * reaches `relay connect` as the signal it is.
 */
export function terminalConfirm(io: TerminalIo = { input: process.stdin, output: process.stderr, env: process.env }): Confirm {
  const timeoutMs = io.timeoutMs ?? 120_000;
  const guardMs = io.guardMs ?? GUARD_MS;
  // One question on the terminal at a time: the next waits for the answer to this one.
  let last: Promise<unknown> = Promise.resolve();

  const ask = (request: ConfirmRequest): Promise<ConfirmAnswer> =>
    new Promise((resolve) => {
      const who = request.origin === null ? 'A program on this machine' : `The studio at ${printable(request.origin)}`;
      const what = request.action === 'run' ? 'start a run here' : request.action === 'approve' ? 'answer an approval a run here is waiting on' : 'write these files into this repository';
      // Only an answer to this question counts. `relay connect` reads nothing
      // from its terminal the rest of the time, so whatever was typed there
      // earlier — an Enter, a stray `y` — is still waiting to be read, and
      // would otherwise answer the question before anyone had seen it: a `y`
      // would allow a run nobody was asked about. What is already buffered is
      // thrown away here, and what arrives in the first moments after the
      // question is printed is thrown away below.
      while (io.input.read() !== null) {
        // Discarded.
      }
      const prompt = '  Allow? [y/N] ';
      io.output.write(`\n  ${who} is asking to ${what}:\n    ${request.summary}\n  If that was you, allow it. It is not asked again until this \`relay connect\` stops.\n${prompt}`);
      const askedAt = Date.now();
      const reader = createInterface({ input: io.input, terminal: false });
      let settled = false;
      const done = (answer: ConfirmAnswer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reader.close();
        resolve(answer);
      };
      const timer = setTimeout(() => {
        io.output.write('\n  No answer; not allowed.\n');
        done({ allowed: false, asked: true, reason: 'Nobody answered in the terminal where `relay connect` is running. It asks there before a studio may start anything: answer it, then try again.' });
      }, timeoutMs);
      reader.on('line', (line) => {
        if (settled) return;
        if (Date.now() - askedAt < guardMs) {
          // Typed before the question could have been read. Asked again, on a fresh line.
          io.output.write(`\n  (Ignored what was typed before the question.)\n${prompt}`);
          return;
        }
        if (/^\s*y(es)?\s*$/i.test(line)) done({ allowed: true });
        else done({ allowed: false, asked: true, reason: 'That was not allowed in the terminal where `relay connect` is running.' });
      });
      reader.once('close', () => done({ allowed: false, asked: true, reason: 'The terminal where `relay connect` is running closed before anyone answered.' }));
    });

  return (request) => {
    if (io.env[CONFIRM_VARIABLE] === 'never') return Promise.resolve({ allowed: true });
    if (io.input.isTTY !== true || io.output.isTTY !== true) {
      return Promise.resolve({
        allowed: false,
        asked: false,
        reason: `This \`relay connect\` has no terminal to ask in, so it starts nothing a studio asks for. Run it in a terminal, or set ${CONFIRM_VARIABLE}=never to trust every paired studio.`,
      });
    }
    const answer = last.then(() => ask(request));
    last = answer.catch(() => undefined);
    return answer;
  };
}
