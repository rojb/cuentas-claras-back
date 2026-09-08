import {
  PAR_RATE_MICROS,
  SETTLEMENT_CURRENCY,
  assertRate,
  isSpendableCurrency,
  type CurrencyCode,
} from '../../domain/currency.js';
import {
  badRequest,
  serviceUnavailable,
} from '../../infrastructure/http/errors.js';
import {
  createBinanceRateProvider,
  type BinanceRateProvider,
} from '../../infrastructure/rates/binance-rate-provider.js';

/**
 * The live exchange rate, the one number about money the app cannot work out
 * on its own.
 *
 * Everything else in the ledger is integer arithmetic; this exists only
 * because a market says so and it moves every few minutes. It is NOT stored
 * against anything and it is NOT what the ledger converts at — an expense
 * still carries its own frozen rate, and this endpoint only fills the field
 * the user would otherwise have typed there.
 *
 * The cache is what keeps a form that re-checks the rate on every currency
 * switch from hammering Binance, and the stale fallback is what keeps a
 * blip in Binance's P2P gateway from turning into a spinner that never
 * resolves. Only when there is nothing cached at all does this fail loudly,
 * and the app falls back to a plain editable field.
 */

export interface CurrentRate {
  readonly currencyCode: CurrencyCode;
  readonly rateMicros: number;
  /** 'par' for USDT, 'binance-p2p' for everything else. */
  readonly source: 'par' | 'binance-p2p';
  readonly fetchedAt: Date;
  /** True when the live fetch failed and this is the last good value. */
  readonly stale: boolean;
}

export interface RateService {
  current(currencyCode: string): Promise<CurrentRate>;
}

export interface RateServiceOptions {
  provider?: BinanceRateProvider;
  /** How long a fetched rate is served before the next one is fetched. */
  ttlMs?: number;
  /** How long to wait on Binance before giving up on this fetch. */
  timeoutMs?: number;
  now?: () => Date;
}

interface CacheEntry {
  rateMicros: number;
  fetchedAt: Date;
}

const FIVE_MINUTES = 5 * 60 * 1000;
const TEN_SECONDS = 10 * 1000;

export function createRateService(
  options: RateServiceOptions = {},
): RateService {
  const provider = options.provider ?? createBinanceRateProvider();
  const ttlMs = options.ttlMs ?? FIVE_MINUTES;
  const timeoutMs = options.timeoutMs ?? TEN_SECONDS;
  const now = options.now ?? (() => new Date());

  const cache = new Map<CurrencyCode, CacheEntry>();

  return {
    async current(currencyCode) {
      if (!isSpendableCurrency(currencyCode)) {
        throw badRequest(
          'unknown_currency',
          `${currencyCode} is not a currency this app records`,
        );
      }

      // One USDT is one USDT. No lookup, no cache, no way for it to be
      // anything else — the same reason assertRate refuses a quoted USDT rate.
      if (currencyCode === SETTLEMENT_CURRENCY) {
        return {
          currencyCode,
          rateMicros: PAR_RATE_MICROS,
          source: 'par',
          fetchedAt: now(),
          stale: false,
        };
      }

      const cached = cache.get(currencyCode);
      const fresh =
        cached !== undefined &&
        now().getTime() - cached.fetchedAt.getTime() < ttlMs;

      if (cached !== undefined && fresh) {
        return {
          currencyCode,
          rateMicros: cached.rateMicros,
          source: 'binance-p2p',
          fetchedAt: cached.fetchedAt,
          stale: false,
        };
      }

      try {
        const rateMicros = await provider(
          currencyCode,
          AbortSignal.timeout(timeoutMs),
        );

        // The ledger's own gate, run here exactly as create-expense.ts runs
        // it before trusting a rate a user typed. A garbage number from
        // Binance is treated as an outage, not written to the cache.
        assertRate(currencyCode, rateMicros);

        const entry: CacheEntry = { rateMicros, fetchedAt: now() };
        cache.set(currencyCode, entry);

        return {
          currencyCode,
          rateMicros,
          source: 'binance-p2p',
          fetchedAt: entry.fetchedAt,
          stale: false,
        };
      } catch {
        if (cached !== undefined) {
          return {
            currencyCode,
            rateMicros: cached.rateMicros,
            source: 'binance-p2p',
            fetchedAt: cached.fetchedAt,
            stale: true,
          };
        }

        throw serviceUnavailable(
          'rate_unavailable',
          'could not reach Binance for a live rate; enter it by hand',
        );
      }
    },
  };
}
