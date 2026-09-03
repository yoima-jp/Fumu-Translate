// Rendererは設定スナップショット到着前にもショートカットを表示する。
// 永続化層と初期表示が同じ既定値を参照し、起動直後だけ表示が食い違わないようにする。
export const DEFAULT_TRANSLATE_SHORTCUT = 'CommandOrControl+Shift+J';

export const PROVIDER_KIND_VALUES = [
  'chatgpt',
  'openai',
  'anthropic',
  'google',
  'groq',
  'openrouter',
  'deepinfra',
  'mistral',
  'ollama-cloud',
  'ollama',
  'lm-studio',
  'custom-openai-compatible',
] as const;

export type ProviderKind = (typeof PROVIDER_KIND_VALUES)[number];

export const NATIVE_LANGUAGE_OPTIONS = [
  { value: 'Japanese', label: '日本語', tag: 'ja' },
  { value: 'English', label: 'English', tag: 'en' },
  { value: 'Korean', label: '한국어', tag: 'ko' },
  { value: 'Chinese (Simplified)', label: '简体中文', tag: 'zh-Hans' },
  { value: 'Chinese (Traditional)', label: '繁體中文', tag: 'zh-Hant' },
  { value: 'Spanish', label: 'Español', tag: 'es' },
  { value: 'French', label: 'Français', tag: 'fr' },
  { value: 'German', label: 'Deutsch', tag: 'de' },
  { value: 'Arabic', label: 'العربية', tag: 'ar' },
  { value: 'Bengali', label: 'বাংলা', tag: 'bn' },
  { value: 'Czech', label: 'Čeština', tag: 'cs' },
  { value: 'Danish', label: 'Dansk', tag: 'da' },
  { value: 'Dutch', label: 'Nederlands', tag: 'nl' },
  { value: 'Finnish', label: 'Suomi', tag: 'fi' },
  { value: 'Greek', label: 'Ελληνικά', tag: 'el' },
  { value: 'Hebrew', label: 'עברית', tag: 'he' },
  { value: 'Hindi', label: 'हिन्दी', tag: 'hi' },
  { value: 'Hungarian', label: 'Magyar', tag: 'hu' },
  { value: 'Indonesian', label: 'Bahasa Indonesia', tag: 'id' },
  { value: 'Italian', label: 'Italiano', tag: 'it' },
  { value: 'Malay', label: 'Bahasa Melayu', tag: 'ms' },
  { value: 'Norwegian', label: 'Norsk', tag: 'no' },
  { value: 'Persian', label: 'فارسی', tag: 'fa' },
  { value: 'Polish', label: 'Polski', tag: 'pl' },
  { value: 'Portuguese (Brazil)', label: 'Português (Brasil)', tag: 'pt-BR' },
  { value: 'Portuguese (Portugal)', label: 'Português (Portugal)', tag: 'pt-PT' },
  { value: 'Romanian', label: 'Română', tag: 'ro' },
  { value: 'Russian', label: 'Русский', tag: 'ru' },
  { value: 'Swedish', label: 'Svenska', tag: 'sv' },
  { value: 'Thai', label: 'ไทย', tag: 'th' },
  { value: 'Turkish', label: 'Türkçe', tag: 'tr' },
  { value: 'Ukrainian', label: 'Українська', tag: 'uk' },
  { value: 'Urdu', label: 'اردو', tag: 'ur' },
  { value: 'Vietnamese', label: 'Tiếng Việt', tag: 'vi' },
] as const;

export type NativeLanguage = (typeof NATIVE_LANGUAGE_OPTIONS)[number]['value'];

// Zod enum と永続化検証は、UIの言語一覧と同じ単一ソースから生成する。
export const NATIVE_LANGUAGE_VALUES = NATIVE_LANGUAGE_OPTIONS.map(
  ({ value }) => value,
) as unknown as readonly [NativeLanguage, ...NativeLanguage[]];

export const APPEARANCE_VALUES = ['system', 'light', 'dark'] as const;
export type Appearance = (typeof APPEARANCE_VALUES)[number];

// 母国語の入力に対する翻訳先も、母国語と同じ対応範囲から選ぶ。
// 旧版の `native` は永続化層で実際の言語名へ移行する。
export const OTHER_LANGUAGE_TARGET_VALUES = NATIVE_LANGUAGE_VALUES;
export type OtherLanguageTarget = NativeLanguage;

/**
 * 母国語の入力を同じ言語へ翻訳する無効な設定を、通常の対訳先へ直す。
 * 多くの利用者は英語を対訳先にし、英語話者だけは日本語を安全な既定値にする。
 */
export function distinctTranslationTarget(
  nativeLanguage: NativeLanguage | null,
  targetLanguage: OtherLanguageTarget,
): OtherLanguageTarget {
  if (nativeLanguage === null || nativeLanguage !== targetLanguage) return targetLanguage;
  return nativeLanguage === 'English' ? 'Japanese' : 'English';
}

export const TRANSLATION_STYLE_VALUES = ['literal', 'natural'] as const;
export type TranslationStyle = (typeof TRANSLATION_STYLE_VALUES)[number];

export const HISTORY_RETENTION_DAY_VALUES = [30, 90, 180, 365] as const;
export type HistoryRetentionDays = (typeof HISTORY_RETENTION_DAY_VALUES)[number] | null;

export const MAX_WRITING_STYLE_NAME_LENGTH = 40;
export const MAX_WRITING_STYLE_DESCRIPTION_LENGTH = 200;
// 文体指示は翻訳本文ではなくProviderへ渡すプロンプトである。組み込みの詳細な
// 指示とユーザー定義の指示を保存できるよう、本文の1,000文字制限とは分離する。
export const MAX_WRITING_STYLE_INSTRUCTION_LENGTH = 10_000;

export interface WritingStyle {
  readonly id: string;
  readonly name: string;
  /** 一覧に表示する短い説明。未設定の旧データはinstructionを代用する。 */
  readonly description?: string | undefined;
  readonly instruction: string;
  /** 省略時は表示扱い。古い設定JSONとの互換性を保つためoptionalにする。 */
  readonly hidden?: boolean | undefined;
  /** Built-in styles use a tombstone so deletion remains stable across snapshots. */
  readonly deleted?: boolean | undefined;
  /** 調整メニューで文体を見分けやすくする短い絵文字。 */
  readonly icon?: string | undefined;
}

export interface WritingStyleInstruction {
  readonly name: string;
  readonly instruction: string;
}

// 調整メニューと文体管理で初期プリセットを共有する。
// 先頭2件は固定アクションとして調整メニューだけに表示する。
// 通常翻訳の標準状態は activeWritingStyleId=null で表し、文体プリセットには含めない。
export const DEFAULT_WRITING_STYLES = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    name: 'もう少し短く',
    description: '元の意味を保ちながら、短く分かりやすい表現。',
    instruction: '元の意味を保ちながら、短く分かりやすくします。',
    icon: '✊',
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    name: 'より詳しく',
    description: '元の意味を保ちながら、必要な説明を加えた表現。',
    instruction: '元の意味を保ちながら、必要な説明を加えます。',
    icon: '🖊️',
  },
  {
    id: '00000000-0000-4000-8000-000000000103',
    name: '淡々と',
    description: '落ち着いた、簡潔で事実に忠実な表現。',
    instruction: `Use a calm, restrained, matter-of-fact style.

- Express the content clearly and directly without unnecessary emotional coloring, dramatic emphasis, or rhetorical flourish.
- Prefer concise, declarative phrasing and straightforward sentence structures natural to the target language.
- Remove filler, redundancy, ornamental wording, and unnecessary intensifiers where doing so does not change the meaning.
- Keep the pace measured and the tone composed rather than enthusiastic, dramatic, persuasive, or overly friendly.
- Prefer concrete and specific wording over vague or inflated expressions.
- Avoid rhetorical questions, exclamations, hype, and attention-seeking phrasing unless they are essential to the source meaning.
- Preserve facts, numbers, names, uncertainty, certainty, emphasis, and logical relationships accurately.
- Do not make emotional content disappear when it carries actual meaning; express it in a restrained and natural way instead.
- Do not make the result artificially formal, bureaucratic, cold, or robotic merely to sound neutral.`,
    icon: '😶',
  },
  {
    id: '00000000-0000-4000-8000-000000000104',
    name: 'キャッチーに',
    description: '元の意味を保ちながら、印象に残るテンポのよい表現。',
    instruction: `Make the expression engaging, memorable, and rhythmically strong while preserving the original meaning.

- Prefer concise, punchy phrasing where it naturally improves impact.
- Put important ideas and strong semantic elements in prominent positions.
- Prefer concrete, active, vivid wording over weak, abstract, or unnecessarily wordy constructions.
- Tighten filler and redundancy so the central idea lands quickly.
- Vary sentence length and rhythm naturally; use shorter phrases selectively to create emphasis and momentum.
- Preserve hooks, contrasts, humor, wordplay, emotional beats, and memorable phrasing already present in the source.
- When the source wording is flat but the intent is expressive, choose a more engaging native formulation without changing the message.
- Use rhetorical devices, repetition, emphasis, or playful wording only when they fit the target language, audience, and original intent.
- Do not turn ordinary content into clickbait, advertising, hype, or exaggerated claims.
- Do not invent slogans, promises, benefits, urgency, emotions, facts, or calls to action that are absent from the source.`,
    icon: '🤩',
  },
  {
    id: '00000000-0000-4000-8000-000000000105',
    name: 'カジュアル',
    description: '自然で気取らない、リラックスした日常的なコミュニケーション。',
    instruction: `Use a casual, natural everyday register.

- Write the way native speakers normally communicate in relaxed situations.
- Reduce social distance using forms appropriate to the target language and context.
- Prefer everyday vocabulary and conversational constructions over formal, literary, or textbook-like wording.
- Use natural ellipsis, discourse markers, contractions, particles, informal constructions, or equivalent features where appropriate.
- Preserve humor, hesitation, teasing, emotion, emphasis, and conversational rhythm.
- Rephrase freely when literal wording would sound translated or unnatural.
- Slang and colloquialisms are allowed when they genuinely fit the speaker, audience, and context.
- Do not force slang or language-specific features merely to make the translation appear casual.`,
    icon: '😎',
  },
  {
    id: '00000000-0000-4000-8000-000000000106',
    name: '丁寧',
    description: '礼儀正しく、相手への配慮がある日常的な言葉遣い。',
    instruction: `Use a polite and courteous everyday register.

- Increase social respect and appropriate interpersonal distance using conventions natural to the target language.
- Use native politeness, honorific, pronoun, address, or register systems where relevant.
- Sound respectful without becoming excessively ceremonial, bureaucratic, archaic, or distant.
- Prefer standard polite vocabulary over slang or highly colloquial expressions.
- Phrase requests, disagreement, refusals, and sensitive statements with culturally natural politeness.
- Preserve the speaker's warmth, personality, confidence, and emotional intent.
- Do not raise the level of respect beyond what the source context reasonably supports.
- Do not mechanically copy politeness strategies from the source language when they would sound unnatural in the target language.`,
    icon: '🤓',
  },
  {
    id: '00000000-0000-4000-8000-000000000107',
    name: 'ネイティブらしく自然に',
    description: 'その言語のネイティブが自然に書いたような表現。',
    instruction: `Express the same meaning the way a native speaker of the target language would naturally express it.

- Prefer idiomatic, fluent target-language wording over literal word-for-word translation.
- Translate the communicative intent and meaning rather than mechanically reproducing source-language grammar.
- Restructure sentences, clauses, information order, or omitted elements when necessary so the result reads as if it were originally written in the target language.
- Choose vocabulary, collocations, expressions, discourse patterns, and sentence structures that native speakers would naturally use in the same situation.
- Avoid calques, translationese, textbook-like constructions, and unnatural phrasing caused by carrying source-language structures into the target language.
- Preserve the speaker's intent, personality, emotional tone, emphasis, social relationship, and level of formality.
- Preserve culturally meaningful distinctions using the most natural equivalent available in the target language rather than copying their surface form.
- If the original wording already maps naturally into the target language, do not rewrite it merely for the sake of change.
- Do not over-interpret, summarize, simplify, embellish, or add information that is not present in the source.
- Naturalness must never override factual accuracy or materially alter the original meaning.`,
    icon: '💫',
  },
  {
    id: '00000000-0000-4000-8000-000000000108',
    name: 'AIっぽさを消す',
    description: '定型的なAIらしい言い回しを避け、人が自然に書いたような表現。',
    instruction: `Rewrite the translation so it feels naturally written by a human rather than mechanically generated or formulaic.

- Preserve the original meaning, facts, intent, terminology, personality, and appropriate register.
- Prefer natural wording and genuine communicative purpose over overly polished, generic, or template-like prose.
- Vary sentence length, structure, pacing, and rhythm where natural instead of making every sentence follow the same pattern.
- Avoid repetitive sentence openings, mechanically symmetrical structures, predictable paragraph patterns, and excessive structural neatness.
- Remove empty framing, unnecessary summaries, redundant restatements, and generic filler that contributes no meaning.
- Avoid formulaic transitions, canned expressions, generic enthusiasm, unnecessary hedging, and stock phrases associated with machine-generated writing in the target language.
- Prefer simple, specific, context-appropriate wording over unnecessarily formal, abstract, inflated, or promotional vocabulary.
- Preserve natural irregularities already present in the speaker's voice, such as fragments, pauses, directness, understatement, or uneven sentence rhythm, when appropriate.
- Use the stylistic conventions of the target language itself; do not apply an English-specific list of "AI words" or English writing habits to other languages.
- Do not make the text artificially casual merely to appear human.
- Do not deliberately introduce spelling mistakes, grammatical errors, factual errors, awkward wording, fake anecdotes, personal experiences, opinions, or unsupported details.
- If the text already sounds natural and human, make minimal changes rather than rewriting it unnecessarily.`,
    icon: '👻',
  },
  {
    id: '00000000-0000-4000-8000-000000000110',
    name: '友人とのチャット',
    description: '親しい友人同士によるプライベートな会話。',
    instruction: `Write like a private conversation between close friends.

- Assume high familiarity and low social distance.
- Use the target language's natural close-friend register.
- Prefer lightweight conversational phrasing over complete formal prose.
- Allow fragments, ellipsis, informal particles, contractions, discourse markers, reactions, or equivalent features where natural.
- Preserve teasing, sarcasm, hesitation, excitement, embarrassment, annoyance, affection, and other interpersonal cues already present in the source.
- Keep the rhythm natural for messaging or casual conversation.
- Avoid unnecessary explanations and excessive politeness.
- Do not invent affection, jokes, slang, emojis, nicknames, or intimacy that the source does not imply.`,
    icon: '💬',
  },
  {
    id: '00000000-0000-4000-8000-000000000111',
    name: 'Z世代',
    description: '若いネイティブ話者が自然に使う、現代的な言葉遣い。',
    hidden: true,
    instruction: `Use contemporary casual language associated with younger native speakers.

- Prefer current everyday vocabulary, informal constructions, abbreviations, slang, and internet-influenced phrasing where genuinely natural in the target language.
- Keep the rhythm relatively quick, lightweight, and conversational.
- Fragments, repetition, emphasis, unconventional punctuation, particles, or equivalent expressive devices are acceptable where culturally natural.
- Preserve the source attitude, such as excitement, irony, indifference, annoyance, playfulness, or embarrassment.
- Avoid formal, literary, bureaucratic, or textbook-like phrasing.
- Do not insert slang into every sentence.
- Do not use outdated memes, exaggerated stereotypes, or expressions merely to signal youth.
- Never alter the actual meaning just to make the translation sound trendier.`,
    icon: '🔥',
  },
  {
    id: '00000000-0000-4000-8000-000000000112',
    name: 'インターネット掲示板',
    description: 'オンライン上のくだけた議論や匿名フォーラムで使われる文体。',
    hidden: true,
    instruction: `Write like a native speaker participating in an informal online discussion.

- Use concise, direct, colloquial wording.
- Allow sentence fragments, informal discourse markers, abbreviations, particles, or equivalent internet-native constructions where appropriate.
- Preserve bluntness, skepticism, sarcasm, rhetorical emphasis, dry humor, and casual argumentation when present in the source.
- Prefer natural online language over polished essay-style prose.
- Avoid unnecessary business-like politeness and formal transitions.
- Use broadly understandable internet language rather than highly obscure community-specific jargon.
- Do not invent insults, memes, opinions, factual claims, or cultural references that are absent from the source.
- Preserve readability even when adopting an informal online style.`,
    icon: '📣',
  },
  {
    id: '00000000-0000-4000-8000-000000000113',
    name: 'ビジネスメール',
    description: '明確で、文化的にも適切な業務上の文面。',
    hidden: true,
    instruction: `Use professional business correspondence appropriate to the target language and culture.

- Use a conventional professional register.
- Apply culturally appropriate politeness, forms of address, interpersonal distance, and business conventions.
- Be clear, composed, courteous, and concise.
- Make requests, deadlines, confirmations, responsibilities, conditions, and decisions unambiguous.
- Preserve the original degree of urgency, firmness, confidence, and politeness.
- Avoid slang, casual fillers, excessive emotionality, and overly conversational constructions.
- Avoid unnecessarily legalistic, archaic, ceremonial, or bureaucratic wording.
- Do not invent greetings, signatures, apologies, commitments, gratitude, pleasantries, or promises that are not present in the source.`,
    icon: '📧',
  },
  {
    id: '00000000-0000-4000-8000-000000000114',
    name: 'カスタマーサポート',
    description: '明確で、落ち着きがあり、顧客に親切な対応文。',
    hidden: true,
    instruction: `Write like a competent and courteous customer-support response.

- Use calm, clear, approachable language appropriate to the target language and culture.
- Prioritize readability and actionable information.
- Sound respectful and helpful without becoming robotic, overly formal, or excessively apologetic.
- Use culturally appropriate politeness and interpersonal distance.
- When the source contains empathy, reassurance, or apology, preserve it naturally and sincerely.
- Keep instructions simple and easy to follow.
- Preserve limitations, uncertainty, conditions, policies, and responsibilities accurately.
- Avoid blame, confrontation, slang, unnecessary jargon, and overly technical wording.
- Never invent apologies, refunds, guarantees, resolutions, compensation, policies, promises, or commitments absent from the source.`,
    icon: '🤝',
  },
  {
    id: '00000000-0000-4000-8000-000000000115',
    name: 'フォーム記入',
    description: '公式フォームや行政文書に適した正式な表現。',
    hidden: true,
    instruction: `Use formal wording suitable for official documents, applications, forms, and administrative interfaces.

- Prefer precise, standardized, unambiguous terminology.
- Use conventional administrative wording natural to the target language.
- Prefer concise noun phrases or standardized labels where appropriate instead of unnecessarily complete sentences.
- Avoid conversational expressions, slang, humor, emotional language, rhetorical flourishes, and casual fillers.
- Preserve names, numbers, dates, identifiers, legal references, administrative terms, and other factual information exactly.
- Keep repeated terminology consistent throughout the text.
- Do not introduce legal or bureaucratic implications that are not present in the source.
- Prioritize clarity, consistency, and precision over elegance or personality.`,
    icon: '📝',
  },
  {
    id: '00000000-0000-4000-8000-000000000116',
    name: 'ソーシャル投稿',
    description: '自然で簡潔な短文形式のソーシャルメディア向け文章。',
    hidden: true,
    instruction: `Write like a natural short-form social-media post.

- Keep the translation compact, immediate, and easy to scan.
- Prefer natural conversational wording and strong sentence rhythm.
- Avoid stiff or unnecessarily complete prose when shorter native phrasing works better.
- Preserve the source's excitement, humor, irony, frustration, enthusiasm, informality, or promotional energy.
- Use slang, abbreviations, particles, expressive punctuation, or equivalent features only when they naturally fit the source voice and target audience.
- Preserve existing mentions, hashtags, links, emojis, line breaks, and other social-media elements where practical.
- Do not invent hashtags, emojis, calls to action, promotional claims, engagement bait, or internet slang.
- Preserve meaning even when shortening or restructuring for natural social-media delivery.`,
    icon: '📣',
  },
  {
    id: '00000000-0000-4000-8000-000000000117',
    name: 'UIラベル',
    description: 'ソフトウェアの画面に適した、短く明確で自然な文言。',
    hidden: true,
    instruction: `Translate as concise native UI microcopy.

- Use the shortest natural wording that fully preserves the intended function and meaning.
- Prefer terminology commonly used by native software interfaces in the target language.
- Use conventional action wording for buttons, commands, menu items, settings, labels, and status messages.
- Avoid explanatory padding, unnecessary politeness, redundant words, and overly literal source-language structures.
- Preserve placeholders, variables, keyboard shortcuts, symbols, product names, identifiers, and technical tokens exactly.
- Maintain consistent terminology for repeated concepts.
- Follow punctuation and capitalization conventions natural to software interfaces in the target language.
- Never sacrifice clarity merely to make the text shorter.`,
    icon: '🛠️',
  },
  {
    id: '00000000-0000-4000-8000-000000000118',
    name: '学術論文',
    description: '形式的で正確な、学術・研究向けの文章。',
    hidden: true,
    instruction: `Use formal academic prose appropriate to the target language and discipline.

- Use precise, discipline-appropriate terminology and preserve technical distinctions.
- Maintain an objective, analytical, and academically conventional register.
- Preserve technical terminology, equations, citations, references, acronyms, established names, and specialized concepts accurately.
- Preserve logical relationships such as causality, contrast, qualification, uncertainty, scope, and evidential strength.
- Preserve the original level of certainty and do not strengthen or weaken claims.
- Avoid slang, conversational fillers, contractions or equivalent informal constructions, emotional exaggeration, and promotional language.
- Do not simplify specialized concepts merely for readability.
- Use sentence structures and connective devices natural to academic writing in the target language rather than mechanically copying the source structure.
- Prioritize semantic precision and logical clarity over conversational naturalness.`,
    icon: '🧠',
  },
] as const satisfies readonly WritingStyle[];

export const MAX_CUSTOM_WRITING_STYLES = 20;
export const MAX_WRITING_STYLES = DEFAULT_WRITING_STYLES.length + MAX_CUSTOM_WRITING_STYLES;
// Composerでは複数の保存済み文体と追加指示を1つのIPC payloadへまとめる。
// 各要素が保存時の上限内なら、組み合わせによってIPCだけが拒否しない上限にする。
export const MAX_COMBINED_WRITING_STYLE_NAME_LENGTH =
  MAX_WRITING_STYLES * (MAX_WRITING_STYLE_NAME_LENGTH + 3) + '追加の指示'.length;
export const MAX_COMBINED_WRITING_STYLE_INSTRUCTION_LENGTH =
  (MAX_WRITING_STYLES + 1) *
  (MAX_WRITING_STYLE_INSTRUCTION_LENGTH + MAX_WRITING_STYLE_NAME_LENGTH + 8);

// この2つは文体管理ではなく、調整メニューの固定アクションとして扱う。
export const FIXED_ADJUSTMENT_STYLE_IDS = [
  DEFAULT_WRITING_STYLES[0].id,
  DEFAULT_WRITING_STYLES[1].id,
] as const;

export const WRITING_STYLE_ICON_OPTIONS = [
  '✨',
  '✊',
  '🖊️',
  '😶',
  '🤩',
  '😎',
  '🤓',
  '💫',
  '👻',
  '💼',
  '📧',
  '🎯',
  '💬',
  '🌿',
  '🔥',
  '🧠',
  '📝',
  '🙌',
  '🙂',
  '😊',
  '🤝',
  '📣',
  '🔍',
  '🛠️',
] as const;

export type ProviderModelMetadataValue = string | number | boolean | null;

export interface ProviderModel {
  readonly id: string;
  /** APIが返した表示名。Model IDからFumuが生成することはない。 */
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly ownedBy?: string | undefined;
  readonly contextLength?: number | undefined;
  readonly createdAt?: number | undefined;
  readonly metadata: Readonly<Record<string, ProviderModelMetadataValue>>;
  readonly source: 'api' | 'manual';
}

interface ProviderConnectionBase {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly hasApiKey: boolean;
  readonly models: readonly ProviderModel[];
  readonly enabledModelIds: readonly string[];
}

export type ProviderConnection =
  | (ProviderConnectionBase & {
      readonly kind:
        | 'chatgpt'
        | 'openai'
        | 'anthropic'
        | 'google'
        | 'groq'
        | 'openrouter'
        | 'deepinfra'
        | 'mistral'
        | 'ollama-cloud';
    })
  | (ProviderConnectionBase & {
      readonly kind: 'ollama' | 'lm-studio';
      readonly baseUrl: string;
    })
  | (ProviderConnectionBase & {
      readonly kind: 'custom-openai-compatible';
      readonly baseUrl: string;
      readonly supportsJsonObjectResponse: boolean;
      readonly includeUsage: boolean;
    });

interface ProviderConnectionDefinitionBase {
  readonly id: string | null;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly models: readonly ProviderModel[];
  readonly enabledModelIds: readonly string[];
}

export type ProviderConnectionDefinition =
  | (ProviderConnectionDefinitionBase & {
      readonly kind:
        | 'chatgpt'
        | 'openai'
        | 'anthropic'
        | 'google'
        | 'groq'
        | 'openrouter'
        | 'deepinfra'
        | 'mistral'
        | 'ollama-cloud';
    })
  | (ProviderConnectionDefinitionBase & {
      readonly kind: 'ollama' | 'lm-studio';
      readonly baseUrl: string;
    })
  | (ProviderConnectionDefinitionBase & {
      readonly kind: 'custom-openai-compatible';
      readonly baseUrl: string;
      readonly supportsJsonObjectResponse: boolean;
      readonly includeUsage: boolean;
    });

export type ProviderSecretUpdate =
  | { readonly action: 'preserve' }
  | { readonly action: 'clear' }
  | { readonly action: 'replace'; readonly apiKey: string };

export interface SaveProviderRequest {
  readonly provider: ProviderConnectionDefinition;
  readonly secret: ProviderSecretUpdate;
}

export interface FetchProviderModelsRequest {
  readonly provider: ProviderConnectionDefinition;
  readonly secret: ProviderSecretUpdate;
}

export interface UsedModelReference {
  readonly providerId: string;
  readonly modelId: string;
}

export interface UpdateUsedModelsRequest {
  readonly models: readonly UsedModelReference[];
}

export interface GeneralSettingsUpdate {
  readonly historyEnabled?: boolean | undefined;
  readonly launchAtLogin?: boolean | undefined;
  readonly enterToSend?: boolean | undefined;
  readonly compactTranslation?: boolean | undefined;
  readonly developerMode?: boolean | undefined;
  readonly debugMode?: boolean | undefined;
  readonly translationStyle?: TranslationStyle | undefined;
  readonly nativeLanguage?: NativeLanguage | null | undefined;
  readonly appearance?: Appearance | undefined;
  readonly otherLanguageTarget?: OtherLanguageTarget | undefined;
  readonly historyRetentionDays?: HistoryRetentionDays | undefined;
  readonly writingStyles?: readonly WritingStyle[] | undefined;
  readonly activeWritingStyleId?: string | null | undefined;
  readonly onboardingCompleted?: boolean | undefined;
}

export interface SettingsSnapshot {
  readonly shortcut: string;
  readonly launchAtLogin: boolean;
  readonly enterToSend: boolean;
  readonly compactTranslation: boolean;
  readonly developerMode: boolean;
  readonly translationStyle: TranslationStyle;
  readonly startupSupported: boolean;
  readonly historyEnabled: boolean;
  readonly debugMode: boolean;
  readonly nativeLanguage: NativeLanguage | null;
  readonly appearance: Appearance;
  readonly otherLanguageTarget: OtherLanguageTarget;
  readonly historyRetentionDays: HistoryRetentionDays;
  readonly writingStyles: readonly WritingStyle[];
  readonly activeWritingStyleId: string | null;
  readonly onboardingCompleted: boolean;
  readonly providers: readonly ProviderConnection[];
  /** 先頭がメイン、以降は接続障害時のfallback順。 */
  readonly usedModels: readonly UsedModelReference[];
}

export interface ShortcutUpdateResult {
  readonly state: 'registered' | 'conflict' | 'invalid' | 'disabled';
  readonly shortcut: string;
  readonly message: string | null;
}
