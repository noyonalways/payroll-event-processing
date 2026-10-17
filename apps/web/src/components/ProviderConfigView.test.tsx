import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setSession } from '../lib/session';
import { ProviderConfigView } from './ProviderConfigView';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setSession({
    user: { id: 'u-owner', email: 'owner@acme.example', name: 'Ada' },
    organization: { id: 'org-1', name: 'Acme Payroll', slug: 'acme' },
    role: 'OWNER',
    accessToken: 'a',
    refreshToken: 'r',
    tokenType: 'Bearer',
    expiresIn: '15m',
    refreshExpiresAt: '2026-11-14T12:00:00.000Z',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('ProviderConfigView', () => {
  it('a MEMBER is told only the OWNER configures the provider (no form rendered)', () => {
    setSession({
      user: { id: 'u-m', email: 'm@acme.example', name: 'Mem' },
      organization: { id: 'org-1', name: 'Acme Payroll', slug: 'acme' },
      role: 'MEMBER',
      accessToken: 'a',
      refreshToken: 'r',
      tokenType: 'Bearer',
      expiresIn: '15m',
      refreshExpiresAt: '2026-11-14T12:00:00.000Z',
    });

    render(<ProviderConfigView />);
    expect(screen.getByTestId('provider-forbidden')).toBeInTheDocument();
  });

  it('the unconfigured state reads as the simulated default — friendly, not an error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'none' }, 404));
    render(<ProviderConfigView />);

    await waitFor(() => expect(screen.getByTestId('provider-form')).toBeInTheDocument());
    expect(screen.getByTestId('provider-current').textContent).toContain('simulated');
  });

  it('saving an HTTP config shows the credential EXACTLY once (reads redact it)', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'none' }, 404))
      // Save (the PUT)
      .mockResolvedValueOnce(
        jsonResponse({ mode: 'HTTP', baseUrl: 'https://pay.example/x', credential: 'cred-once-1' }, 201),
      )
      // The post-save refresh read redacts the credential.
      .mockResolvedValueOnce(jsonResponse({ mode: 'HTTP', baseUrl: 'https://pay.example/x' }));

    render(<ProviderConfigView />);

    await waitFor(() => expect(screen.getByTestId('provider-mode')).toBeInTheDocument());
    await user.click(screen.getByTestId('provider-mode'));
    await user.click(screen.getByRole('option', { name: 'External HTTP endpoint' }));
    await user.type(screen.getByTestId('provider-base-url'), 'https://pay.example/x');
    await user.type(screen.getByTestId('provider-credential'), 'cred-once-1');
    await user.click(screen.getByTestId('provider-save'));

    await waitFor(() =>
      expect(screen.getByTestId('provider-credential-once')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('provider-credential-once').textContent).toContain('cred-once-1');
    // The refreshed "current" card shows the URL but never the credential.
    expect(screen.getByTestId('provider-current').textContent).not.toContain('cred-once-1');
  });

  it('delete returns to the simulated default with a confirmation of the card state', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ mode: 'HTTP', baseUrl: 'https://pay.example/x' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ message: 'none' }, 404));

    render(<ProviderConfigView />);

    await waitFor(() => expect(screen.getByTestId('provider-delete')).toBeInTheDocument());
    await user.click(screen.getByTestId('provider-delete'));

    await waitFor(() => expect(screen.getByTestId('provider-current').textContent).toContain('simulated'));
  });
});
