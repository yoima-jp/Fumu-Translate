import { clipboard } from 'electron';

export class ElectronClipboardService {
  async readText(): Promise<string | null> {
    const text = await clipboard.readText();
    return text.trim().length === 0 ? null : text;
  }

  async writeText(text: string): Promise<void> {
    if (text.length === 0) {
      return;
    }

    await clipboard.writeText(text);
  }
}
