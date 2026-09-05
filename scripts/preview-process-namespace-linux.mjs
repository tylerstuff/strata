import { open } from 'node:fs/promises';

const MAX_STATUS_BYTES = 64 * 1024;
const MAX_READ_CALLS = 128;
const validPid = value => Number.isSafeInteger(value) && value > 0;
const problem = (code, message) => Object.assign(new Error(message), { code });
const invalid = message => problem('INVALID_PROC_NAMESPACE', message);

/**
 * Namespace-coordinate evidence only, under the genuine fixed procfs and
 * cooperating-host assumptions. A single NStgid entry is required; matching
 * numbers in multiple namespace levels must not be treated as equivalent.
 */
export function parseLinuxNamespaceStatus(text, checkerPid = process.pid) {
  if (!validPid(checkerPid)) throw invalid('Expected a positive safe checker PID');
  if (typeof text !== 'string') throw invalid('Proc namespace status must be text');
  if (text.length > MAX_STATUS_BYTES || Buffer.byteLength(text, 'utf8') > MAX_STATUS_BYTES) {
    throw invalid('Proc namespace status exceeded its byte limit');
  }
  const bytes = Buffer.from(text, 'utf8');
  if (!text.endsWith('\n') || text.includes('\0') || text.startsWith('\ufeff')
    || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== text) {
    throw invalid('Proc namespace status is oversized, incomplete, or malformed');
  }
  // Include malformed attempts at this field in the ambiguity check. Other
  // status fields are not namespace evidence and are deliberately not retained.
  const fields = text.split('\n').filter(line => /^\s*NStgid(?:\s|:|$)/u.test(line));
  if (fields.length !== 1) throw invalid('Proc namespace status must contain exactly one NStgid field');
  const match = /^NStgid:[\t ]+([1-9][0-9]*)[\t ]*$/.exec(fields[0]);
  if (!match || !validPid(Number(match[1])) || Number(match[1]) !== checkerPid) {
    throw invalid('Proc namespace status must contain one canonical NStgid equal to the checker PID');
  }
  return { checkerPid, nstgid: checkerPid, valueCount: 1, byteCount: bytes.length };
}

/**
 * Own one diagnostic descriptor; the tracker owns its observation deadline and
 * resource accounting. Reads reach actual EOF, and close waits for actual I/O.
 * A concurrent read shares the first read's lease and promise.
 */
export function createLinuxNamespaceProvider({ openFile = open, checkerPid = process.pid } = {}) {
  if (typeof openFile !== 'function' || !validPid(checkerPid)) throw invalid('Invalid namespace provider options');
  return {
    async open() {
      const handle = await openFile('/proc/self/status', 'r');
      let reading, closing;
      return {
        read(isUsable = () => true) {
          if (closing) return Promise.reject(problem('PROC_NAMESPACE_HANDLE_CLOSED', 'Proc namespace handle is closing'));
          if (typeof isUsable !== 'function') return Promise.reject(invalid('Namespace read requires a lease predicate'));
          if (!reading) reading = Promise.resolve().then(async () => {
            const bytes = Buffer.alloc(MAX_STATUS_BYTES + 1);
            let offset = 0;
            const checkLease = () => {
              if (closing || isUsable() !== true) throw problem('IDENTITY_TIMEOUT', 'Proc namespace observation was interrupted or expired');
            };
            for (let calls = 0; calls < MAX_READ_CALLS; calls++) {
              // Check inside the scheduled work, before every actual syscall.
              checkLease();
              const length = bytes.length - offset;
              const result = await handle.read(bytes, offset, length, offset);
              checkLease();
              const bytesRead = result?.bytesRead;
              if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
                throw invalid('Proc namespace read returned an invalid byte count');
              }
              offset += bytesRead;
              if (offset > MAX_STATUS_BYTES) throw invalid('Proc namespace status exceeded its byte limit');
              if (bytesRead === 0) {
                let text;
                try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset)); }
                catch { throw invalid('Proc namespace status contains invalid UTF-8'); }
                return parseLinuxNamespaceStatus(text, checkerPid);
              }
            }
            throw invalid('Proc namespace status did not reach EOF within its read limit');
          }).finally(() => { reading = undefined; });
          return reading;
        },
        close() {
          // Mark closing before scheduled work can begin another read. Even an
          // expired read remains owned until its underlying syscall settles.
          if (!closing) closing = Promise.resolve().then(async () => {
            if (reading) await reading.catch(() => {});
            await handle.close();
          });
          return closing;
        },
      };
    },
  };
}
