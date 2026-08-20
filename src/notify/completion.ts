import type { EngineContext } from '../workflow/context.ts';
import { notifyCommand } from './command.ts';
import { notifySystem } from './system.ts';

export async function notifyCompletion(context: Pick<EngineContext, 'state' | 'observer'>): Promise<void> {
  const { state, observer } = context;
  state.notification ??= {};
  const body = `Run ${state.runId} ${state.phase.toLowerCase()}`;
  if (state.config.notify.system === true) await record('system', () => notifySystem(body));
  const command = state.config.notify.command;
  if (Array.isArray(command)) await record('command', async () => { await notifyCommand(command, state); return 'command completed'; });

  async function record(channel: 'system' | 'command', action: () => Promise<string>): Promise<void> {
    const at = new Date().toISOString();
    try {
      const detail = await action();
      state.notification![channel] = { status: detail.includes('unavailable') || detail.includes('unsupported') ? 'skipped' : 'done', detail, at };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      state.notification![channel] = { status: 'failed', detail, at };
      observer.warn(`${channel} notification failed: ${detail}`);
    }
  }
}
