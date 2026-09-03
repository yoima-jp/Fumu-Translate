export function displayAccelerator(accelerator: string, unsetLabel = ''): string {
  return accelerator.length === 0
    ? unsetLabel
    : accelerator.replace('CommandOrControl', 'Ctrl').replaceAll('+', ' + ');
}
