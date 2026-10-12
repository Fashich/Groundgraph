/**
 * The Anchor IDL of the Groundgraph program. `src/idl/groundgraph.json` is a byte-for-byte copy of
 * `programs/groundgraph/idl/groundgraph.json` (run `pnpm --filter @groundgraph/sdk sync-idl` after `anchor idl build`;
 * a test fails when the two drift apart).
 */
import idlJson from './idl/groundgraph.json';

export type IdlType =
  | string
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { option: IdlType }
  | { defined: { name: string } };

export interface IdlField {
  name: string;
  type: IdlType;
}

export interface IdlTypeDef {
  name: string;
  type:
    | { kind: 'struct'; fields?: IdlField[] }
    | { kind: 'enum'; variants: { name: string; fields?: IdlField[] }[] };
}

export interface IdlAccountItem {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
  pda?: unknown;
}

export interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccountItem[];
  args: IdlField[];
}

export interface Idl {
  address: string;
  metadata: { name: string; version: string; spec: string };
  instructions: IdlInstruction[];
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  errors: { code: number; name: string; msg?: string }[];
  types: IdlTypeDef[];
}

export const IDL = idlJson as unknown as Idl;

export function idlInstruction(name: string): IdlInstruction {
  const ix = IDL.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`unknown instruction ${name}`);
  return ix;
}

export function idlType(name: string): IdlTypeDef {
  const t = IDL.types.find((x) => x.name === name);
  if (!t) throw new Error(`unknown type ${name}`);
  return t;
}

export function accountDiscriminator(name: string): Uint8Array {
  const a = IDL.accounts.find((x) => x.name === name);
  if (!a) throw new Error(`unknown account ${name}`);
  return Uint8Array.from(a.discriminator);
}

export function eventDiscriminator(name: string): Uint8Array {
  const e = IDL.events.find((x) => x.name === name);
  if (!e) throw new Error(`unknown event ${name}`);
  return Uint8Array.from(e.discriminator);
}

/** Program errors by numeric code (6000+). */
export const PROGRAM_ERRORS: ReadonlyMap<number, { name: string; msg: string }> = new Map(
  IDL.errors.map((e) => [e.code, { name: e.name, msg: e.msg ?? e.name }]),
);

/** Look up a program error name from a numeric custom error code. */
export function programErrorName(code: number): string | undefined {
  return PROGRAM_ERRORS.get(code)?.name;
}
