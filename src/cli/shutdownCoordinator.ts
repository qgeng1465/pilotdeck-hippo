export type ShutdownAndExit = (exitCode: number) => Promise<void>;

export function createShutdownAndExit(
  stop: () => Promise<void>,
  exit: (exitCode: number) => void,
): ShutdownAndExit {
  let requestedExitCode = 0;
  let shutdownPromise: Promise<void> | undefined;

  return (exitCode) => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (!shutdownPromise) {
      shutdownPromise = stop().finally(() => {
        exit(requestedExitCode);
      });
    }
    return shutdownPromise;
  };
}
