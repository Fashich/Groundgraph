import type { DbHandle } from '@groundgraph/db';
import type { ChainReader, Logger, OracleSnapshot, Redis, VolSnapshot } from '@groundgraph/svc-core';
import type { Registry } from 'prom-client';
import type { AppConfig } from './config';

export interface FaucetMinter {
  /** mint `amount` base units of the test USDC to `wallet`'s associated token account; returns the tx signature */
  mint(wallet: string, amount: bigint): Promise<string>;
}

export interface VolProvider {
  /** annualized 30 day realized volatility for an allow-listed asset, from the keeper cache or computed on demand */
  get(assetSymbol: string, feedIdHex: string): Promise<VolSnapshot | null>;
}

export interface AppContext {
  cfg: AppConfig;
  log: Logger;
  db: DbHandle;
  redis: Redis;
  chain: ChainReader;
  registry: Registry;
  faucet: FaucetMinter | null;
  vol: VolProvider;
  now: () => Date;
}

export type { OracleSnapshot };
