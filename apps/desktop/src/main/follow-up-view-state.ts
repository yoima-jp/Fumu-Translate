import type { FollowUpMessageView } from '../shared/contracts';

export function startFollowUpMessages(
  current: readonly FollowUpMessageView[],
  requestId: string,
  question: string,
): readonly FollowUpMessageView[] {
  const messages = [...current];
  const previousAssistant = messages.at(-1);
  const previousUser = messages.at(-2);
  const retrying =
    previousAssistant?.role === 'assistant' &&
    previousAssistant.phase === 'failed' &&
    previousUser?.role === 'user' &&
    previousUser.text === question;

  // 再試行は同じ質問を会話へ再追加せず、失敗した回答だけを新しいrequestへ差し替える。
  // Providerへ渡す確定履歴にも失敗したturnは含めないため、画面と会話contextが一致する。
  if (retrying) {
    messages.pop();
  } else {
    messages.push({ id: `${requestId}:user`, role: 'user', text: question });
  }
  messages.push({
    id: requestId,
    role: 'assistant',
    phase: 'loading',
    text: '',
    errorMessage: null,
    retryable: false,
  });
  return messages;
}
