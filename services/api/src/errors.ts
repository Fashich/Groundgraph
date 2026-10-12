import type { ApiErrorCode } from '@groundgraph/sdk/api-types';

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  view_only: 403,
  tos_required: 403,
  break_active: 403,
  daily_limit_exceeded: 403,
  oracle_stale: 503,
  market_closed: 409,
  slippage_exceeded: 409,
  below_min_trade: 400,
  insufficient_liquidity: 409,
  not_found: 404,
  rate_limited: 429,
  geo_blocked: 403,
  faucet_unavailable: 503,
  internal: 500,
};

export class ApiHttpError extends Error {
  readonly status: number;
  get statusCode(): number {
    return this.status;
  }
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    status?: number,
  ) {
    super(message);
    this.status = status ?? STATUS[code];
  }
}

export const fail = (code: ApiErrorCode, message: string, details?: unknown): never => {
  throw new ApiHttpError(code, message, details);
};

export function errorBody(code: ApiErrorCode, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}
