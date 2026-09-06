import assert from 'node:assert/strict';
import test from 'node:test';
import { createLinuxNamespaceProvider, parseLinuxNamespaceStatus } from './preview-process-namespace-linux.mjs';

const PID = 1234;
const valid = `Name:\tworker\nTgid:\t${PID}\nNStgid:\t${PID}\nNSpid:\t9876\n`;
const evidence = text => ({ checkerPid: PID, nstgid: PID, valueCount: 1, byteCount: Buffer.byteLength(text) });
const invalid = { code: 'INVALID_PROC_NAMESPACE' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Every provider in this suite uses fake file I/O. No procfs, signal, subprocess,
// or process-discovery operation is performed, including on Linux hosts.
function fakeFile(contents, chunkSize = Infinity) {
  const source = Buffer.from(contents);
  const calls = [], opens = [], closes = [];
  const handle = {
    async read(buffer, offset, length, position) {
      calls.push({ offset, length, position });
      const bytesRead = Math.min(length, chunkSize, Math.max(0, source.length - position));
      source.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead, buffer };
    },
    async close() { closes.push(true); },
  };
  const provider = createLinuxNamespaceProvider({ checkerPid: PID, openFile: async (...args) => {
    opens.push(args);
    return handle;
  } });
  return { provider, handle, calls, opens, closes };
}

test('returns only the single TGID namespace evidence, preserving UTF-8 byte count', () => {
  const text = `Name:\t猫🐈\nNStgid:\t${PID} \t\nNSpid:\t7\t8\nSecret:\tignored\n`;
  assert.deepEqual(parseLinuxNamespaceStatus(text, PID), evidence(text));
  assert.ok(Buffer.byteLength(text) > text.length);
  assert.deepEqual(parseLinuxNamespaceStatus(`NStgid:\t${process.pid}\n`), {
    checkerPid: process.pid, nstgid: process.pid, valueCount: 1,
    byteCount: Buffer.byteLength(`NStgid:\t${process.pid}\n`),
  });
});

for (const [name, text] of [
  ['missing field despite matching Tgid and NSpid', `Tgid:\t${PID}\nNSpid:\t${PID}\n`],
  ['duplicate field', valid + `NStgid:\t${PID}\n`],
  ['malformed duplicate field', valid + ` NStgid :\t${PID}\n`],
  ['two equal namespace values', `NStgid:\t${PID}\t${PID}\n`],
  ['two different namespace values', `NStgid:\t5678\t${PID}\n`],
  ['wrong process', 'NStgid:\t5678\n'],
  ['zero', 'NStgid:\t0\n'],
  ['negative value', 'NStgid:\t-1234\n'],
  ['plus sign', 'NStgid:\t+1234\n'],
  ['leading zero', 'NStgid:\t01234\n'],
  ['fraction', 'NStgid:\t1234.0\n'],
  ['exponent', 'NStgid:\t1.234e3\n'],
  ['unsafe integer', 'NStgid:\t9007199254740992\n'],
  ['empty value', 'NStgid:\t\n'],
  ['missing colon', `NStgid\t${PID}\n`],
  ['indented field', ` NStgid:\t${PID}\n`],
  ['space before colon', `NStgid :\t${PID}\n`],
  ['missing separator', `NStgid:${PID}\n`],
  ['Unicode separator', `NStgid:\u00a0${PID}\n`],
  ['CRLF field', `NStgid:\t${PID}\r\n`],
  ['missing final newline', valid.slice(0, -1)],
  ['NUL in unrelated field', valid + 'Name:\tbad\0name\n'],
  ['leading BOM', '\ufeff' + valid],
  ['unpaired UTF-16 surrogate', valid + 'Name:\t\ud800\n'],
  ['empty status', ''],
  ['oversized status', valid + 'x'.repeat(65536) + '\n'],
  ['oversized UTF-8 despite shorter character count', valid + '猫'.repeat(25000) + '\n'],
]) test(`rejects ${name} without another-field fallback`, () => {
  assert.throws(() => parseLinuxNamespaceStatus(text, PID), invalid);
});

test('rejects invalid checker PID and non-text input', () => {
  for (const pid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1234', null]) {
    assert.throws(() => parseLinuxNamespaceStatus(valid, pid), invalid);
    assert.throws(() => createLinuxNamespaceProvider({ checkerPid: pid }), invalid);
  }
  for (const text of [undefined, null, Buffer.from(valid), 1234]) assert.throws(() => parseLinuxNamespaceStatus(text, PID), invalid);
  assert.throws(() => createLinuxNamespaceProvider({ openFile: null }), invalid);
});

test('partial positional reads reach actual EOF and retain split multibyte UTF-8', async () => {
  const text = `Name:\t猫🐈\nNStgid:\t${PID}\n`;
  const fake = fakeFile(text, 1);
  const handle = await fake.provider.open();
  assert.deepEqual(fake.opens, [['/proc/self/status', 'r']]);
  assert.deepEqual(await handle.read(), evidence(text));
  assert.equal(fake.calls.length, Buffer.byteLength(text) + 1);
  fake.calls.forEach((call, index) => assert.deepEqual(call, { offset: index, length: 65537 - index, position: index }));
  await handle.close();
  assert.equal(fake.closes.length, 1);
});

test('a complete-looking first chunk is not accepted before a later duplicate and EOF', async () => {
  const prefix = `NStgid:\t${PID}\n`;
  const fake = fakeFile(prefix + prefix, prefix.length);
  const handle = await fake.provider.open();
  await assert.rejects(handle.read(), invalid);
  assert.equal(fake.calls.length, 3);
  await handle.close();
});

function statusWithBytes(size) {
  const prefix = `NStgid:\t${PID}\nName:\t`;
  return prefix + 'x'.repeat(size - Buffer.byteLength(prefix) - 1) + '\n';
}

test('exact 64 KiB requires a separate EOF sentinel read and is accepted', async () => {
  const text = statusWithBytes(65536);
  const fake = fakeFile(text);
  const handle = await fake.provider.open();
  assert.deepEqual(await handle.read(), evidence(text));
  assert.deepEqual(fake.calls, [
    { offset: 0, length: 65537, position: 0 },
    { offset: 65536, length: 1, position: 65536 },
  ]);
  await handle.close();
});

test('overflow sentinel rejects 64 KiB plus one byte without another read', async () => {
  const fake = fakeFile(statusWithBytes(65537));
  const handle = await fake.provider.open();
  await assert.rejects(handle.read(), invalid);
  assert.equal(fake.calls.length, 1);
  await handle.close();
});

test('128th read may establish EOF; no 129th read is scheduled', async () => {
  for (const [bytes, accepted] of [[127, true], [128, false]]) {
    const text = statusWithBytes(bytes), fake = fakeFile(text, 1);
    const handle = await fake.provider.open();
    if (accepted) assert.deepEqual(await handle.read(), evidence(text));
    else await assert.rejects(handle.read(), invalid);
    assert.equal(fake.calls.length, 128);
    await handle.close();
  }
});

for (const [name, source] of [
  ['invalid UTF-8 byte', Buffer.concat([Buffer.from(valid), Buffer.from([0xff, 10])])],
  ['truncated multibyte UTF-8', Buffer.concat([Buffer.from(valid), Buffer.from([0xf0, 0x9f, 10])])],
  ['unterminated final line', Buffer.from(valid.slice(0, -1))],
  ['empty EOF', Buffer.alloc(0)],
]) test(`provider rejects ${name} after bounded EOF read`, async () => {
  const fake = fakeFile(source);
  const handle = await fake.provider.open();
  await assert.rejects(handle.read(), invalid);
  await handle.close();
  assert.equal(fake.closes.length, 1);
});

test('rejects invalid native byte counts without further reads', async () => {
  for (const bytesRead of [-1, 0.5, NaN, Infinity, undefined, '1', 65538]) {
    const fake = fakeFile(valid);
    let calls = 0;
    fake.handle.read = async () => { calls++; return { bytesRead }; };
    const handle = await fake.provider.open();
    await assert.rejects(handle.read(), invalid);
    assert.equal(calls, 1);
    await handle.close();
  }
  const fake = fakeFile(valid);
  fake.handle.read = async () => null;
  const handle = await fake.provider.open();
  await assert.rejects(handle.read(), invalid);
  await handle.close();
});

test('validates byte counts against the remaining request rather than only the global cap', async () => {
  const fake = fakeFile(valid);
  let calls = 0;
  fake.handle.read = async () => ({ bytesRead: ++calls === 1 ? 65536 : 2 });
  const handle = await fake.provider.open();
  await assert.rejects(handle.read(), invalid);
  assert.equal(calls, 2);
  await handle.close();
});

test('concurrent reads share one actual operation; a later read restarts at position zero', async () => {
  const fake = fakeFile(valid), started = deferred(), release = deferred();
  const original = fake.handle.read;
  let first = true;
  fake.handle.read = async (...args) => {
    if (first) { first = false; started.resolve(); await release.promise; }
    return original(...args);
  };
  const handle = await fake.provider.open();
  const a = handle.read(), b = handle.read();
  assert.equal(a, b);
  await started.promise;
  release.resolve();
  assert.deepEqual(await a, evidence(valid));
  assert.deepEqual(await b, evidence(valid));
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(await handle.read(), evidence(valid));
  assert.equal(fake.calls[2].position, 0);
  await handle.close();
});

test('unusable lease prevents the first actual read, including invalidation after scheduling', async () => {
  for (const initiallyUsable of [false, true]) {
    const fake = fakeFile(valid);
    const handle = await fake.provider.open();
    let usable = initiallyUsable;
    const pending = handle.read(() => usable);
    usable = false;
    await assert.rejects(pending, { code: 'IDENTITY_TIMEOUT' });
    assert.equal(fake.calls.length, 0);
    await handle.close();
  }
});

test('expiry during a partial read forbids all later native reads', async () => {
  const fake = fakeFile(valid, 1), original = fake.handle.read;
  let usable = true;
  fake.handle.read = async (...args) => { const result = await original(...args); usable = false; return result; };
  const handle = await fake.provider.open();
  await assert.rejects(handle.read(() => usable), { code: 'IDENTITY_TIMEOUT' });
  assert.equal(fake.calls.length, 1);
  await handle.close();
});

test('expiry on EOF fulfillment cannot publish otherwise-valid evidence', async () => {
  const fake = fakeFile(valid), original = fake.handle.read;
  let usable = true;
  fake.handle.read = async (...args) => {
    const result = await original(...args);
    if (result.bytesRead === 0) usable = false;
    return result;
  };
  const handle = await fake.provider.open();
  await assert.rejects(handle.read(() => usable), { code: 'IDENTITY_TIMEOUT' });
  assert.equal(fake.calls.length, 2);
  await handle.close();
});

test('close waits for a pending native read and invokes actual close exactly once', async () => {
  const fake = fakeFile(valid), started = deferred(), releaseRead = deferred(), releaseClose = deferred();
  fake.handle.read = async () => { started.resolve(); return releaseRead.promise; };
  fake.handle.close = async () => { fake.closes.push(true); await releaseClose.promise; };
  const handle = await fake.provider.open();
  const read = handle.read();
  const readRejected = assert.rejects(read, { code: 'IDENTITY_TIMEOUT' });
  await started.promise;
  const close = handle.close();
  assert.equal(handle.close(), close);
  await Promise.resolve();
  assert.equal(fake.closes.length, 0);
  releaseRead.resolve({ bytesRead: 0 });
  await readRejected;
  await Promise.resolve();
  assert.equal(fake.closes.length, 1);
  let settled = false;
  void close.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  releaseClose.resolve();
  await close;
  assert.equal(handle.close(), close);
  await assert.rejects(handle.read(), { code: 'PROC_NAMESPACE_HANDLE_CLOSED' });
  assert.equal(fake.closes.length, 1);
});

test('close before a scheduled read starts performs no native read', async () => {
  const fake = fakeFile(valid), handle = await fake.provider.open();
  const read = handle.read();
  const rejected = assert.rejects(read, { code: 'IDENTITY_TIMEOUT' });
  await handle.close();
  await rejected;
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.closes.length, 1);
});

test('read rejection is preserved and actual close still runs once', async () => {
  const fake = fakeFile(valid), failure = Object.assign(new Error('denied'), { code: 'EACCES' });
  fake.handle.read = async () => { throw failure; };
  const handle = await fake.provider.open();
  await assert.rejects(handle.read(), error => error === failure);
  await Promise.all([handle.close(), handle.close()]);
  assert.equal(fake.closes.length, 1);
});

test('close failure remains rejected without retry or reopening', async () => {
  const fake = fakeFile(valid), failure = Object.assign(new Error('close failed'), { code: 'EIO' });
  fake.handle.close = async () => { fake.closes.push(true); throw failure; };
  const handle = await fake.provider.open();
  await handle.read();
  const close = handle.close();
  await assert.rejects(close, error => error === failure);
  assert.equal(handle.close(), close);
  await assert.rejects(handle.close(), error => error === failure);
  await assert.rejects(handle.read(), { code: 'PROC_NAMESPACE_HANDLE_CLOSED' });
  assert.equal(fake.closes.length, 1);
  assert.equal(fake.opens.length, 1);
});

test('actual open errors propagate without fallback or retry', async () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EIO']) {
    const failure = Object.assign(new Error('open failed'), { code });
    let calls = 0;
    const provider = createLinuxNamespaceProvider({ checkerPid: PID, openFile: async (path, mode) => {
      calls++;
      assert.equal(path, '/proc/self/status');
      assert.equal(mode, 'r');
      throw failure;
    } });
    await assert.rejects(provider.open(), error => error === failure);
    assert.equal(calls, 1);
  }
});

test('late opened diagnostic handle can be closed once without any read', async () => {
  const fake = fakeFile(valid), opened = deferred();
  const provider = createLinuxNamespaceProvider({ checkerPid: PID, openFile: () => opened.promise });
  const pending = provider.open();
  opened.resolve(fake.handle);
  const handle = await pending;
  await Promise.all([handle.close(), handle.close()]);
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.closes.length, 1);
});
