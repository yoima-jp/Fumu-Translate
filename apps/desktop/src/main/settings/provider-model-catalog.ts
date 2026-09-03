import type {
  ProviderConnectionDefinition,
  ProviderKind,
  ProviderModel,
  ProviderModelMetadataValue,
} from '../../shared/settings-contracts';
import { listChatGptModels } from '@fumu/provider-chatgpt';
import { providerModelSchema } from './profile-schema';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const CLOUD_MODEL_ENDPOINTS: Readonly<Partial<Record<ProviderKind, string>>> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models',
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
  groq: 'https://api.groq.com/openai/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
  deepinfra: 'https://api.deepinfra.com/models/list',
  mistral: 'https://api.mistral.ai/v1/models',
  'ollama-cloud': 'https://ollama.com/api/tags',
};

const MAX_MODELS = 5_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function modelEndpoint(provider: ProviderConnectionDefinition): URL {
  const cloud = CLOUD_MODEL_ENDPOINTS[provider.kind];
  if (cloud !== undefined) return new URL(cloud);
  if (!('baseUrl' in provider)) throw new Error('ProviderのModel一覧URLがありません。');
  const base = new URL(provider.baseUrl.endsWith('/') ? provider.baseUrl : `${provider.baseUrl}/`);
  if (provider.kind === 'ollama') return new URL('api/tags', base);
  return new URL('models', base);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function primitiveMetadata(
  record: Record<string, unknown>,
): Record<string, ProviderModelMetadataValue> {
  const metadata: Record<string, ProviderModelMetadataValue> = {};
  for (const [key, value] of Object.entries(record).slice(0, 40)) {
    if (
      [
        'id',
        'name',
        'displayName',
        'description',
        'owned_by',
        'context_length',
        'created',
      ].includes(key)
    ) {
      continue;
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 4_096)
    ) {
      metadata[key] = value;
    } else if (typeof value === 'object' && value !== undefined) {
      try {
        const serialized = JSON.stringify(value);
        if (serialized.length <= 4_096) metadata[key] = serialized;
      } catch {
        // Provider応答の循環参照等は保存できないため、その項目だけを除外する。
      }
    }
  }
  return metadata;
}

function optionalString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

function toModel(value: unknown, kind: ProviderKind): ProviderModel | null {
  const record = recordOf(value);
  if (record === null) return null;
  const id =
    kind === 'ollama' || kind === 'ollama-cloud'
      ? optionalString(record, 'name', 'model')
      : kind === 'deepinfra'
        ? optionalString(record, 'model_name')
        : optionalString(record, 'id', 'name');
  if (id === undefined || id.length > 500) return null;
  const name = optionalString(record, 'displayName');
  const description = optionalString(record, 'description');
  const ownedBy = optionalString(record, 'owned_by', 'ownedBy');
  const contextLength = optionalPositiveInteger(
    record,
    'context_length',
    'contextLength',
    'context_window',
    'max_context_length',
    'inputTokenLimit',
    'max_tokens',
  );
  const createdAt = optionalPositiveInteger(record, 'created', 'created_at');
  const parsed = providerModelSchema.safeParse({
    id,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(ownedBy === undefined ? {} : { ownedBy }),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(createdAt === undefined ? {} : { createdAt }),
    metadata: primitiveMetadata(record),
    source: 'api',
  });
  return parsed.success ? parsed.data : null;
}

interface ResponseBudget {
  used: number;
}

async function readJson(response: Response, budget: ResponseBudget): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES - budget.used) {
    throw new Error('Model一覧の応答が大きすぎます。');
  }
  if (response.body === null) throw new Error('Model一覧の応答を読み取れませんでした。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    byteLength += value.byteLength;
    if (budget.used + byteLength > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Model一覧の応答が大きすぎます。');
    }
    chunks.push(value);
  }
  budget.used += byteLength;
  const merged = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged)) as unknown;
  } catch (error) {
    throw new Error('Model一覧の応答を読み取れませんでした。', { cause: error });
  }
}

function pageToken(payload: unknown, kind: ProviderKind): string | null {
  const root = recordOf(payload);
  if (root === null) return null;
  if (kind === 'google') return optionalString(root, 'nextPageToken') ?? null;
  if (kind === 'anthropic' && root.has_more === true) {
    const token = optionalString(root, 'last_id');
    if (token === undefined) throw new Error('Providerのページング形式に対応していません。');
    return token;
  }
  return null;
}

function configurePage(endpoint: URL, kind: ProviderKind, token: string | null): void {
  if (kind === 'google') {
    endpoint.searchParams.set('pageSize', '1000');
    if (token !== null) endpoint.searchParams.set('pageToken', token);
  } else if (kind === 'anthropic') {
    endpoint.searchParams.set('limit', '1000');
    if (token !== null) endpoint.searchParams.set('after_id', token);
  }
}

export async function fetchProviderModels(
  provider: ProviderConnectionDefinition,
  apiKey: string | null,
  fetchLike: FetchLike = fetch,
): Promise<readonly ProviderModel[]> {
  if (provider.kind === 'chatgpt') {
    // Codex backend does not expose the Platform APIの /models と同じ公開一覧を持たない。
    // ChatGPTには一般APIのmodel-list endpointがないため、通信確認済みのIDだけを提示する。
    return listChatGptModels().map((model) => ({
      id: model.id,
      name: model.name,
      contextLength: model.contextWindow,
      metadata: { maxTokens: model.maxTokens, reasoning: model.reasoning },
      source: 'api',
    }));
  }
  const headers = new Headers({ Accept: 'application/json' });
  if (provider.kind === 'google' && apiKey !== null) headers.set('x-goog-api-key', apiKey);
  else if (provider.kind === 'anthropic') {
    if (apiKey !== null) headers.set('x-api-key', apiKey);
    headers.set('anthropic-version', '2023-06-01');
  } else if (apiKey !== null) headers.set('Authorization', `Bearer ${apiKey}`);

  const signal = AbortSignal.timeout(15_000);
  const budget = { used: 0 };
  const seenTokens = new Set<string>();
  const unique = new Map<string, ProviderModel>();
  let token: string | null = null;
  do {
    const endpoint = modelEndpoint(provider);
    configurePage(endpoint, provider.kind, token);
    const response = await fetchLike(endpoint, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal,
    }).catch((error: unknown) => {
      throw new Error('Model一覧へ接続できませんでした。接続先とネットワークを確認してください。', {
        cause: error,
      });
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Model一覧の接続先がリダイレクトを返しました。接続先を確認してください。');
    }
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? '認証できませんでした。API Keyを確認してください。'
          : `Model一覧を取得できませんでした（${String(response.status)}）。`,
      );
    }
    const payload = await readJson(response, budget);
    const root = recordOf(payload);
    const values = Array.isArray(payload)
      ? payload
      : provider.kind === 'ollama' || provider.kind === 'ollama-cloud'
        ? root?.models
        : provider.kind === 'google'
          ? root?.models
          : root?.data;
    if (!Array.isArray(values)) throw new Error('ProviderのModel一覧形式に対応していません。');
    for (const value of values) {
      const model = toModel(value, provider.kind);
      if (model !== null) unique.set(model.id, model);
      if (unique.size > MAX_MODELS) throw new Error('Model一覧が上限の5,000件を超えています。');
    }
    token = pageToken(payload, provider.kind);
    if (token !== null && seenTokens.has(token)) {
      throw new Error('Providerのページングが同じ位置を繰り返しています。');
    }
    if (token !== null) seenTokens.add(token);
  } while (token !== null);
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}
