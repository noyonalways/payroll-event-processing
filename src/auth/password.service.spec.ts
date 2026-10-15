import { PasswordService } from './password.service';

/**
 * Real scrypt runs in these tests (no mocking): the point of the service is the
 * digest format and the verification semantics, and a mocked KDF would assert
 * nothing about either. The parameter set costs ~100 ms per hash, which is why
 * the suite keeps the number of distinct hashes small.
 */
describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(() => {
    service = new PasswordService();
  });

  describe('hash', () => {
    it('produces a self-describing digest with the recorded cost parameters', async () => {
      const digest = await service.hash('correct-horse-battery');

      // scrypt$N$r$p$salt$hash — verification reads the parameters back from here,
      // so the format is part of the contract, not an implementation detail.
      const parts = digest.split('$');
      expect(parts).toHaveLength(6);
      expect(parts[0]).toBe('scrypt');
      expect(Number(parts[1])).toBe(32768);
      expect(Number(parts[2])).toBe(8);
      expect(Number(parts[3])).toBe(1);
      expect(parts[4].length).toBeGreaterThan(0);
      expect(parts[5].length).toBeGreaterThan(0);
    });

    it('never contains the plaintext', async () => {
      const digest = await service.hash('super-secret-value');
      expect(digest).not.toContain('super-secret-value');
    });

    it('salts every digest so equal passwords differ on disk', async () => {
      const [a, b] = await Promise.all([
        service.hash('same-password-here'),
        service.hash('same-password-here'),
      ]);

      expect(a).not.toBe(b);
    });
  });

  describe('verify', () => {
    it('accepts the correct password and rejects a wrong one', async () => {
      const digest = await service.hash('correct-horse-battery');

      await expect(service.verify('correct-horse-battery', digest)).resolves.toBe(true);
      await expect(service.verify('correct-horse-battery!', digest)).resolves.toBe(false);
    });

    it('verifies against the parameters recorded in the digest, not the current defaults', async () => {
      // A digest produced with weaker historical parameters must still verify —
      // that is what makes raising the cost parameters safe for existing users.
      const weakDigest = await service.hash('legacy-password-1');
      const parts = weakDigest.split('$');
      const weakened = ['scrypt', '16384', parts[2], parts[3], parts[4], parts[5]].join('$');

      // Not a valid digest for this password (the derived key was computed with a
      // different N), so verification must fail rather than silently "pass" or
      // fall back to the current parameters.
      await expect(service.verify('legacy-password-1', weakened)).resolves.toBe(false);
      // And the intact digest still verifies.
      await expect(service.verify('legacy-password-1', weakDigest)).resolves.toBe(true);
    });
  });

  describe('malformed and hostile digests', () => {
    it('returns false (never throws) for structurally invalid digests', async () => {
      const malformed = [
        '',
        'not-a-digest',
        'scrypt$1$2$3',
        'bcrypt$32768$8$1$c2FsdA==$aGFzaA==',
        'scrypt$32768$8$1$$',
        'scrypt$32768$8$1$c2FsdA==$',
      ];

      for (const digest of malformed) {
        await expect(service.verify('anything-at-all', digest)).resolves.toBe(false);
      }
    });

    it('refuses an absurd recorded cost parameter instead of allocating for it', async () => {
      // A corrupt or hostile row must not be able to turn a login attempt into a
      // memory bomb: parameters are bounded before use.
      const hostile = 'scrypt$1073741824$8$1$c2FsdA==$aGFzaA==';

      const started = Date.now();
      await expect(service.verify('anything-at-all', hostile)).resolves.toBe(false);
      // Rejected by validation, so no expensive derivation was attempted.
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('refuses out-of-range block size and parallelization parameters', async () => {
      const digest = await service.hash('some-password-value');
      const parts = digest.split('$');

      const bigBlockSize = [parts[0], parts[1], '9999', parts[3], parts[4], parts[5]].join('$');
      const bigParallelization = [parts[0], parts[1], parts[2], '999', parts[4], parts[5]].join('$');

      await expect(service.verify('some-password-value', bigBlockSize)).resolves.toBe(false);
      await expect(service.verify('some-password-value', bigParallelization)).resolves.toBe(false);
    });
  });
});
