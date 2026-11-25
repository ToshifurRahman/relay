import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SupportSide } from '../lib/ticket-thread';
import { TicketThread } from './ticket-thread';

// Story 7.12.10 handed over a real 390 px defect: the customer message clamped with
// `line-clamp-4` but the clamp was applied to a padded block. `-webkit-line-clamp` only clips
// inside a `-webkit-box`, and the browser computes `display: flow-root` for this block, so the
// clamp never took: a long message rendered every line and the panel's `overflow: hidden` sliced
// the fifth one through the middle of its glyphs, with no ellipsis. The dropdown next to it says
// "Show full message", so the reader also loses the way back.
//
// These tests pin the structure the fix needs: the clamp lives on an unpadded element inside the
// padded panel, only on the small breakpoint, and the full message stays in the DOM so the toggle
// still has the whole text to reveal.

const LONG =
  'The charge on my invoice is wrong and I was billed twice for the same month. ' +
  'I need this fixed today because my finance team is closing the books this afternoon, ' +
  'and the duplicate charge has already been flagged by our auditor as a problem.';

const WORKING: SupportSide = { kind: 'working', stage: 'reviewing', badges: null };

const renderThread = (description: string) =>
  render(
    <TicketThread
      description={description}
      createdAt={new Date().toISOString()}
      support={WORKING}
    />
  );

const clamped = () => document.querySelector('.line-clamp-4');

describe('TicketThread customer message clamp', () => {
  it('puts the mobile clamp on an element that carries no padding', () => {
    renderThread(LONG);
    const el = clamped();
    expect(el).not.toBeNull();
    // Padding on the clamped box is what broke it: the browser computes a non-`-webkit-box`
    // display for such a block, and `-webkit-line-clamp` needs that display to clip at all.
    expect(el?.className).not.toMatch(/\bpx-|\bpy-/);
  });

  it('keeps the padded panel as the clamp parent so the bubble still looks the same', () => {
    renderThread(LONG);
    const el = clamped();
    expect(el?.parentElement?.tagName).toBe('BLOCKQUOTE');
    expect(el?.parentElement?.className).toMatch(/\bpx-4\b/);
  });

  it('unclamps at the small breakpoint and above', () => {
    renderThread(LONG);
    expect(clamped()?.className).toMatch(/\bsm:line-clamp-none\b/);
  });

  it('keeps the whole message in the DOM so the toggle can reveal it', () => {
    renderThread(LONG);
    expect(clamped()?.textContent).toBe(LONG);
  });

  it('offers the toggle for a long message and not for a short one', () => {
    const { rerender } = renderThread(LONG);
    expect(document.querySelector('button')?.textContent).toBe('Show full message');
    rerender(
      <TicketThread description="Short." createdAt={new Date().toISOString()} support={WORKING} />
    );
    expect(document.querySelector('button')).toBeNull();
  });

  it('clamps nothing once the reader expands the message', async () => {
    renderThread(LONG);
    const button = document.querySelector('button') as HTMLButtonElement;
    button.click();
    await Promise.resolve();
    expect(clamped()).toBeNull();
  });
});
