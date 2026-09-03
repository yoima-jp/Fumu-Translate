import { LlmProviderError } from '@fumu/llm-core';
import type { TranslationErrorCode } from './contracts';

export interface PublicLlmError {
  readonly code: TranslationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

function providerErrorMessage(error: LlmProviderError): string {
  switch (error.code) {
    case 'authentication':
      return 'APIキーを確認してください。';
    case 'permission':
      return 'このモデルを利用する権限がありません。';
    case 'rate-limit':
      return '利用上限に達しました。少し待って再試行してください。';
    case 'request-too-large':
      return '文章が長すぎます。範囲を短くしてください。';
    case 'network':
      return 'ネットワークに接続できません。';
    case 'provider-unavailable':
      return '翻訳サービスが応答していません。';
    case 'invalid-configuration':
      return 'プロバイダー設定を確認してください。';
    case 'invalid-response':
      return '翻訳結果を読み取れませんでした。';
    case 'unknown':
      return '翻訳できませんでした。';
  }
}

export function toPublicLlmError(error: unknown): PublicLlmError {
  if (error instanceof LlmProviderError) {
    return {
      code: error.code,
      message: providerErrorMessage(error),
      retryable: error.retryable,
    };
  }

  return {
    code: 'unknown',
    message: '翻訳できませんでした。',
    retryable: true,
  };
}
