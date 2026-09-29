import type { ImageTextExtractionRequest, ImageTextExtractionResult } from '@fumu/translation-core';
import type { ImageTextRecognition } from '../../shared/settings-contracts';
import type { ImageTextExtractionPort } from '../app-controller';
import type { SystemOcrResult } from './system-ocr';

interface ImageTextRecognizerLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
}

export interface ImageTextRecognizerOptions {
  /** 要求ごとに現在の設定を読む。設定変更を再起動なしで反映するため関数で受け取る。 */
  readonly mode: () => ImageTextRecognition;
  readonly systemOcr: (
    image: ImageTextExtractionRequest['images'][number],
    signal?: AbortSignal,
  ) => Promise<SystemOcrResult>;
  readonly model: ImageTextExtractionPort;
  readonly logger: ImageTextRecognizerLogger;
}

function isProviderNotConfigured(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'provider-not-configured'
  );
}

/**
 * 設定に応じてOS標準OCRとAIモデルの文字起こしを切り替える。
 * OCRモードでもOCRが使えない・文字が取れない場合はAIモデルへfallbackし、
 * 「読めなかった」で止まらないようにする（モデル側でも候補順にfallbackする）。
 */
export class ImageTextRecognizer implements ImageTextExtractionPort {
  readonly #options: ImageTextRecognizerOptions;

  constructor(options: ImageTextRecognizerOptions) {
    this.#options = options;
  }

  async extractImageText(request: ImageTextExtractionRequest): Promise<ImageTextExtractionResult> {
    if (this.#options.mode() !== 'system') return this.#options.model.extractImageText(request);

    const image = request.images[0];
    const systemResult =
      image === undefined ? null : await this.#options.systemOcr(image, request.signal);
    if (systemResult?.status === 'completed') return systemResult;

    // OCR本文は記録せず、fallback判断に必要な状態だけを残す。
    this.#options.logger.info('System OCR did not produce text; falling back to model', {
      status: systemResult?.status ?? 'no-image',
      reason: systemResult?.status === 'unavailable' ? systemResult.reason : undefined,
    });
    try {
      return await this.#options.model.extractImageText(request);
    } catch (error) {
      // OCRが正常に動いて文字が無かった画像なら、モデル未設定を理由に失敗させず「文字なし」と伝える。
      if (systemResult?.status === 'no-text' && isProviderNotConfigured(error)) {
        return { status: 'no-text' };
      }
      throw error;
    }
  }
}
