import { describe, expect, it } from 'vitest';

import { stripReplyPlaceholders } from '../../../src/domain/reply-placeholders.js';

const SIGN_OFF = 'The Relay support team';

describe('stripReplyPlaceholders', () => {
  it('replaces a [Your Name] signature with the team sign-off', () => {
    const reply = 'Hi,\n\nWe have refunded the charge.\n\nBest regards,\n[Your Name]';
    expect(stripReplyPlaceholders(reply, SIGN_OFF)).toBe(
      'Hi,\n\nWe have refunded the charge.\n\nBest regards,\nThe Relay support team'
    );
  });

  it('drops a whole placeholder signature block, not only the name line', () => {
    const reply =
      'Thanks for reaching out.\n\nKind regards,\n[Your Name]\n[Your Position]\n[Company Name]\n[Contact Information]';
    expect(stripReplyPlaceholders(reply, SIGN_OFF)).toBe(
      'Thanks for reaching out.\n\nKind regards,\nThe Relay support team'
    );
  });

  it('removes an inline placeholder in the greeting without leaving a gap', () => {
    expect(stripReplyPlaceholders('Dear [Customer Name],\n\nAll fixed.', SIGN_OFF)).toBe(
      'Dear,\n\nAll fixed.'
    );
    expect(stripReplyPlaceholders('Hi [Customer’s Name], all fixed.', SIGN_OFF)).toBe(
      'Hi, all fixed.'
    );
  });

  it('matches placeholders in any letter case', () => {
    expect(stripReplyPlaceholders('Best,\n[YOUR NAME]', SIGN_OFF)).toBe(
      'Best,\nThe Relay support team'
    );
  });

  it('leaves a reply without placeholders unchanged, including ordinary brackets', () => {
    const reply = 'Open Settings [Billing] and retry.\n\nBest regards,\nThe Relay support team';
    expect(stripReplyPlaceholders(reply, SIGN_OFF)).toBe(reply);
  });

  it('adds no sign-off when the reply has no dangling closing line', () => {
    expect(stripReplyPlaceholders('All fixed. [Your Name]', SIGN_OFF)).toBe('All fixed.');
  });
});
