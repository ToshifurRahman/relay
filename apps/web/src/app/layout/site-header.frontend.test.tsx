import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { SiteHeader } from './site-header';

// WCAG 2.5.3 (label in name): a control's accessible name must contain the text a sighted user
// reads on it. The home link shows the wordmark "RELAY" but announced only "Home", so a
// speech-input user saying what they see ("Relay") could not activate it.
describe('site header home link', () => {
  it('keeps the visible wordmark in its accessible name', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SiteHeader />
      </MemoryRouter>
    );
    const home = screen.getByRole('link', { name: /relay/i });
    expect(home).toHaveAttribute('href', '/');
    expect(home.textContent).toMatch(/relay/i);
  });

  it('no longer announces a name that omits the visible text', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SiteHeader />
      </MemoryRouter>
    );
    expect(screen.queryByRole('link', { name: 'Home' })).not.toBeInTheDocument();
  });
});
