import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmImageInput } from '@fumu/llm-core';

// OS標準OCR（Windows.Media.Ocr）で画像内の文字を読む。
// 追加の依存や言語データの同梱が不要で、画像を外部へ送らずに済むため「OCRモード」の既定にしている。
// WinRTのOCR APIはNodeから直接呼べないため、Windows 10/11に必ずあるWindows PowerShell 5.1
// （powershell.exe）経由で呼ぶ。PowerShell 7（pwsh）はWinRT projectionを持たないので使わない。
// Windows OCRは認識言語を1つ選んで読む。日本語の認識器は英文を「Theundisputed」のように
// 単語区切りを落として読むため、インストール済みの認識言語すべてで読み、文字種から最適な結果を選ぶ。
// OCR言語パックが無い言語（例: 日本語環境での韓国語）は読めないので、呼び出し側でAIモデルへfallbackする。

export type SystemOcrResult =
  | { readonly status: 'completed'; readonly text: string }
  | { readonly status: 'no-text' }
  /** OCRを実行できない（Windows以外、OCR言語が無い、PowerShellが失敗した等）。 */
  | { readonly status: 'unavailable'; readonly reason: string };

// 画像パスはコマンドラインへ埋め込まず環境変数で渡し、パス文字列によるスクリプト注入を防ぐ。
const OCR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1'
} | Select-Object -First 1
function Await($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait()
  $task.Result
}
$engines = @()
$primary = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -ne $primary) { $engines += $primary }
foreach ($language in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
  if ($engines.Count -ge 4) { break }
  if ($null -ne $primary -and $language.LanguageTag -eq $primary.RecognizerLanguage.LanguageTag) { continue }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if ($null -ne $engine) { $engines += $engine }
}
if ($engines.Count -eq 0) { Write-Output '{"status":"unavailable"}'; exit 0 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:FUMU_OCR_IMAGE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $scale = 1
  $longestEdge = [Math]::Max($decoder.PixelWidth, $decoder.PixelHeight)
  if ($longestEdge * 2 -le [Math]::Min(4096, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension)) { $scale = 2 }
  $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
  $transform.ScaledWidth = [uint32]($decoder.PixelWidth * $scale)
  $transform.ScaledHeight = [uint32]($decoder.PixelHeight * $scale)
  $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
    [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
    $transform,
    [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
    [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
  )) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $results = @(foreach ($engine in $engines) {
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    [pscustomobject]@{
      language = $engine.RecognizerLanguage.LanguageTag
      lines = @($result.Lines | ForEach-Object { ,@($_.Words | ForEach-Object { $_.Text }) })
    }
  })
} finally {
  $stream.Dispose()
}
[pscustomobject]@{ status = 'ok'; results = $results } | ConvertTo-Json -Depth 6 -Compress
`;

const ENCODED_OCR_SCRIPT = Buffer.from(OCR_SCRIPT, 'utf16le').toString('base64');
// Windows OCRは画面キャプチャの小さな文字（100% DPIの12px前後）を読み違えやすい。
// スクリプト内で2倍に拡大（Fant補間）してから認識させると誤読が大きく減るため、
// 拡大後もOCRの上限辺長と4096px以内に収まる画像だけ拡大している。
// 初回はWinRTの読み込みで数秒かかることがある。これを超える場合は固まったとみなしてfallbackする。
const OCR_TIMEOUT_MS = 30_000;
const MAX_OCR_OUTPUT_BYTES = 5 * 1024 * 1024;

// 日本語・中国語・韓国語はWindows OCRが1文字ずつを単語として返すため、単語間の空白を入れると
// 「翻 訳」のように崩れる。全角記号も含め、どちらか一方がCJK側なら空白を入れずに連結する。
const CJK_CHARACTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯ー]/u;

function joinWords(words: readonly string[]): string {
  let line = '';
  for (const word of words) {
    if (word.length === 0) continue;
    const previous = line.at(-1);
    const next = word[0];
    const needsSpace =
      previous !== undefined &&
      next !== undefined &&
      !CJK_CHARACTER.test(previous) &&
      !CJK_CHARACTER.test(next);
    line += needsSpace ? ` ${word}` : word;
  }
  return line;
}

/** Windows OCRの行・単語配列を、翻訳元として読める改行区切りの文章へ戻す。 */
export function joinOcrLines(lines: readonly (readonly string[] | string)[]): string {
  return lines
    .map((line) => (typeof line === 'string' ? line : joinWords(line)).trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export interface OcrCandidate {
  /** BCP-47（例: 'ja', 'en-US'）。 */
  readonly language: string;
  readonly text: string;
}

const CJK_RECOGNIZER_LANGUAGE = /^(?:ja|zh|ko)(?:-|$)/iu;
const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * 言語ごとのOCR結果から翻訳元にする1つを選ぶ。先頭はユーザーの言語設定で選ばれた認識器。
 * 先頭の結果が主にラテン文字なら英文などの画像とみなし、ラテン文字向け（CJK以外）の認識器の結果を使う。
 * CJKの認識器は英単語の区切りを落とすが、CJK以外の認識器は日本語を読めないため、逆方向には切り替えない。
 */
export function chooseOcrCandidate(candidates: readonly OcrCandidate[]): OcrCandidate | null {
  const nonEmpty = candidates.filter((candidate) => candidate.text.length > 0);
  const primary = nonEmpty[0];
  if (primary === undefined) return null;
  let latin = 0;
  let cjk = 0;
  for (const character of primary.text) {
    if (LATIN_LETTER.test(character)) latin += 1;
    else if (CJK_CHARACTER.test(character)) cjk += 1;
  }
  // 日本語認識器が英文で出すCJKの誤読は1〜2文字の孤立した文字になりやすい。3文字以上続くCJKは
  // 本物の日本語などとみなし、英文中心でも混在画像の日本語を落とさないよう先頭の結果を保つ。
  const hasCjkRun = new RegExp(`${CJK_CHARACTER.source}{3,}`, 'u').test(primary.text);
  const mostlyLatin = latin > 0 && latin / (latin + cjk) >= 0.7 && !hasCjkRun;
  if (!mostlyLatin || !CJK_RECOGNIZER_LANGUAGE.test(primary.language)) return primary;
  return nonEmpty.find((candidate) => !CJK_RECOGNIZER_LANGUAGE.test(candidate.language)) ?? primary;
}

function normalizedLines(value: unknown): (readonly string[] | string)[] {
  if (!Array.isArray(value)) return [];
  return value.map((line: unknown) =>
    Array.isArray(line)
      ? line.filter((word): word is string => typeof word === 'string')
      : typeof line === 'string'
        ? line
        : '',
  );
}

function parseOcrOutput(output: string): SystemOcrResult {
  const parsed: unknown = JSON.parse(output.trim());
  if (typeof parsed !== 'object' || parsed === null || !('status' in parsed)) {
    return { status: 'unavailable', reason: 'invalid-output' };
  }
  if (parsed.status === 'unavailable') return { status: 'unavailable', reason: 'no-ocr-language' };
  // ConvertTo-Jsonは要素が1つの配列をobjectへ潰すことがあるため、どちらの形も受け付ける。
  const rawResults: unknown[] =
    'results' in parsed ? (Array.isArray(parsed.results) ? parsed.results : [parsed.results]) : [];
  const candidates = rawResults.flatMap((result): OcrCandidate[] => {
    if (typeof result !== 'object' || result === null) return [];
    const language =
      'language' in result && typeof result.language === 'string' ? result.language : '';
    const lines = 'lines' in result ? normalizedLines(result.lines) : [];
    return [{ language, text: joinOcrLines(lines) }];
  });
  const chosen = chooseOcrCandidate(candidates);
  return chosen === null ? { status: 'no-text' } : { status: 'completed', text: chosen.text };
}

function abortError(): DOMException {
  return new DOMException('The system OCR was cancelled.', 'AbortError');
}

function runOcrProcess(imagePath: string, signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        ENCODED_OCR_SCRIPT,
      ],
      {
        env: { ...process.env, FUMU_OCR_IMAGE: imagePath },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error: unknown, output?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error === null && output !== undefined) resolve(output);
      else reject(error);
    };
    const onAbort = (): void => {
      child.kill();
      finish(abortError());
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('System OCR timed out.'));
    }, OCR_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OCR_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('System OCR output is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    // stderrは読み捨てる。読まないとpipeが詰まり、PowerShellが終了しなくなることがある。
    child.stderr.resume();
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`System OCR exited with code ${String(code)}.`));
        return;
      }
      finish(null, Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/**
 * 画像を一時ファイルへ書き出してOS標準OCRで読む。中断はAbortErrorとしてthrowし、
 * それ以外の失敗は'unavailable'として返す（呼び出し側がAIモデルへfallbackできるように）。
 */
export async function recognizeWithSystemOcr(
  image: LlmImageInput,
  signal?: AbortSignal,
): Promise<SystemOcrResult> {
  if (process.platform !== 'win32')
    return { status: 'unavailable', reason: 'unsupported-platform' };

  const directory = await mkdtemp(join(tmpdir(), 'fumu-ocr-'));
  try {
    const extension = image.mediaType === 'image/jpeg' ? 'jpg' : 'png';
    const imagePath = join(directory, `image.${extension}`);
    await writeFile(imagePath, Buffer.from(image.base64Data, 'base64'));
    const output = await runOcrProcess(imagePath, signal);
    return parseOcrOutput(output);
  } catch (error) {
    if (signal?.aborted === true) throw abortError();
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'unknown',
    };
  } finally {
    // 画像はスクリーンショット由来で個人情報を含み得るため、成否にかかわらず必ず消す。
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
