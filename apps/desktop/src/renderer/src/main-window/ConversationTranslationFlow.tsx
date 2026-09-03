import { useEffect, useRef, useState } from 'react';
import { ArrowUp, PenLine } from 'lucide-react';
import type { TranslationViewState } from '../../../shared/contracts';
import { TranslationResultPanel } from '../TranslationResultPanel';
import { useI18n } from '../i18n';
import {
  completedConversationResult,
  nextConversationDirection,
  shouldSubmitConversationReply,
  type ConversationDirection,
  type ConversationTurn,
} from './conversation-session';

interface ActiveConversationTurn {
  readonly id: string;
  readonly direction: ConversationDirection;
  readonly sourceText: string;
  readonly state: TranslationViewState | null;
  readonly appliedInstructions: ConversationTurn['appliedInstructions'];
}

export function ConversationTurnResult({
  turn,
  interactive = false,
}: {
  readonly turn: ConversationTurn;
  readonly interactive?: boolean;
}) {
  const { t } = useI18n();
  return (
    <article className={`conversation-turn ${turn.direction}`}>
      <span className="conversation-speaker">
        {turn.direction === 'incoming' ? t('main.incomingMessage') : t('main.yourMessage')}
      </span>
      <TranslationResultPanel
        sourceText={turn.sourceText}
        translation={turn.translation}
        followUpMessages={[]}
        appliedInstructions={turn.appliedInstructions}
        interactive={interactive}
        showFollowUpForm={false}
      />
    </article>
  );
}

export function ConversationTranslationFlow({
  turns,
  activeTurn,
  enterToSend,
  submitting,
  activeTurnInteractive = true,
  onSubmit,
}: {
  readonly turns: readonly ConversationTurn[];
  readonly activeTurn: ActiveConversationTurn;
  readonly enterToSend: boolean;
  readonly submitting: boolean;
  readonly activeTurnInteractive?: boolean;
  readonly onSubmit: (text: string, direction: ConversationDirection) => void;
}) {
  const { t } = useI18n();
  const [replyOpen, setReplyOpen] = useState(false);
  const [reply, setReply] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nextDirection = nextConversationDirection(activeTurn.direction);
  const ready = activeTurn.state !== null && completedConversationResult(activeTurn.state) !== null;

  useEffect(() => {
    setReplyOpen(false);
    setReply('');
  }, [activeTurn.id]);

  const openReply = (): void => {
    setReplyOpen(true);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const submitReply = (): void => {
    const value = reply.trim();
    if (!value || submitting || !ready) return;
    onSubmit(value, nextDirection);
  };

  return (
    <section className="conversation-flow" aria-label={t('main.conversation')}>
      {turns.map((turn) => (
        <ConversationTurnResult turn={turn} key={turn.id} />
      ))}
      {activeTurn.state === null ? (
        <div className="conversation-turn-loading" aria-label={t('result.translating')}>
          <span />
          <span />
          <span />
        </div>
      ) : (
        <ConversationTurnResult
          turn={{
            id: activeTurn.id,
            direction: activeTurn.direction,
            sourceText: activeTurn.sourceText,
            translation: activeTurn.state,
            appliedInstructions: activeTurn.appliedInstructions,
          }}
          interactive={activeTurnInteractive}
        />
      )}
      {ready &&
        (replyOpen ? (
          <form
            className="conversation-reply-composer"
            onSubmit={(event) => {
              event.preventDefault();
              submitReply();
            }}
          >
            <textarea
              ref={textareaRef}
              aria-label={
                nextDirection === 'outgoing' ? t('main.writeReply') : t('main.addIncomingReply')
              }
              value={reply}
              maxLength={100_000}
              placeholder={
                nextDirection === 'outgoing' ? t('main.writeReply') : t('main.addIncomingReply')
              }
              disabled={submitting}
              onChange={(event) => setReply(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (!shouldSubmitConversationReply(event, enterToSend)) return;
                event.preventDefault();
                submitReply();
              }}
            />
            <button
              type="submit"
              aria-label={t('main.translate')}
              disabled={submitting || !reply.trim()}
            >
              <ArrowUp size={18} />
            </button>
          </form>
        ) : (
          <button className="conversation-next-turn" type="button" onClick={openReply}>
            <PenLine size={17} aria-hidden="true" />
            {nextDirection === 'outgoing' ? t('main.writeReply') : t('main.addIncomingReply')}
          </button>
        ))}
    </section>
  );
}
