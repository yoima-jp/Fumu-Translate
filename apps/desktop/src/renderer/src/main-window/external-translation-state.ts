import type { PopupViewState } from '../../../shared/contracts';

export function shouldOpenExternalTranslation(
  state: PopupViewState,
  dismissedRequestId: string | null,
): boolean {
  return (
    state.phase === 'selection' &&
    state.selection.method !== 'manual' &&
    state.requestId !== dismissedRequestId
  );
}
