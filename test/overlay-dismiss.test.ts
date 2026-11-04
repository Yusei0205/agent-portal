/**
 * Unit tests for web/src/lib/useOverlayDismiss.js — shouldDismiss pure helper.
 *
 * Run with:
 *   npm run test:affected -- --module shell --backend-only
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — plain JS module without type declarations
import { shouldDismiss } from '../web/src/lib/useOverlayDismiss.js';

// ══════════════════════════════════════════════════════════════════════════════
// shouldDismiss — the core decision function
// ══════════════════════════════════════════════════════════════════════════════

describe('shouldDismiss — closes when all conditions are met', () => {
  it('returns true when pressed on overlay, click on overlay, and not disabled', () => {
    assert.equal(
      shouldDismiss({ pressedOnOverlay: true, isCurrentTarget: true, disabled: false }),
      true,
    );
  });
});

describe('shouldDismiss — does NOT close on drag from inside dialog to overlay', () => {
  it('returns false when mousedown was inside dialog (not on overlay)', () => {
    // User dragged from inside the dialog box and released on the overlay.
    // pressedOnOverlay is false because the mousedown landed on the dialog.
    assert.equal(
      shouldDismiss({ pressedOnOverlay: false, isCurrentTarget: true, disabled: false }),
      false,
    );
  });
});

describe('shouldDismiss — does NOT close when click lands inside dialog', () => {
  it('returns false when click target is not the overlay (even if pressed on overlay)', () => {
    assert.equal(
      shouldDismiss({ pressedOnOverlay: true, isCurrentTarget: false, disabled: false }),
      false,
    );
  });
});

describe('shouldDismiss — does NOT close while disabled', () => {
  it('returns false when disabled=true even if both targets match', () => {
    assert.equal(
      shouldDismiss({ pressedOnOverlay: true, isCurrentTarget: true, disabled: true }),
      false,
    );
  });

  it('returns false when disabled=true and only click matches', () => {
    assert.equal(
      shouldDismiss({ pressedOnOverlay: false, isCurrentTarget: true, disabled: true }),
      false,
    );
  });
});

describe('shouldDismiss — all three conditions must hold simultaneously', () => {
  it('returns false when all three are false', () => {
    assert.equal(
      shouldDismiss({ pressedOnOverlay: false, isCurrentTarget: false, disabled: true }),
      false,
    );
  });

  it('returns false when only pressedOnOverlay is true', () => {
    assert.equal(
      shouldDismiss({ pressedOnOverlay: true, isCurrentTarget: false, disabled: true }),
      false,
    );
  });

  it('returns false when only isCurrentTarget is true', () => {
    assert.equal(
      shouldDismiss({ pressedOnOverlay: false, isCurrentTarget: true, disabled: false }),
      false,
    );
  });

  it('returns false when pressedOnOverlay and isCurrentTarget are true but disabled', () => {
    assert.equal(
      shouldDismiss({ pressedOnOverlay: true, isCurrentTarget: true, disabled: true }),
      false,
    );
  });
});

describe('shouldDismiss — plain click on overlay (no drag)', () => {
  it('returns true for a plain click — mousedown and click both on overlay', () => {
    // Normal use-case: user just clicks on the overlay backdrop.
    assert.equal(
      shouldDismiss({ pressedOnOverlay: true, isCurrentTarget: true, disabled: false }),
      true,
    );
  });
});
