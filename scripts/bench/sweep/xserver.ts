// The X server's process, and the processor time it has used — what a
// probe's `xcpu` is. XQuartz runs as X11.bin, a Linux desktop as Xorg, and
// an X11 client of a Wayland session talks to Xwayland; a server on another
// machine has no process here, and the field is then null.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function serverPid(): string {
  for (const name of ['X11.bin', 'Xorg', 'Xwayland']) {
    try {
      const pid = execSync(`pgrep -x ${name}`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim()
        .split('\n')[0];
      if (pid) return pid;
    } catch {
      // not running under that name
    }
  }
  return '';
}

/**
 * Seconds of processor time `pid` has used. From /proc where there is one:
 * procps' `cputime` counts whole seconds, a quarter of a four-second cell,
 * and is spelled HH:MM:SS where macOS's ps says M:SS.ss.
 */
export function cpuSeconds(pid: string): number {
  if (!pid) return NaN;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // past the command, whose parentheses may hold spaces: utime and stime
    // are the 12th and 13th fields after it, in clock ticks of 1/100 s
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(fields[11]) + Number(fields[12])) / 100;
  } catch {
    // no /proc: macOS
  }
  const time = execSync(`ps -o cputime= -p ${pid}`).toString().trim();
  return time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}
