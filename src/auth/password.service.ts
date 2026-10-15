import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { SCRYPT_PARAMS } from './auth.constants';

const { N, blockSize, parallelization, keyLength, saltBytes, maxmem } = SCRYPT_PARAMS;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing on Node's built-in scrypt (design D6).
 *
 * Why scrypt rather than argon2id: argon2 requires a native module, and the
 * runtime images are `node:20-alpine` (musl), where a native dependency means
 * either a build toolchain in the image or a prebuilt-binary gamble per platform.
 * scrypt ships in `node:crypto`, needs no toolchain, behaves identically on host
 * and in the container, and is an OWASP-accepted alternative to argon2id. The
 * parameter set (N=2^15, r=8, p=1, 32-byte key) sits at OWASP's recommended
 * scrypt floor.
 *
 * Digests are self-describing — `scrypt$N$r$p$salt$hash` — so the cost parameters
 * can be raised later without invalidating existing hashes: verification uses the
 * parameters recorded in each stored digest, not the current constants.
 */
@Injectable()
export class PasswordService {
  async hash(plaintext: string): Promise<string> {
    const salt = randomBytes(saltBytes);
    const derived = await scryptAsync(plaintext, salt, keyLength, {
      N,
      r: blockSize,
      p: parallelization,
      maxmem,
    });
    return [
      'scrypt',
      N,
      blockSize,
      parallelization,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  /**
   * Constant-time verification against a stored digest. Returns false for any
   * malformed or unsupported digest rather than throwing, so a corrupt row can
   * never turn a failed login into a 500.
   */
  async verify(plaintext: string, stored: string): Promise<boolean> {
    const parsed = this.parse(stored);
    if (!parsed) {
      return false;
    }

    const derived = await scryptAsync(plaintext, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem,
    });

    // timingSafeEqual throws on a length mismatch, so the comparison is guarded.
    return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
  }

  /**
   * Parses and sanity-checks a stored digest. The cost parameters come from the
   * database, so they are bounded before use: a hostile or corrupted row must not
   * be able to demand an absurd N and turn a login attempt into a memory bomb.
   */
  private parse(
    stored: string,
  ): { N: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      return null;
    }

    const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
    const parsedN = Number(nRaw);
    const parsedR = Number(rRaw);
    const parsedP = Number(pRaw);

    if (
      !Number.isInteger(parsedN) ||
      !Number.isInteger(parsedR) ||
      !Number.isInteger(parsedP) ||
      parsedN < 2 ||
      parsedN > 1 << 20 ||
      parsedR < 1 ||
      parsedR > 32 ||
      parsedP < 1 ||
      parsedP > 16
    ) {
      return null;
    }

    const salt = Buffer.from(saltRaw, 'base64');
    const hash = Buffer.from(hashRaw, 'base64');
    if (salt.length === 0 || hash.length === 0) {
      return null;
    }

    return { N: parsedN, r: parsedR, p: parsedP, salt, hash };
  }
}
