import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

// Nothing above the router catches a render exception, so without this a failed route render
// unmounts the whole tree and the customer gets a blank white page. This keeps the shell
// (header, footer, skip link) and prints one recovery panel in its place. The thrown error is
// never rendered: its message or stack can name internal paths, so the UI only ever shows
// fixed copy. `reset` lets the panel re-render the tree once the fault may have cleared.

type ErrorBoundaryProps = { children: ReactNode };

type ErrorBoundaryState = { failed: boolean };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // React has already logged the error in development. Production keeps it off the console:
    // the panel is the customer-facing signal and this app has no client error reporter.
  }

  reset = (): void => this.setState({ failed: false });

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section role="alert" className="mx-auto w-full max-w-140 px-4 py-12">
        <h1 className="text-[clamp(1.75rem,4vw,2.5rem)] leading-none font-bold tracking-[-0.02em]">
          Something went wrong
        </h1>
        <p className="mt-4 max-w-[36em] text-lg text-muted-foreground">
          This page hit an unexpected error. Nothing you sent was lost. Try again, or head back to
          the home page.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button variant="solid" onClick={this.reset}>
            Try again
          </Button>
          <a href="/" className="text-sm underline underline-offset-4">
            Back to home
          </a>
        </div>
      </section>
    );
  }
}
