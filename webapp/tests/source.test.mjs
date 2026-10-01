import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSource, BrowserFileSource, sourceFor } from "../js/lib/source.js";

const SIZE = 64 * 1024;
const pattern = (i) => i & 0xff;

async function makeTempFile() {
  const dir = await mkdtemp(join(tmpdir(), "rfcard-src-"));
  const path = join(dir, "pattern.bin");
  const bytes = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) bytes[i] = pattern(i);
  await writeFile(path, bytes);
  return { dir, path };
}

test("NodeFileSource reads correct bytes at offset and closes", async () => {
  const { dir, path } = await makeTempFile();
  try {
    const src = await NodeFileSource.open(path);
    assert.equal(src.size, SIZE);
    const chunk = await src.read(1000, 16);
    assert.ok(chunk instanceof Uint8Array);
    assert.equal(chunk.length, 16);
    for (let i = 0; i < 16; i++) assert.equal(chunk[i], pattern(1000 + i));
    assert.deepEqual([...(await src.read(0, 4))], [0, 1, 2, 3]);
    await src.close();
    await assert.rejects(() => src.read(0, 4));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NodeFileSource.open accepts an open handle with explicit size", async () => {
  const { dir, path } = await makeTempFile();
  try {
    const fsp = await import("node:fs/promises");
    const handle = await fsp.open(path, "r");
    const src = await NodeFileSource.open(handle, SIZE);
    assert.equal(src.size, SIZE);
    assert.deepEqual([...(await src.read(SIZE - 8, 8))], [0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff]);
    await src.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NodeFileSource.read throws RangeError on short read past EOF", async () => {
  const { dir, path } = await makeTempFile();
  try {
    const src = await NodeFileSource.open(path);
    await assert.rejects(() => src.read(SIZE - 4, 100), RangeError);
    await src.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BrowserFileSource slices a File and closes as no-op", async () => {
  const bytes = new Uint8Array(1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = pattern(i);
  const file = new File([bytes], "img.mbn");
  const src = new BrowserFileSource(file);
  assert.equal(src.size, 1024);
  const chunk = await src.read(500, 8);
  assert.ok(chunk instanceof Uint8Array);
  assert.equal(chunk.length, 8);
  for (let i = 0; i < 8; i++) assert.equal(chunk[i], pattern(500 + i));
  await src.close();
  await assert.rejects(() => src.read(2000, 8), RangeError);
});

test("NodeFileSource.open accepts file:// URLs", async () => {
  const { dir, path } = await makeTempFile();
  try {
    const src = await sourceFor(new URL(`file://${path}`));
    assert.ok(src instanceof NodeFileSource);
    assert.equal(src.size, SIZE);
    assert.deepEqual([...(await src.read(2, 4))], [2, 3, 4, 5]);
    await src.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sourceFor routes strings to Node and File/Blob to browser sources", async () => {
  const { dir, path } = await makeTempFile();
  try {
    const node = await sourceFor(path);
    assert.ok(node instanceof NodeFileSource);
    assert.equal(node.size, SIZE);
    assert.deepEqual([...(await node.read(4096, 4))], [0, 1, 2, 3]);
    await node.close();

    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], "blob.mbn");
    const browser = await sourceFor(file);
    assert.ok(browser instanceof BrowserFileSource);
    assert.equal(browser.size, 5);
    assert.deepEqual([...(await browser.read(1, 3))], [2, 3, 4]);
    await browser.close();

    const fromBlob = await sourceFor(new Blob([new Uint8Array([9, 8, 7])]));
    assert.ok(fromBlob instanceof BrowserFileSource);
    assert.deepEqual([...(await fromBlob.read(0, 2))], [9, 8]);
    await fromBlob.close();

    await assert.rejects(() => sourceFor(42), TypeError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
