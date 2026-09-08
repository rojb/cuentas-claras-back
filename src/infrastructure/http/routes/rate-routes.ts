import { Router } from 'express';
import type { TokenSettings } from '../../../application/auth/tokens.js';
import type { RateService } from '../../../application/rates/current-rate.js';
import { authenticate } from '../authenticate.js';
import { pathParams } from '../params.js';

/**
 * GET /rates/:currencyCode — what one USDT is worth right now.
 *
 * The one rate the app cannot know on its own. This endpoint exists so the
 * expense and payment forms can fill the "tipo de cambio" field from Binance
 * instead of two friends at a restaurant having to agree on a number. The
 * value still travels back on the expense and is still frozen there: this
 * removes the typing, not the freezing.
 *
 *   200 { currencyCode, rateMicros, source, fetchedAt, stale }
 *   400 unknown_currency   — not one of USDT / BOB / USD
 *   503 rate_unavailable   — Binance unreachable and nothing cached
 */
export function rateRoutes(tokens: TokenSettings, rates: RateService): Router {
  const routes = Router();

  // A rate is not secret, but everything else behind this API needs a token
  // and there is no reason for this to be the one open door.
  routes.use(authenticate(tokens));

  routes.get('/:currencyCode', async (req, res) => {
    const currencyCode = String(
      pathParams(req).currencyCode ?? '',
    ).toUpperCase();

    const rate = await rates.current(currencyCode);

    res.json({
      currencyCode: rate.currencyCode,
      rateMicros: rate.rateMicros,
      source: rate.source,
      fetchedAt: rate.fetchedAt.toISOString(),
      stale: rate.stale,
    });
  });

  return routes;
}
