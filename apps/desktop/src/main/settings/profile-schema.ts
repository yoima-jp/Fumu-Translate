import { z } from 'zod';
import { isLoopbackHostname } from '@fumu/llm-core';
import {
  APPEARANCE_VALUES,
  HISTORY_RETENTION_DAY_VALUES,
  MAX_COMBINED_WRITING_STYLE_INSTRUCTION_LENGTH,
  MAX_COMBINED_WRITING_STYLE_NAME_LENGTH,
  MAX_WRITING_STYLE_DESCRIPTION_LENGTH,
  MAX_WRITING_STYLE_INSTRUCTION_LENGTH,
  MAX_WRITING_STYLE_NAME_LENGTH,
  MAX_WRITING_STYLES,
  NATIVE_LANGUAGE_VALUES,
  OTHER_LANGUAGE_TARGET_VALUES,
  PROVIDER_KIND_VALUES,
  TRANSLATION_STYLE_VALUES,
} from '../../shared/settings-contracts';

const idSchema = z.uuid();
const nullableIdSchema = idSchema.nullable();
const nameSchema = z.string().trim().min(1).max(80);
const modelIdSchema = z.string().trim().min(1).max(500);
const metadataValueSchema = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const providerMetadataSchema = z
  .record(z.string().max(200), metadataValueSchema)
  .refine((metadata) => Object.keys(metadata).length <= 40, 'Model metadataは40件までです。');
const MAX_PROVIDER_DEFINITION_BYTES = 8 * 1024 * 1024;

const safeBaseUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  }, '接続先はHTTPS、またはこの端末のHTTPアドレスを指定してください。');
export const providerModelSchema = z
  .object({
    id: modelIdSchema,
    name: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(10_000).optional(),
    ownedBy: z.string().max(500).optional(),
    contextLength: z.number().int().positive().max(100_000_000).optional(),
    createdAt: z.number().int().nonnegative().optional(),
    metadata: providerMetadataSchema,
    source: z.enum(['api', 'manual']),
  })
  .strict();

const writingStyleSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(MAX_WRITING_STYLE_NAME_LENGTH),
    description: z.string().max(MAX_WRITING_STYLE_DESCRIPTION_LENGTH).optional(),
    instruction: z.string().trim().min(1).max(MAX_WRITING_STYLE_INSTRUCTION_LENGTH),
    hidden: z.boolean().optional(),
    deleted: z.boolean().optional(),
    icon: z.string().max(8).optional(),
  })
  .strict();

export const writingStyleInstructionSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_COMBINED_WRITING_STYLE_NAME_LENGTH),
    instruction: z.string().trim().min(1).max(MAX_COMBINED_WRITING_STYLE_INSTRUCTION_LENGTH),
  })
  .strict();

const definitionBase = {
  id: nullableIdSchema,
  name: nameSchema,
  models: z.array(providerModelSchema).max(5_000),
  enabledModelIds: z.array(modelIdSchema).max(5_000),
};

const CLOUD_PROVIDER_KIND_VALUES = PROVIDER_KIND_VALUES.filter(
  (kind) => kind !== 'ollama' && kind !== 'lm-studio' && kind !== 'custom-openai-compatible',
) as [
  'chatgpt',
  'openai',
  'anthropic',
  'google',
  'groq',
  'openrouter',
  'deepinfra',
  'mistral',
  'ollama-cloud',
];

const providerConnectionDefinitionUnion = z.union([
  z.object({ ...definitionBase, kind: z.enum(CLOUD_PROVIDER_KIND_VALUES) }).strict(),
  z.object({ ...definitionBase, kind: z.literal('ollama'), baseUrl: safeBaseUrlSchema }).strict(),
  z
    .object({ ...definitionBase, kind: z.literal('lm-studio'), baseUrl: safeBaseUrlSchema })
    .strict(),
  z
    .object({
      ...definitionBase,
      kind: z.literal('custom-openai-compatible'),
      baseUrl: safeBaseUrlSchema,
      supportsJsonObjectResponse: z.boolean(),
      includeUsage: z.boolean(),
    })
    .strict(),
]);

export const providerConnectionDefinitionSchema = providerConnectionDefinitionUnion.superRefine(
  (provider, context) => {
    // IPCで直接渡される定義にもAPI応答と同じ総量上限を適用し、structured clone後の
    // Zod検証やJSON永続化でメインプロセスが長時間占有されるのを防ぐ。
    if (
      new TextEncoder().encode(JSON.stringify(provider)).byteLength > MAX_PROVIDER_DEFINITION_BYTES
    ) {
      context.addIssue({ code: 'custom', message: 'Provider設定が大きすぎます。' });
    }
  },
);

const secretUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preserve') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z
    .object({
      action: z.literal('replace'),
      apiKey: z.string().trim().min(1).max(20_000),
    })
    .strict(),
]);

export const saveProviderSchema = z
  .object({
    provider: providerConnectionDefinitionSchema,
    secret: secretUpdateSchema,
  })
  .strict();

export const fetchProviderModelsSchema = z
  .object({ provider: providerConnectionDefinitionSchema, secret: secretUpdateSchema })
  .strict();

export const usedModelReferenceSchema = z
  .object({ providerId: idSchema, modelId: modelIdSchema })
  .strict();

export const updateUsedModelsSchema = z
  .object({ models: z.array(usedModelReferenceSchema).max(32) })
  .strict();

export const generalSettingsUpdateSchema = z
  .object({
    historyEnabled: z.boolean().optional(),
    launchAtLogin: z.boolean().optional(),
    enterToSend: z.boolean().optional(),
    compactTranslation: z.boolean().optional(),
    developerMode: z.boolean().optional(),
    debugMode: z.boolean().optional(),
    translationStyle: z.enum(TRANSLATION_STYLE_VALUES).optional(),
    nativeLanguage: z.enum(NATIVE_LANGUAGE_VALUES).nullable().optional(),
    appearance: z.enum(APPEARANCE_VALUES).optional(),
    otherLanguageTarget: z.enum(OTHER_LANGUAGE_TARGET_VALUES).optional(),
    historyRetentionDays: z
      .union(HISTORY_RETENTION_DAY_VALUES.map((value) => z.literal(value)))
      .nullable()
      .optional(),
    writingStyles: z
      .array(writingStyleSchema)
      // Built-in styles plus up to 20 user-created styles.
      .max(MAX_WRITING_STYLES)
      .optional(),
    activeWritingStyleId: z.uuid().nullable().optional(),
    onboardingCompleted: z.boolean().optional(),
  })
  .strict();

// 空文字はグローバルショートカットを無効化する明示設定として扱う。
export const shortcutSchema = z.string().trim().max(200);
export const providerIdSchema = idSchema;

const storedBase = { ...definitionBase, id: idSchema };
export const storedProviderConnectionSchema = z.union([
  z.object({ ...storedBase, kind: z.enum(CLOUD_PROVIDER_KIND_VALUES) }).strict(),
  z.object({ ...storedBase, kind: z.literal('ollama'), baseUrl: safeBaseUrlSchema }).strict(),
  z.object({ ...storedBase, kind: z.literal('lm-studio'), baseUrl: safeBaseUrlSchema }).strict(),
  z
    .object({
      ...storedBase,
      kind: z.literal('custom-openai-compatible'),
      baseUrl: safeBaseUrlSchema,
      supportsJsonObjectResponse: z.boolean(),
      includeUsage: z.boolean(),
    })
    .strict(),
]);
