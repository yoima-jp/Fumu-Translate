import { nativeImage } from 'electron';
import type { LlmImageInput } from '@fumu/llm-core';
import type { ImageInputPayload, ImageTextExtractionErrorCode } from '../../shared/contracts';

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_EDGE_PIXELS = 2_048;
const MIN_EDGE_PIXELS = 8;
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const JPEG_QUALITY = 90;

export class ImageInputNormalizationError extends Error {
  readonly code: Extract<ImageTextExtractionErrorCode, 'invalid-image' | 'image-too-large'>;

  constructor(code: Extract<ImageTextExtractionErrorCode, 'invalid-image' | 'image-too-large'>) {
    super(
      code === 'image-too-large'
        ? 'Image input exceeds the supported size.'
        : 'Invalid image input.',
    );
    this.name = 'ImageInputNormalizationError';
    this.code = code;
  }
}

/** Providerへ画像を渡す前に、入力形式・画素数・送信サイズをmainで一元化する。 */
export function normalizeImageInput(input: ImageInputPayload | Buffer): LlmImageInput {
  const sourceBytes = Buffer.isBuffer(input) ? input : input.data;
  if (sourceBytes.byteLength > MAX_INPUT_BYTES) {
    throw new ImageInputNormalizationError('image-too-large');
  }
  if (sourceBytes.byteLength === 0) {
    throw new ImageInputNormalizationError('invalid-image');
  }
  const bytes = Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes);

  try {
    let image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) {
      throw new ImageInputNormalizationError('invalid-image');
    }

    const originalSize = image.getSize();
    if (
      !Number.isFinite(originalSize.width) ||
      !Number.isFinite(originalSize.height) ||
      originalSize.width < MIN_EDGE_PIXELS ||
      originalSize.height < MIN_EDGE_PIXELS
    ) {
      throw new ImageInputNormalizationError('invalid-image');
    }

    const longestEdge = Math.max(originalSize.width, originalSize.height);
    if (longestEdge > MAX_EDGE_PIXELS) {
      const scale = MAX_EDGE_PIXELS / longestEdge;
      image = image.resize({
        width: Math.max(1, Math.round(originalSize.width * scale)),
        height: Math.max(1, Math.round(originalSize.height * scale)),
        quality: 'best',
      });
    }

    const png = image.toPNG();
    if (png.byteLength === 0) {
      throw new ImageInputNormalizationError('invalid-image');
    }
    if (png.byteLength <= MAX_PNG_BYTES) {
      return { mediaType: 'image/png', base64Data: png.toString('base64') };
    }

    const jpeg = image.toJPEG(JPEG_QUALITY);
    if (jpeg.byteLength === 0) {
      throw new ImageInputNormalizationError('invalid-image');
    }
    return { mediaType: 'image/jpeg', base64Data: jpeg.toString('base64') };
  } catch (error) {
    if (error instanceof ImageInputNormalizationError) throw error;
    throw new ImageInputNormalizationError('invalid-image');
  }
}
