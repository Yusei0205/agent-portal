/**
 * Shared kiro-cli command resolution.
 *
 * On every platform the real binary is spawned as plain 'kiro-cli' (no .cmd
 * suffix).  On Windows, Node's child_process / CreateProcess already searches
 * PATH with PATHEXT so 'kiro-cli' resolves to kiro-cli.exe automatically.
 * Using 'kiro-cli.cmd' with shell:false fails with EINVAL when the .cmd shim
 * does not exist (e.g. when only the .exe is on PATH).
 *
 * When PORTAL_KIRO_FAKE is set (tests) the fake script is run through
 * process.execPath and the fake path is prepended to args.
 */

/**
 * Resolve the kiro-cli executable and full argument list for a spawn call.
 *
 * @param args  Arguments to pass to kiro-cli (e.g. ['whoami'], ['login', '--use-device-flow']).
 *              When PORTAL_KIRO_FAKE is active the fake-script path is prepended automatically.
 */
export function resolveKiroCmd(args: string[]): { cmd: string; fullArgs: string[] } {
  const fake = process.env.PORTAL_KIRO_FAKE;
  if (fake) {
    return { cmd: process.execPath, fullArgs: [fake, ...args] };
  }
  return { cmd: 'kiro-cli', fullArgs: args };
}
