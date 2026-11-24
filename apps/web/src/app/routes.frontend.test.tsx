import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpsLayout } from '@/app/layout/ops-layout';
import { PublicLayout } from '@/app/layout/public-layout';
import { createQueryClient } from '@/lib/query-client';

// A route that throws during render, the way a bad prop or a failed lazy chunk would.
function Crash(): React.ReactElement {
  throw new Error('render blew up in this route');
}

function renderShell(layout: React.ReactElement, path: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={layout}>
            <Route path={path} element={<Crash />} />
          </Route>
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

describe('route-level error boundaries', () => {
  it('keeps the public shell and shows recovery when a page throws', () => {
    renderShell(<PublicLayout />, '/boom');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('keeps the ops shell and shows recovery when a console view throws', () => {
    renderShell(<OpsLayout />, '/ops');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('does not leak the thrown message into the shell', () => {
    renderShell(<PublicLayout />, '/boom');
    expect(document.body.textContent).not.toMatch(/render blew up/);
  });
});
