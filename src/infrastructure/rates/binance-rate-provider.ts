import {
  SETTLEMENT_CURRENCY,
  parseRateToMicros,
  type CurrencyCode,
} from '../../domain/currency.js';

/**
 * What one USDT costs on Binance right now, in a spendable fiat.
 *
 * Binance has no spot market for bolivianos — BOB only ever trades peer to
 * peer — so this reads the P2P order book, the same page somebody in Santa
 * Cruz opens to check "el dólar Binance". The endpoint is not part of
 * Binance's documented API; it is the one the P2P web app calls, and it can
 * change shape or start refusing us without notice. That is why the service
 * on top of this caches, falls back to the last good value, and ultimately
 * lets the user type the rate by hand.
 *
 * SELL side, not BUY. We are pricing money somebody already spent: Ana paid
 * Bs 696 for dinner, and what that was worth in USDT is what she would have
 * received selling USDT to raise those bolivianos — the SELL book, the lower
 * and more conservative quote. Reading the BUY book instead would value every
 * boliviano expense slightly high and quietly inflate what people owe.
 */

const DEFAULT_P2P_URL =
  'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

/** How many live ads to read before taking the one in the middle. */
const SAMPLE_ROWS = 15;

const TRADE_TYPE = 'SELL';

export type BinanceRateProvider = (
  currencyCode: CurrencyCode,
  signal: AbortSignal,
) => Promise<number>;

export function createBinanceRateProvider(
  p2pUrl: string = DEFAULT_P2P_URL,
): BinanceRateProvider {
  return async (currencyCode, signal) => {
    if (currencyCode === SETTLEMENT_CURRENCY) {
      // The caller short-circuits this; a P2P search for "USDT priced in
      // USDT" would come back empty and look exactly like an outage.
      throw new Error(`${SETTLEMENT_CURRENCY} has no rate to look up`);
    }

    const response = await fetch(p2pUrl, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // Binance's P2P gateway answers requests that look like the browser
        // making them and stays quiet for the rest. This header is the
        // fragile part of the integration and the first thing to check if
        // rates stop coming through.
        'user-agent':
          'Mozilla/5.0 (compatible; cuentas-claras/1.0; +rate-sync)',
      },
      body: JSON.stringify({
        fiat: currencyCode,
        asset: SETTLEMENT_CURRENCY,
        tradeType: TRADE_TYPE,
        page: 1,
        rows: SAMPLE_ROWS,
        payTypes: [],
        countries: [],
        publisherType: null,
      }),
    });

    if (!response.ok) {
      throw new Error(`Binance P2P answered ${response.status}`);
    }

    const payload = (await response.json()) as {
      code?: string;
      message?: string | null;
      data?: { adv?: { price?: string } }[];
    };

    if (payload.code !== undefined && payload.code !== '000000') {
      throw new Error(
        `Binance P2P rejected the query: ${payload.message ?? payload.code}`,
      );
    }

    const prices = (payload.data ?? [])
      .map((ad) => ad.adv?.price)
      .filter((price): price is string => typeof price === 'string')
      .map((price) => parseRateToMicros(price))
      .sort((a, b) => a - b);

    if (prices.length === 0) {
      throw new Error('Binance P2P returned no usable ads');
    }

    // The lower of the two middle values when the count is even: a plain
    // integer, picked the same way every time, never the average of two ads
    // that would put a fraction of a millionth back into the number.
    return prices[Math.floor((prices.length - 1) / 2)] ?? prices[0]!;
  };
}
