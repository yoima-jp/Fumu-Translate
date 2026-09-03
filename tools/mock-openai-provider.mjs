import http from 'node:http';

const port = Number.parseInt(process.env.FUMU_MOCK_PROVIDER_PORT ?? '43120', 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('FUMU_MOCK_PROVIDER_PORT must be a valid TCP port.');
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function sse(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function payloadFromBody(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const content = messages.at(-1)?.content;
  if (typeof content !== 'string') {
    return {};
  }
  try {
    const payload = JSON.parse(content);
    return typeof payload === 'object' && payload !== null ? payload : {};
  } catch {
    return {};
  }
}

function translatedResult(payload) {
  const sourceText = typeof payload.sourceText === 'string' ? payload.sourceText : '';
  const currentTranslation =
    typeof payload.currentResult?.translation === 'string'
      ? payload.currentResult.translation
      : sourceText;
  const task = typeof payload.task === 'string' ? payload.task : 'translate';
  if (task === 'assess-back-translation') {
    const originalSource = typeof payload.originalSource === 'string' ? payload.originalSource : '';
    const forwardTranslation =
      typeof payload.forwardTranslation === 'string' ? payload.forwardTranslation : '';
    return {
      translationNatural: !forwardTranslation.includes('__UNNATURAL__'),
      meaningPreserved: !originalSource.includes('__MEANING_DRIFT__'),
      explanation: '原文・翻訳文・戻し訳文を別セッションで比較した評価です。',
    };
  }
  const detectedSourceLanguage = /[\u3040-\u30ff\u3400-\u9fff]/u.test(sourceText)
    ? 'Japanese'
    : 'English';
  const routing =
    typeof payload.languageRouting === 'object' && payload.languageRouting !== null
      ? payload.languageRouting
      : null;
  const nativeLanguage =
    routing !== null && typeof routing.nativeLanguage === 'string' ? routing.nativeLanguage : null;
  const nativeSourceTarget =
    routing !== null && Array.isArray(routing.rules)
      ? routing.rules[0]?.match(/, translate to (.+)\.$/u)?.[1]
      : null;
  const routedTargetLanguage =
    nativeLanguage !== null && detectedSourceLanguage === nativeLanguage
      ? (nativeSourceTarget ?? payload.targetLanguage)
      : nativeLanguage !== null
        ? nativeLanguage
        : typeof payload.targetLanguage === 'string'
          ? payload.targetLanguage
          : 'Japanese';
  const baseTranslation =
    routedTargetLanguage === 'English'
      ? `Translated naturally: ${sourceText}`
      : `「${sourceText}」の翻訳です。`;

  const variants = {
    translate: baseTranslation,
    casual: `カジュアルに言うと「${currentTranslation}」`,
    polite: `丁寧に申し上げると「${currentTranslation}」`,
    shorter: `要約: ${currentTranslation}`,
    detailed: `文脈を補って詳しく言うと「${currentTranslation}」`,
    plain: `簡潔に述べると「${currentTranslation}」`,
    catchy: `印象的に言うと「${currentTranslation}」`,
    natural: `自然な表現では「${currentTranslation}」`,
    humanize: `人らしい表現では「${currentTranslation}」`,
    alternatives: `別表現: ${currentTranslation}`,
    'back-translate':
      payload.targetLanguage === 'Japanese'
        ? `「${currentTranslation}」を日本語へ戻した文です。`
        : `Back translation of: ${currentTranslation}`,
  };
  const reversing = task === 'back-translate';
  const testTerm = sourceText.trim() === 'テスト';
  const alternativesNeeded =
    task === 'alternatives' || sourceText.includes('__AMBIGUOUS__') || testTerm;

  return {
    translation: variants[task] ?? variants.translate,
    explanation: reversing
      ? '訳文だけを逆方向に翻訳した確認結果です。'
      : `${task} 操作をローカルで検証した結果です。`,
    alternativesNeeded,
    alternatives: alternativesNeeded
      ? testTerm
        ? [
            { text: 'Exam', nuance: '学校などの試験' },
            { text: 'Trial', nuance: '試行やお試し' },
          ]
        : [
            { text: `別案1: ${currentTranslation}`, nuance: '異なる意味の解釈' },
            { text: `別案2: ${currentTranslation}`, nuance: '別の文脈で成立する解釈' },
          ]
      : [],
    sourceLanguage:
      reversing && typeof payload.sourceLanguage === 'string'
        ? payload.sourceLanguage
        : detectedSourceLanguage,
    targetLanguage:
      reversing && typeof payload.targetLanguage === 'string'
        ? payload.targetLanguage
        : routedTargetLanguage,
  };
}

function streamText(response, text) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const chunkSize = Math.max(1, Math.ceil(text.length / 5));
  const chunks = Array.from({ length: Math.ceil(text.length / chunkSize) }, (_, index) =>
    text.slice(index * chunkSize, (index + 1) * chunkSize),
  );
  let index = 0;
  const timer = setInterval(() => {
    const content = chunks[index];
    if (content !== undefined) {
      response.write(
        sse({
          id: 'mock-completion',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        }),
      );
      index += 1;
      return;
    }

    response.write(
      sse({
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 },
      }),
    );
    response.write('data: [DONE]\n\n');
    response.end();
    clearInterval(timer);
  }, 90);
  response.on('close', () => clearInterval(timer));
}

const failedFollowUps = new Set();

const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    sendJson(response, 404, { error: { message: 'Not found' } });
    return;
  }

  let requestBody = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    requestBody += chunk;
    if (requestBody.length > 1_000_000) {
      request.destroy();
    }
  });
  request.on('end', () => {
    let body;
    try {
      body = JSON.parse(requestBody);
    } catch {
      sendJson(response, 400, { error: { message: 'Invalid JSON' } });
      return;
    }
    if (typeof body !== 'object' || body === null) {
      sendJson(response, 400, { error: { message: 'JSON object required' } });
      return;
    }

    const payload = payloadFromBody(body);
    if (body.response_format?.type === 'json_object') {
      streamText(response, JSON.stringify(translatedResult(payload)));
      return;
    }

    const question = typeof payload.question === 'string' ? payload.question : '';
    if (question.startsWith('__FUMU_FAIL_ONCE__') && !failedFollowUps.has(question)) {
      failedFollowUps.add(question);
      sendJson(response, 503, { error: { message: 'Intentional mock failure' } });
      return;
    }
    streamText(
      response,
      `「${question}」への回答です。訳語は文脈と話し手の意図に合わせて選んでいます。`,
    );
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Fumu mock provider listening on http://127.0.0.1:${String(port)}/v1/\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
