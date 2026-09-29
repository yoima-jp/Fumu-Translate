import { describe, expect, it, vi } from 'vitest';
import type { ImageTextExtractionRequest } from '@fumu/translation-core';
import { ImageTextRecognizer } from './image-text-recognizer';

const request: ImageTextExtractionRequest = {
  requestId: 'image-request',
  images: [{ mediaType: 'image/png', base64Data: 'image' }],
};

function createRecognizer(systemResult: { readonly status: 'no-text' | 'unavailable' }) {
  const model = {
    extractImageText: vi.fn().mockResolvedValue({ status: 'completed', text: 'AI' }),
  };
  const recognizer = new ImageTextRecognizer({
    mode: () => 'system',
    systemOcr: vi
      .fn()
      .mockResolvedValue(
        systemResult.status === 'unavailable'
          ? { status: 'unavailable', reason: 'not-supported' }
          : systemResult,
      ),
    model,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  return { recognizer, model };
}

describe('ImageTextRecognizer privacy boundary', () => {
  it('does not send the image to a model when system OCR finds no text', async () => {
    const { recognizer, model } = createRecognizer({ status: 'no-text' });

    await expect(recognizer.extractImageText(request)).resolves.toEqual({ status: 'no-text' });
    expect(model.extractImageText).not.toHaveBeenCalled();
  });

  it('preserves unavailable system OCR as a distinct outcome', async () => {
    const { recognizer, model } = createRecognizer({ status: 'unavailable' });

    await expect(recognizer.extractImageText(request)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(model.extractImageText).not.toHaveBeenCalled();
  });

  it('uses the model only after an explicit model retry', async () => {
    const { recognizer, model } = createRecognizer({ status: 'no-text' });

    await expect(recognizer.extractImageText(request, { modelOnly: true })).resolves.toEqual({
      status: 'completed',
      text: 'AI',
    });
    expect(model.extractImageText).toHaveBeenCalledWith(request);
  });
});
