import type { MemoryBrokerProcess } from "../memory-broker/process.js";

const DEFAULT_HEALTH_INTERVAL_MS = 5_000;
const INITIAL_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;

export type MemoryBrokerSupervisor = Readonly<{
  stop(): Promise<void>;
}>;

type MemoryBrokerSupervisorDependencies = Readonly<{
  ensureProcess(): Promise<MemoryBrokerProcess | undefined>;
  retireProcess(): Promise<void>;
  healthIntervalMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}>;

/**
 * Gateway owns broker liveness. Individual memory calls never spin up a parallel recovery loop:
 * they use the supervised process or fail closed while this owner replaces an unhealthy child.
 */
export async function startMemoryBrokerSupervisor(
  deps: MemoryBrokerSupervisorDependencies,
): Promise<MemoryBrokerSupervisor> {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const healthIntervalMs = deps.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restartDelayMs = INITIAL_RESTART_DELAY_MS;

  const schedule = (delayMs: number) => {
    if (stopped) {
      return;
    }
    timer = setTimer(() => {
      timer = undefined;
      void probe();
    }, delayMs);
    timer.unref?.();
  };

  const probe = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    try {
      const process = await deps.ensureProcess();
      if (!process || !process.isRunning() || !(await process.isHealthy())) {
        throw new Error("memory broker is unhealthy");
      }
      restartDelayMs = INITIAL_RESTART_DELAY_MS;
      schedule(healthIntervalMs);
    } catch {
      // Retire before retrying so a dead child's socket/epoch can never be resurrected.
      await deps.retireProcess().catch(() => undefined);
      const delayMs = restartDelayMs;
      restartDelayMs = Math.min(restartDelayMs * 2, MAX_RESTART_DELAY_MS);
      schedule(delayMs);
    }
  };

  const process = await deps.ensureProcess();
  if (!process || !process.isRunning() || !(await process.isHealthy())) {
    await deps.retireProcess().catch(() => undefined);
    throw new Error("selected memory broker did not become ready");
  }
  schedule(healthIntervalMs);
  return Object.freeze({
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
      await deps.retireProcess();
    },
  });
}
