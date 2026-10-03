import type { Teams } from "./http.js";
/** Transient presence never changes durable invocation or reply outcomes. */
export async function withTyping<T>(
  enabled: boolean,
  teams: Pick<Teams, "typing">,
  chat: string,
  operation: () => Promise<T>,
  intervalMs = 4000,
): Promise<T> {
  if (!enabled) return operation();
  let stopped = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = async (active: boolean) => {
    try {
      await teams.typing(chat, active);
      return true;
    } catch {
      console.error(JSON.stringify({ event: "typing-unconfirmed", active }));
      return false;
    }
  };
  const started = await notify(true);
  const refresh = async () => {
    while (started && !stopped) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, intervalMs);
      });
      if (stopped) break;
      if (!(await notify(true))) break;
    }
  };
  const pending = refresh();
  try {
    return await operation();
  } finally {
    stopped = true;
    clearTimeout(timer);
    wake?.();
    await pending;
    await notify(false);
  }
}
