/**
 * Minimal IDL-driven Borsh codec. Field names are converted to camelCase, u64/i64/u128/i128 are `bigint`, smaller
 * integers are `number`, pubkeys are `PublicKey`, `[u8; N]` and `Vec<u8>` are `Uint8Array`, unit enums are lowercase
 * strings ('close', 'above') and `Option<T>` is `T | null`.
 */
import { PublicKey } from '@solana/web3.js';
import { idlType, type IdlField, type IdlType } from './idl';

export const camel = (s: string): string => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export class BorshReader {
  offset = 0;
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number): void {
    if (this.offset + n > this.bytes.byteLength) throw new RangeError(`borsh: read of ${n} bytes past end of buffer`);
  }
  u8(): number { this.need(1); return this.view.getUint8(this.offset++); }
  i8(): number { this.need(1); return this.view.getInt8(this.offset++); }
  u16(): number { this.need(2); const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  u64(): bigint { this.need(8); const v = this.view.getBigUint64(this.offset, true); this.offset += 8; return v; }
  i64(): bigint { this.need(8); const v = this.view.getBigInt64(this.offset, true); this.offset += 8; return v; }
  u128(): bigint { const lo = this.u64(); const hi = this.u64(); return (hi << 64n) | lo; }
  i128(): bigint { const v = this.u128(); return v >= 1n << 127n ? v - (1n << 128n) : v; }
  bool(): boolean { return this.u8() !== 0; }
  take(n: number): Uint8Array {
    this.need(n);
    const v = Uint8Array.from(this.bytes.subarray(this.offset, this.offset + n));
    this.offset += n;
    return v;
  }
  pubkey(): PublicKey { return new PublicKey(this.take(32)); }
  string(): string { const n = this.u32(); return dec.decode(this.take(n)); }
}

export class BorshWriter {
  private parts: Uint8Array[] = [];
  private push(n: number, fn: (v: DataView) => void): this {
    const b = new Uint8Array(n);
    fn(new DataView(b.buffer));
    this.parts.push(b);
    return this;
  }
  u8(v: number): this { return this.push(1, (d) => d.setUint8(0, v)); }
  i8(v: number): this { return this.push(1, (d) => d.setInt8(0, v)); }
  u16(v: number): this { return this.push(2, (d) => d.setUint16(0, v, true)); }
  i16(v: number): this { return this.push(2, (d) => d.setInt16(0, v, true)); }
  u32(v: number): this { return this.push(4, (d) => d.setUint32(0, v, true)); }
  i32(v: number): this { return this.push(4, (d) => d.setInt32(0, v, true)); }
  u64(v: bigint): this { return this.push(8, (d) => d.setBigUint64(0, v, true)); }
  i64(v: bigint): this { return this.push(8, (d) => d.setBigInt64(0, v, true)); }
  u128(v: bigint): this { return this.push(16, (d) => { d.setBigUint64(0, v & 0xffff_ffff_ffff_ffffn, true); d.setBigUint64(8, v >> 64n, true); }); }
  i128(v: bigint): this { return this.u128(v < 0n ? v + (1n << 128n) : v); }
  bool(v: boolean): this { return this.u8(v ? 1 : 0); }
  raw(v: Uint8Array): this { this.parts.push(Uint8Array.from(v)); return this; }
  pubkey(v: PublicKey): this { return this.raw(v.toBytes()); }
  string(v: string): this { const b = enc.encode(v); this.u32(b.length); return this.raw(b); }
  done(): Uint8Array {
    const n = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

function toBigint(v: unknown, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  throw new TypeError(`${what}: expected a bigint`);
}

function toInt(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new RangeError(`${what}: expected an integer in ${min}..${max}, got ${String(v)}`);
  return v;
}

function checkRange(v: bigint, bits: number, signed: boolean, what: string): bigint {
  const lo = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const hi = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  if (v < lo || v > hi) throw new RangeError(`${what}: ${v} out of range for ${signed ? 'i' : 'u'}${bits}`);
  return v;
}

export function readType(r: BorshReader, t: IdlType): unknown {
  if (typeof t === 'string') {
    switch (t) {
      case 'u8': return r.u8();
      case 'i8': return r.i8();
      case 'u16': return r.u16();
      case 'i16': return r.i16();
      case 'u32': return r.u32();
      case 'i32': return r.i32();
      case 'u64': return r.u64();
      case 'i64': return r.i64();
      case 'u128': return r.u128();
      case 'i128': return r.i128();
      case 'bool': return r.bool();
      case 'string': return r.string();
      case 'pubkey': return r.pubkey();
      default: throw new Error(`unsupported idl type ${t}`);
    }
  }
  if ('array' in t) {
    const [inner, n] = t.array;
    if (inner === 'u8') return r.take(n);
    return Array.from({ length: n }, () => readType(r, inner));
  }
  if ('vec' in t) {
    const n = r.u32();
    if (t.vec === 'u8') return r.take(n);
    return Array.from({ length: n }, () => readType(r, t.vec));
  }
  if ('option' in t) return r.u8() === 0 ? null : readType(r, t.option);
  return readDefined(r, t.defined.name);
}

function readFields(r: BorshReader, fields: IdlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[camel(f.name)] = readType(r, f.type);
  return out;
}

export function readDefined(r: BorshReader, name: string): unknown {
  const def = idlType(name).type;
  if (def.kind === 'struct') return readFields(r, def.fields ?? []);
  const tag = r.u8();
  const variant = def.variants[tag];
  if (!variant) throw new RangeError(`${name}: invalid enum tag ${tag}`);
  const vname = variant.name.toLowerCase();
  if (!variant.fields || variant.fields.length === 0) return vname;
  return { variant: vname, ...readFields(r, variant.fields) };
}

export function writeType(w: BorshWriter, t: IdlType, v: unknown, what: string): void {
  if (typeof t === 'string') {
    switch (t) {
      case 'u8': w.u8(toInt(v, what, 0, 0xff)); return;
      case 'i8': w.i8(toInt(v, what, -128, 127)); return;
      case 'u16': w.u16(toInt(v, what, 0, 0xffff)); return;
      case 'i16': w.i16(toInt(v, what, -32768, 32767)); return;
      case 'u32': w.u32(toInt(v, what, 0, 0xffff_ffff)); return;
      case 'i32': w.i32(toInt(v, what, -(2 ** 31), 2 ** 31 - 1)); return;
      case 'u64': w.u64(checkRange(toBigint(v, what), 64, false, what)); return;
      case 'i64': w.i64(checkRange(toBigint(v, what), 64, true, what)); return;
      case 'u128': w.u128(checkRange(toBigint(v, what), 128, false, what)); return;
      case 'i128': w.i128(checkRange(toBigint(v, what), 128, true, what)); return;
      case 'bool': w.bool(Boolean(v)); return;
      case 'string': w.string(String(v)); return;
      case 'pubkey': w.pubkey(v as PublicKey); return;
      default: throw new Error(`unsupported idl type ${t}`);
    }
  }
  if ('array' in t) {
    const [inner, n] = t.array;
    if (inner === 'u8') {
      const b = v as Uint8Array;
      if (!(b instanceof Uint8Array) || b.length !== n) throw new RangeError(`${what}: expected ${n} bytes`);
      w.raw(b);
      return;
    }
    const a = v as unknown[];
    if (!Array.isArray(a) || a.length !== n) throw new RangeError(`${what}: expected ${n} items`);
    a.forEach((x, i) => writeType(w, inner, x, `${what}[${i}]`));
    return;
  }
  if ('vec' in t) {
    if (t.vec === 'u8') { const b = v as Uint8Array; w.u32(b.length); w.raw(b); return; }
    const a = v as unknown[];
    w.u32(a.length);
    a.forEach((x, i) => writeType(w, t.vec, x, `${what}[${i}]`));
    return;
  }
  if ('option' in t) {
    if (v === null || v === undefined) { w.u8(0); return; }
    w.u8(1);
    writeType(w, t.option, v, what);
    return;
  }
  writeDefined(w, t.defined.name, v, what);
}

function writeFields(w: BorshWriter, fields: IdlField[], obj: Record<string, unknown>, what: string): void {
  for (const f of fields) writeType(w, f.type, obj[camel(f.name)], `${what}.${camel(f.name)}`);
}

export function writeDefined(w: BorshWriter, name: string, v: unknown, what: string): void {
  const def = idlType(name).type;
  if (def.kind === 'struct') {
    if (v === null || typeof v !== 'object') throw new TypeError(`${what}: expected an object for ${name}`);
    writeFields(w, def.fields ?? [], v as Record<string, unknown>, what);
    return;
  }
  const vname = typeof v === 'string' ? v : (v as { variant?: string } | null)?.variant;
  const tag = def.variants.findIndex((x) => x.name.toLowerCase() === String(vname).toLowerCase());
  if (tag < 0) throw new RangeError(`${what}: unknown ${name} variant ${String(vname)}`);
  w.u8(tag);
  const fields = def.variants[tag]!.fields;
  if (fields && fields.length > 0) writeFields(w, fields, v as Record<string, unknown>, what);
}

/** Decode one named IDL type from the start of `bytes` (trailing bytes are ignored). */
export function decodeDefined<T>(name: string, bytes: Uint8Array): T {
  return readDefined(new BorshReader(bytes), name) as T;
}

/** Encode one named IDL type. */
export function encodeDefined(name: string, value: unknown): Uint8Array {
  const w = new BorshWriter();
  writeDefined(w, name, value, name);
  return w.done();
}

/** Encode a list of instruction arguments in IDL order. `values` is keyed by camelCase argument name. */
export function encodeArgs(args: IdlField[], values: Record<string, unknown>): Uint8Array {
  const w = new BorshWriter();
  for (const a of args) writeType(w, a.type, values[camel(a.name)], camel(a.name));
  return w.done();
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
