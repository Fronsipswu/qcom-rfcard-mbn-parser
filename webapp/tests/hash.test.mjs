import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, md5Hex } from "../js/lib/hash.js";

test("sha256 known vectors", () => {
  assert.equal(sha256Hex(new TextEncoder().encode("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("md5 known vectors", () => {
  assert.equal(md5Hex(new TextEncoder().encode("")), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5Hex(new TextEncoder().encode("abc")), "900150983cd24fb0d6963f7d28e17f72");
});

test("sha256/md5 over binary 0x00..0xFF (python hashlib-verified)", () => {
  const full = new Uint8Array(256).map((_, i) => i);
  assert.equal(sha256Hex(full), "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880");
  assert.equal(md5Hex(full), "e2c865db4162bed963bfaa9ef6ac18f0");
});

test("sha256/md5 multi-block 120-byte input (python hashlib-verified)", () => {
  const b120 = new Uint8Array(120).map((_, i) => (i * 7 + 11) % 256);
  assert.equal(sha256Hex(b120), "0a5ea8ffc0eb7f96c1eb4e821a59004964235900e7b50a876a79eeff5015a7b8");
  assert.equal(md5Hex(b120), "f5040457c8221ccb9dcd997bc52adc9c");
});

test("md5 padding edge, length 56 mod 64 (python hashlib-verified)", () => {
  const b56 = new Uint8Array(56).map((_, i) => (i * 13 + 5) % 256);
  assert.equal(md5Hex(b56), "8914ee67ccfeed6534636d8cce582c4b");
  assert.equal(sha256Hex(b56), "86512867c0c0b58974d4a9f76fab04b3ed84c5ae5845bd807f809a7884ec24e5");
});

test("sha256/md5 accept subarray views (parser callers pass views)", () => {
  const buf = new Uint8Array(100).map((_, i) => (i * 31 + 7) % 256);
  const view = buf.subarray(10, 74);
  assert.equal(sha256Hex(view), sha256Hex(new Uint8Array(view)));
  assert.equal(md5Hex(view), md5Hex(new Uint8Array(view)));
});
