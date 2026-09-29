import type { LlmClient, LlmImageInput } from '@fumu/llm-core';

// 画像翻訳は「画像 → 文字起こし → 通常のテキスト翻訳」の二段で行う。
// 文字起こし結果を通常のsourceTextとして扱うことで、調整・戻し訳・追加質問・会話翻訳・履歴を
// 画像専用の分岐なしに再利用でき、ユーザーは読み取り誤りを入力欄で直してから再翻訳できる。
// 以降の操作で画像を再送しないため、トークン消費と応答時間も抑えられる。

// ベータでは1回の要求につき1枚だけ扱う。複数枚はUIと上限設計が固まってから広げる。
export const MAX_IMAGE_TEXT_EXTRACTION_IMAGES = 1;

export interface ImageTextExtractionRequest {
  readonly requestId: string;
  readonly images: readonly LlmImageInput[];
  readonly signal?: AbortSignal;
}

export type ImageTextExtractionResult =
  | {
      readonly status: 'completed';
      /** 画像内の文字を読み順どおりに書き起こしたもの。翻訳はしない。 */
      readonly text: string;
    }
  | {
      /** 画像は読めたが、翻訳対象になる文字が見つからなかった。 */
      readonly status: 'no-text';
    };

export interface ImageTextExtractionService {
  /**
   * 失敗はLlmProviderErrorとしてthrowする。呼び出し側はcodeを見てfallback modelへ進むか判断する。
   * AbortSignalで中断された場合はAbortErrorをthrowする。
   */
  extract(request: ImageTextExtractionRequest): Promise<ImageTextExtractionResult>;
}

export class LlmImageTextExtractionService implements ImageTextExtractionService {
  readonly #client: LlmClient;

  constructor(client: LlmClient) {
    this.#client = client;
  }

  extract(_request: ImageTextExtractionRequest): Promise<ImageTextExtractionResult> {
    void this.#client;
    return Promise.reject(new Error('Image text extraction is not implemented yet.'));
  }
}
