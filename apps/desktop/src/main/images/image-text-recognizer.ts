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

export interface ImageTextRecognitionOptions {
  /** ユーザーが明示的にAIでの再試行を選んだ場合だけtrueにする。 */
  readonly modelOnly?: boolean;
}

type ImageTextRecognitionResult = ImageTextExtractionResult | { readonly status: 'unavailable' };

/**
 * 設定に応じてOS標準OCRとAIモデルの文字起こしを切り替える。
 * 端末OCRモードでは画像を外部へ送らない。OCRで読めなかった画像をモデルへ渡すのは、
 * 呼び出し側がユーザーの明示操作を受けてmodelOnlyを指定した場合に限る。
 */
export class ImageTextRecognizer implements ImageTextExtractionPort {
  readonly #options: ImageTextRecognizerOptions;

  constructor(options: ImageTextRecognizerOptions) {
    this.#options = options;
  }

  async extractImageText(
    request: ImageTextExtractionRequest,
    options: ImageTextRecognitionOptions = {},
  ): Promise<ImageTextRecognitionResult> {
    if (options.modelOnly === true || this.#options.mode() !== 'system') {
      return this.#options.model.extractImageText(request);
    }

    const image = request.images[0];
    const systemResult =
      image === undefined ? null : await this.#options.systemOcr(image, request.signal);
    if (systemResult?.status === 'completed') return systemResult;
    if (systemResult?.status === 'unavailable' || systemResult === null) {
      // OCR自体が使えない状態を「画像に文字がない」と扱うと、設定やAI再試行の案内を誤る。
      this.#options.logger.info('System OCR is unavailable', {
        reason: systemResult?.status === 'unavailable' ? systemResult.reason : 'no-image',
      });
      return { status: 'unavailable' };
    }

    // OCR本文や画像は記録せず、文字が見つからなかった状態だけを残す。
    this.#options.logger.info('System OCR did not produce text', {
      status: systemResult.status,
    });
    return { status: 'no-text' };
  }
}
