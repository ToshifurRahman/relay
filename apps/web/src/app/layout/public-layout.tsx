import { Outlet, useLocation, useMatch } from 'react-router-dom';

import { SiteFooter } from '@/app/layout/site-footer';
import { SiteHeader } from '@/app/layout/site-header';
import { SkipLink } from '@/app/layout/skip-link';
import { ErrorBoundary } from '@/components/error-boundary';
import { cn } from '@/lib/utils';

// The landing page and the 404 are full-width bands; every other page sits in a centred column.
export function PublicLayout({ bare = false }: { bare?: boolean }) {
  const landing = useMatch('/') !== null || bare;
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-screen flex-col">
      <SkipLink />
      <SiteHeader />
      <main
        id="main"
        tabIndex={-1}
        className={cn(
          'outline-none flex-1',
          !landing && 'mx-auto w-full max-w-(--page-width) px-4 py-12 pb-18'
        )}
      >
        {/* Keyed by path: a failed render must not keep the whole site stuck on the panel
            after the visitor follows another link. Moving pages clears the error. */}
        <ErrorBoundary key={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <SiteFooter />
    </div>
  );
}
