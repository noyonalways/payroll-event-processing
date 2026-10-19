import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'

// jsdom does not implement crypto.randomUUID; the app generates Idempotency-Key
// values with it, so provide a v4-compatible implementation (kept self-contained
// so the app tsconfig stays free of Node type dependencies).
if (!('randomUUID' in globalThis.crypto)) {
  ;(globalThis.crypto as { randomUUID?: () => string }).randomUUID =
    function randomUUID() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        const v = c === 'x' ? r : (r & 0x3) | 0x8
        return v.toString(16)
      })
    }
}

// The beui components animate with motion/react, which reads
// prefers-reduced-motion at module load. jsdom has no matchMedia and no WAAPI;
// reporting "reduce" keeps the components on their zero-duration path so tests
// stay deterministic and never touch element.animate.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// jsdom has no ResizeObserver; the beui Select measures its panel height with
// one. A no-op stub keeps the component from throwing during render/tests.
if (typeof globalThis !== 'undefined' && !('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver
}

// jsdom has no IntersectionObserver; beUI motion components (such as AnimatedNumber)
// observe viewport intersections. A realistic stub keeps them functional during tests.
if (typeof globalThis !== 'undefined' && !('IntersectionObserver' in globalThis)) {
  class IntersectionObserverStub {
    readonly root: Element | null = null;
    readonly rootMargin: string = '';
    readonly thresholds: ReadonlyArray<number> = [];
    private callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback(
        [
          {
            isIntersecting: true,
            target,
            intersectionRatio: 1,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRect: target.getBoundingClientRect(),
            rootBounds: null,
            time: Date.now(),
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  globalThis.IntersectionObserver =
    IntersectionObserverStub as unknown as typeof IntersectionObserver;
}

// vitest runs without globals, so React Testing Library's auto-cleanup never
// registers; unmount every rendered tree after each test explicitly.
afterEach(() => cleanup())