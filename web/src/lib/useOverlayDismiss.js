import { useRef } from 'react';

/**
 * Pure decision helper — exported for unit tests.
 *
 * @param {object} state
 * @param {boolean} state.pressedOnOverlay  whether pointerdown landed on the overlay element
 * @param {boolean} state.isCurrentTarget   whether the click target is the overlay element
 * @param {boolean} state.disabled          true while an action is in progress (suppresses close)
 * @returns {boolean}
 */
export function shouldDismiss({ pressedOnOverlay, isCurrentTarget, disabled }) {
  return pressedOnOverlay && isCurrentTarget && !disabled;
}

/**
 * Returns `{ onMouseDown, onClick }` handlers for an overlay/backdrop element.
 *
 * The dialog is dismissed only when BOTH the mousedown AND the click originated
 * on the overlay itself, preventing a drag that starts inside the dialog and
 * releases over the overlay from accidentally closing the dialog.
 *
 * Usage:
 *   const overlayDismiss = useOverlayDismiss(onClose);
 *   // or, while a file upload is running:
 *   const overlayDismiss = useOverlayDismiss(onClose, { disabled: uploadsBusy });
 *
 *   <div className="dialog-overlay" role="presentation"
 *        onMouseDown={overlayDismiss.onMouseDown}
 *        onClick={overlayDismiss.onClick}>
 *     ...
 *   </div>
 *
 * Escape-to-close handling is unaffected and should remain as-is.
 *
 * @param {() => void} onClose
 * @param {{ disabled?: boolean }} [opts]
 * @returns {{ onMouseDown: (e: MouseEvent) => void, onClick: (e: MouseEvent) => void }}
 */
export function useOverlayDismiss(onClose, { disabled = false } = {}) {
  const pressedOnOverlay = useRef(false);

  return {
    onMouseDown(e) {
      pressedOnOverlay.current = e.target === e.currentTarget;
    },
    onClick(e) {
      const wasPressed = pressedOnOverlay.current;
      pressedOnOverlay.current = false;
      if (shouldDismiss({ pressedOnOverlay: wasPressed, isCurrentTarget: e.target === e.currentTarget, disabled })) {
        onClose();
      }
    },
  };
}
