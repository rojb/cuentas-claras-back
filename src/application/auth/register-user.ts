import bcrypt from 'bcryptjs';
import type { Database } from '../../infrastructure/db/pool.js';
import {
  insertUser,
  isUniqueViolation,
} from '../../infrastructure/db/users-repository.js';
import { conflict } from '../../infrastructure/http/errors.js';
import { signAccessToken, type TokenSettings } from './tokens.js';

/**
 * Cost factor for bcrypt: each +1 doubles the time it takes to hash.
 * High enough to make brute force expensive, low enough that signing in
 * does not feel slow.
 */
const PASSWORD_HASH_ROUNDS = 12;

export interface RegisterUserInput {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
}

export interface AuthenticatedUser {
  readonly user: { id: string; email: string; displayName: string };
  readonly accessToken: string;
}

export async function registerUser(
  db: Database,
  tokens: TokenSettings,
  input: RegisterUserInput,
): Promise<AuthenticatedUser> {
  const passwordHash = await bcrypt.hash(input.password, PASSWORD_HASH_ROUNDS);

  try {
    const user = await insertUser(db, {
      email: input.email,
      passwordHash,
      displayName: input.displayName,
    });

    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      accessToken: signAccessToken(user.id, tokens),
    };
  } catch (error) {
    // We do NOT check "does this email exist?" first and then insert. Between
    // those two steps another request could register the same address, and
    // the check would have been useless. The unique index is the real guard;
    // we just translate its complaint into something the client understands.
    if (isUniqueViolation(error)) {
      throw conflict('email_taken', 'that email is already registered');
    }
    throw error;
  }
}
