export type UpdateStatus =
  | { readonly phase: 'current' }
  | { readonly phase: 'available'; readonly version: string; readonly portable: boolean }
  | { readonly phase: 'unavailable' }
  | { readonly phase: 'error' };
