import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { Switch } from './switch';

// The app sets --brand-accent inline on the root (a fixed #111111), which beats
// the dark theme's own mapping to --oa-primary. A switch coloured from
// --brand-accent is therefore near-black on a near-black surface in dark mode,
// and on/off read as two similar greys. --oa-primary follows the theme: black
// in light mode, white in dark mode.
describe('Switch', () => {
  test('colours the checked state from the theme primary, not the fixed brand accent', () => {
    render(<Switch checked onCheckedChange={() => {}} />);
    const root = screen.getByRole('switch');
    expect(root.className).toContain('data-[state=checked]:bg-[var(--oa-primary)]');
    expect(root.className).not.toContain('--brand-accent');
    expect(root.firstElementChild?.className).toContain('data-[state=checked]:bg-[var(--oa-primary-foreground)]');
    expect(root.firstElementChild?.className).not.toContain('--brand-accent');
  });
});
