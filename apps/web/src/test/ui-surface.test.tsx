// Verifies the vendored beUI surface is reachable from the app: the slug
// subpaths resolve, the root barrel resolves, and components actually render.
// Guards against the failure mode where packages/ui drifts and the app only
// notices at runtime.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AnimatedBadge } from '@repo/ui/animated-badge';
import { Button, Card, Loader } from '@repo/ui';
import { Loader as LoaderBySlug } from '@repo/ui/loader';
import { cn } from '@repo/ui/lib/utils';

describe('@repo/ui beUI surface', () => {
  it('exposes the shared cn helper', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });

  it('renders AnimatedBadge from its slug subpath', () => {
    render(<AnimatedBadge status="success">Completed</AnimatedBadge>);
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('resolves the same Loader from the barrel and the slug subpath', () => {
    expect(LoaderBySlug).toBe(Loader);
  });

  it('renders root-barrel components', () => {
    render(
      <Card>
        <Button>Save</Button>
      </Card>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('renders Loader from its slug subpath', () => {
    const { container } = render(<LoaderBySlug variant="dots" />);
    expect(container.firstChild).not.toBeNull();
  });
});
