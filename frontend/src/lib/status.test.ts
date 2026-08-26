import { describe, expect, it } from 'vitest';

import { isTerminal, statusBadge, STATUS_BADGES } from './status';

describe('isTerminal', () => {
  it('treats success and failed as terminal', () => {
    expect(isTerminal('success')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
  });

  it('treats all non-terminal lifecycle states as non-terminal', () => {
    expect(isTerminal('received')).toBe(false);
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('processing')).toBe(false);
  });
});

describe('statusBadge', () => {
  it('maps every lifecycle status plus unavailable to a label and color', () => {
    const covered: string[] = [];
    for (const [status, style] of Object.entries(STATUS_BADGES)) {
      covered.push(status);
      expect(style.label.length).toBeGreaterThan(0);
      expect(style.className.length).toBeGreaterThan(0);
    }
    expect(covered.sort()).toEqual(
      [
        'received',
        'queued',
        'processing',
        'success',
        'failed',
        'unavailable',
      ].sort(),
    );
  });

  it('uses distinct color classes per state so transitions are legible', () => {
    const classes = Object.values(STATUS_BADGES).map(
      (style) => style.className,
    );
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('returns the mapping for a sum type status', () => {
    expect(statusBadge('success')).toEqual(STATUS_BADGES.success);
    expect(statusBadge('unavailable').label).toBe('Unavailable');
  });
});