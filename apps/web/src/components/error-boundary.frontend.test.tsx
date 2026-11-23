import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './error-boundary';

let fault: Error | null = null;

function Child(): React.ReactElement {
  if (fault) throw fault;
  return <p>Recovered content</p>;
}

beforeEach(() => {
  fault = null;
  // React prints the caught error; the test asserts on the recovery UI, not the console.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders its children while nothing throws', () => {
    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>
    );
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
  });

  it('shows a friendly recovery panel instead of a blank screen', () => {
    fault = new Error('db password is hunter2 in /srv/app.js:41');
    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('never leaks the thrown message or stack into the page', () => {
    fault = new Error('db password is hunter2 in /srv/app.js:41');
    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>
    );
    expect(document.body.textContent).not.toMatch(/hunter2/);
    expect(document.body.textContent).not.toMatch(/\/srv\/app\.js/);
  });

  it('offers a link home that does a full navigation', () => {
    fault = new Error('boom');
    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>
    );
    expect(screen.getByRole('link', { name: /home/i })).toHaveAttribute('href', '/');
  });

  it('recovers when the fault clears and Try again is pressed', async () => {
    const user = userEvent.setup();
    fault = new Error('boom');
    render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>
    );
    fault = null;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
  });
});
