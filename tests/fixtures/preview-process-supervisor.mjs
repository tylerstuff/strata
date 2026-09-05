import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { superviseChildProcess } from '../../scripts/preview-process-cleanup.mjs';

const [, , token, mode = 'signal'] = process.argv;
if (!token?.startsWith('strata-process-test-')) throw new Error('Missing fixture ownership token');
const execute = promisify(execFile);
const child = spawn(process.execPath, [fileURLToPath(new URL('./preview-process-parent.mjs', import.meta.url)), token,
  mode === 'leftover' ? 'ignore-term' : 'normal'], {
  detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
process.send?.({ kind: 'workflow-started', workflowPid: child.pid });
let descendantPid, readyResolve, releaseCensus, censusCount = 0;
const childReady = new Promise(resolve => { readyResolve = resolve; });
const censusRelease = new Promise(resolve => { releaseCensus = resolve; });
child.on('message', message => {
  if (message.childPid) {
    descendantPid = message.childPid;
    process.send?.({ kind: 'child-started', workflowPid: child.pid, childPid: descendantPid });
  }
  if (message.kind === 'ready') readyResolve();
});
process.on('message', message => {
  if (message === 'release-census') releaseCensus();
  if (message === 'exit-workflow') child.send('exit-parent-success');
  if (message === 'overflow') child.send('overflow');
});

// Only the production supervisor installs SIGINT/SIGTERM handlers. The injected
// census gates startup deterministically and still reads real fixture identities.
const outcome = await superviseChildProcess(child, {
  rootCommand: process.execPath, timeoutMs: mode === 'timeout' ? 750 : 3500,
  termGraceMs: 120, killGraceMs: 150, exitGraceMs: 150, maxOutputBytes: mode === 'overflow' ? 40 : 8192,
  pollIntervalMs: 10,
  readProcesses: async () => {
    await childReady;
    const first = censusCount++ === 0;
    if (first && mode === 'start-wait') {
      process.send?.({ kind: 'ready', stage: 'census-waiting', workflowPid: child.pid, childPid: descendantPid });
      await censusRelease;
    }
    let stdout;
    try {
      ({ stdout } = await execute('/bin/ps', ['-p', `${child.pid},${descendantPid}`, '-o', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], {
        encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      }));
    } catch (error) {
      if (error.code === 1 && !error.stdout?.trim()) stdout = '';
      else throw error;
    }
    const rows = stdout.split('\n').filter(line => line.trim()).map(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match) throw new Error('Unrecognized fixture census identity');
      return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), start: match[4].replace(/\s+/g, ' '),
        state: match[5], command: match[6] };
    });
    if (first && mode !== 'start-wait') {
      process.send?.({ kind: 'ready', stage: 'tracked', workflowPid: child.pid, childPid: descendantPid });
    }
    return rows;
  },
});
// Resolution is evidence only after the production helper has finished cleanup.
process.send?.({ kind: 'outcome', outcome }, () => {
  if (process.connected) process.disconnect();
  process.exit(0);
});
