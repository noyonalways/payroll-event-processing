import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebhookDelivery, WebhookEndpoint } from '../lib/types';
import { setSession } from '../lib/session';
import { WebhooksView } from './WebhooksView';

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

const endpoint = (overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  id: 'ep-1',
  label: 'hris',
  url: 'https://integrator.example.com/hooks',
  active: true,
  createdAt: '2026-10-16T09:00:00.000Z',
  updatedAt: '2026-10-16T09:00:00.000Z',
  ...overrides,
});

const delivery = (overrides: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id: 'd-1',
  webhookEndpointId: 'ep-1',
  url: 'https://integrator.example.com/hooks',
  eventId: 'evt-aaaaaaaa',
  terminalStatus: 'FAILED',
  payload: { eventId: 'evt-aaaaaaaa', status: 'FAILED' },
  status: 'DEAD_LETTERED',
  attempts: 3,
  nextAttemptAt: null,
  deliveredAt: null,
  deadLetterReason: 'retries_exhausted',
  createdAt: '2026-10-16T10:00:00.000Z',
  attemptTrail: [
    {
      id: 'att-1',
      attemptNumber: 1,
      outcome: 'FAILED',
      responseStatus: 503,
      error: null,
      createdAt: '2026-10-16T10:00:05.000Z',
    },
  ],
  ...overrides,
});

describe('WebhooksView', () => {
  it('a MEMBER sees the read-only surfaces — no create form, no toggle/delete', async () => {
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
    fetchMock
      .mockResolvedValueOnce(jsonResponse([endpoint()]))
      .mockResolvedValueOnce(jsonResponse([delivery()]));

    render(<WebhooksView />);

    await waitFor(() => expect(screen.getByTestId('endpoint-hris')).toBeInTheDocument());
    expect(screen.queryByTestId('webhook-create-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId(/endpoint-toggle-/)).not.toBeInTheDocument();
    expect(screen.queryByTestId(/endpoint-delete-/)).not.toBeInTheDocument();
    // Deliveries ARE readable for members (observability by design).
    expect(await screen.findByTestId('delivery-d-1')).toBeInTheDocument();
  });

  it('the OWNER registers an endpoint and the signing secret is shown EXACTLY once', async () => {
    const user = userEvent.setup();
    // Mount refresh consumes #1 (no deliveries fetch — nothing selected).
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    // The POST is #2; the post-create refresh is #3 (now showing the row).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...endpoint(), signingSecret: 'once-only-secret' }, 201),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse([endpoint()]));
    render(<WebhooksView />);

    await waitFor(() => expect(screen.getByTestId('webhook-create-form')).toBeInTheDocument());
    await user.type(screen.getByTestId('webhook-label'), 'hris');
    await user.type(screen.getByTestId('webhook-url'), 'https://integrator.example.com/hooks');
    await user.click(screen.getByTestId('webhook-create'));

    await waitFor(() =>
      expect(screen.getByTestId('webhook-secret-once')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('webhook-secret-once').textContent).toContain('once-only-secret');
  });

  it('a dead-lettered delivery opens its attempt trail for debugging', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([endpoint()]))
      .mockResolvedValueOnce(jsonResponse([delivery()]));

    render(<WebhooksView />);

    await waitFor(() => expect(screen.getByTestId('delivery-d-1')).toBeInTheDocument());
    expect(screen.getByText('DEAD_LETTERED · retries_exhausted'.toLowerCase())).toBeInTheDocument();
    expect(screen.queryByTestId('delivery-detail')).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByTestId('delivery-open-d-1'));

    const detail = await screen.findByTestId('delivery-detail');
    expect(detail.textContent).toContain('#1 FAILED · 503');
  });

  it('create errors (409 duplicate label) surface through the action error', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'already exists' }, 409));
    render(<WebhooksView />);

    await waitFor(() => expect(screen.getByTestId('webhook-create-form')).toBeInTheDocument());
    await user.type(screen.getByTestId('webhook-label'), 'hris');
    await user.type(screen.getByTestId('webhook-url'), 'https://x.example/h');
    await user.click(screen.getByTestId('webhook-create'));

    await waitFor(() => expect(screen.getByTestId('webhooks-action-error')).toBeInTheDocument());
    expect(screen.getByTestId('webhooks-action-error').textContent).toContain('already exists');
  });
});
