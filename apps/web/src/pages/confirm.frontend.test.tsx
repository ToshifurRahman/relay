import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TICKET_REF } from '@/features/tickets/testing';
import { createQueryClient } from '@/lib/query-client';
import { server } from '@/test/server';

import { ConfirmPage } from './confirm';

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/confirm/abc']}>
        <Routes>
          <Route path="/confirm/:token" element={<ConfirmPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('confirm page — cold or down API', () => {
  it('does not claim the link is expired when the API times out', async () => {
    server.use(
      http.get('/api/notifications/confirm/abc', () => HttpResponse.error(), { once: true })
    );
    renderPage();
    expect(await screen.findByRole('heading', { name: /couldn't check/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /expired or was already used/i })
    ).not.toBeInTheDocument();
  });

  it('does not claim the link is expired on a 502 or 503', async () => {
    server.use(
      http.get('/api/notifications/confirm/abc', () => new HttpResponse(null, { status: 502 }), {
        once: true,
      })
    );
    renderPage();
    expect(await screen.findByRole('heading', { name: /couldn't check/i })).toBeInTheDocument();
  });

  it('offers a retry that recovers the link', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/notifications/confirm/abc', () => new HttpResponse(null, { status: 503 }), {
        once: true,
      }),
      http.get('/api/notifications/confirm/abc', () =>
        HttpResponse.json({
          valid: true,
          referenceNumber: TICKET_REF,
          maskedEmail: 't•••@example.test',
        })
      )
    );
    renderPage();
    const retry = await screen.findByRole('button', { name: /try again/i });
    await user.click(retry);
    expect(await screen.findByRole('heading', { name: 'Confirm your email' })).toBeInTheDocument();
  });

  it('still shows the expired panel when the API says the token is invalid', async () => {
    server.use(
      http.get('/api/notifications/confirm/abc', () => HttpResponse.json({ valid: false }))
    );
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /expired or was already used/i })
    ).toBeInTheDocument();
  });
});
