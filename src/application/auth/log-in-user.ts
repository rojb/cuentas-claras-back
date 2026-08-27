import bcrypt from 'bcryptjs';
import type { Database } from '../../infrastructure/db/pool.js';
import { findUserByEmail } from '../../infrastructure/db/users-repository.js';
import { unauthorized } from '../../infrastructure/http/errors.js';
import { signAccessToken, type TokenSettings } from './tokens.js';
import type { AuthenticatedUser } from './register-user.js';

/**
 * A real bcrypt hash of nothing in particular.
 *
 * When the email does not exist we still run a comparison against this, so
 * that answering takes the same time either way. Without it, a wrong email
 * would reply noticeably faster than a wrong password, and anyone could tell
 * which addresses are registered just by timing the responses.
 */
const DECOY_HASH = bcrypt.hashSync('a password nobody has', 12);

export interface LogInUserInput {
  readonly email: string;
  readonly password: string;
}

export async function logInUser(
  db: Database,
  tokens: TokenSettings,
  input: LogInUserInput,
): Promise<AuthenticatedUser> {
  const user = await findUserByEmail(db, input.email);

  const passwordMatches = await bcrypt.compare(
    input.password,
    user?.passwordHash ?? DECOY_HASH,
  );

  // Same error for "no such email" and "wrong password", on purpose: telling
  // them apart hands an attacker a list of who is registered here.
  if (user === null || !passwordMatches) {
    throw unauthorized('invalid_credentials', 'email or password is incorrect');
  }

  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    accessToken: signAccessToken(user.id, tokens),
  };
}
