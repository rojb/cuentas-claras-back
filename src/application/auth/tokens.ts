import jwt from 'jsonwebtoken';
import { unauthorized } from '../../infrastructure/http/errors.js';

export interface TokenSettings {
  readonly secret: string;
  readonly expiresInSeconds: number;
}

/** Everything the API needs to know about who is making a request. */
export interface Authenticated {
  readonly userId: string;
}

export function signAccessToken(
  userId: string,
  settings: TokenSettings,
): string {
  return jwt.sign({}, settings.secret, {
    subject: userId,
    expiresIn: settings.expiresInSeconds,
  });
}

export function verifyAccessToken(
  token: string,
  settings: TokenSettings,
): Authenticated {
  try {
    const payload = jwt.verify(token, settings.secret);

    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      throw unauthorized('invalid_token', 'the token is not valid');
    }

    return { userId: payload.sub };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw unauthorized('token_expired', 'the session expired, sign in again');
    }
    // Anything else (bad signature, malformed, tampered) is the same answer:
    // we are not telling an attacker which part they got wrong.
    throw unauthorized('invalid_token', 'the token is not valid');
  }
}
