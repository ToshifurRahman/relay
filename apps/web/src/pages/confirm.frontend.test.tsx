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

describe('confirm page — the confirm click (POST)', () => {
  const validPreview = () =>
    HttpResponse.json({
      valid: true,
      referenceNumber: TICKET_REF,
      maskedEmail: 't•••@example.test',
    });

  it('offers a retry for an outage on the click and recovers', async () => {
    const user = userEvent.setup();
    let posts = 0;
    server.use(
      http.get('/api/notifications/confirm/abc', validPreview),
      http.post('/api/notifications/confirm', () => {
        posts++;
        if (posts === 1) return new HttpResponse(null, { status: 502 });
        return HttpResponse.json({
          referenceNumber: TICKET_REF,
          status: 'processing',
          maskedEmail: 't•••@example.test',
        });
      })
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Confirm' }));

    // A 502 mid-click is not a spent token: the page must not say the link is dead.
    expect(
      await screen.findByRole('heading', { name: /couldn't confirm just now/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /expired or was already used/i })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByRole('heading', { name: "You're all set" })).toBeInTheDocument();
    expect(posts).toBe(2);
  });

  it('claims the link is expired only when the click answers 410', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/notifications/confirm/abc', validPreview),
      http.post('/api/notifications/confirm', () => new HttpResponse(null, { status: 410 }))
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByRole('heading', { name: /expired or was already used/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /couldn't confirm just now/i })
    ).not.toBeInTheDocument();
  });
});
