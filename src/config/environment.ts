import { z } from 'zod';

/**
 * Configuration is read once, at startup, and validated.
 *
 * If something is missing the process must die immediately with a clear
 * message. The alternative is an app that starts fine and then fails at
 * three in the morning on the one request that needed that variable.
 */
const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),

  // Long enough that it cannot be brute-forced. Anyone holding this secret
  // can mint tokens for any user, so it never goes in the repository.
  JWT_SECRET: z.string().min(32),

  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(604_800),
  PORT: z.coerce.number().int().positive().default(3_000),

  // Which browser origins may read this API's answers. A comma-separated
  // list; a trailing `:*` accepts any port on that host.
  //
  // The default covers a local `flutter run -d chrome`, which lands on a
  // different random port every time. A deployed backend must replace it with
  // the real origins — leaving localhost open in production is not dangerous
  // so much as it is a lie about what the service expects.
  WEB_ORIGINS: z
    .string()
    .default('http://localhost:*,http://127.0.0.1:*')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  // The expense and payment forms fill "tipo de cambio" from Binance P2P so
  // nobody types it. All three have defaults that work; override the URL only
  // to point the fetch at a stub in a test.
  BINANCE_P2P_URL: z.url().optional(),
  RATE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  RATE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Environment {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`invalid environment configuration:\n${details}`);
  }

  return result.data;
}
