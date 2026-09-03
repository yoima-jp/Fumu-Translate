import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  MAX_INLINE_TRANSLATION_CONTEXT_CODE_POINTS,
  MAX_TRANSLATION_SOURCE_CODE_POINTS,
  validateInlineTranslationContexts,
} from '@fumu/translation-core';
import {
  inlineContextCandidates,
  isInlineContextTriggerBoundary,
  normalizeInlineContext,
} from './inline-context';
import { useI18n } from '../i18n';
import { defaultInlineContexts, localizedInlineContext } from '../i18n/inline-contexts';

const CARET_SENTINEL = '\u200b';

export interface InlineContextEditorValue {
  readonly text: string;
  readonly inlineContexts: readonly string[];
}

interface MentionQuery {
  readonly query: string;
  readonly top: number;
  readonly left: number;
}

interface MentionElement extends HTMLElement {
  readonly dataset: DOMStringMap & { readonly inlineContext: string };
}

function isMentionElement(node: Node | null): node is MentionElement {
  return node instanceof HTMLElement && node.dataset.inlineContext !== undefined;
}

function sourceTextFrom(root: ParentNode): string {
  let text = '';
  const append = (node: Node): void => {
    if (node instanceof Text) {
      text += node.data;
      return;
    }
    if (!(node instanceof HTMLElement) || isMentionElement(node)) return;
    if (node.tagName === 'BR') {
      text += '\n';
      return;
    }
    const isBlock = node.tagName === 'DIV' || node.tagName === 'P';
    if (isBlock && text.length > 0 && !text.endsWith('\n')) text += '\n';
    node.childNodes.forEach(append);
  };
  root.childNodes.forEach(append);
  return text.replaceAll(CARET_SENTINEL, '').replaceAll('\u00a0', ' ').replaceAll('\r\n', '\n');
}

function editorValue(editor: HTMLDivElement): InlineContextEditorValue {
  const inlineContexts = Array.from(editor.querySelectorAll<HTMLElement>('[data-inline-context]'))
    .map((element) => normalizeInlineContext(element.dataset.inlineContext ?? ''))
    .filter((context) => context.length > 0);
  return { text: sourceTextFrom(editor), inlineContexts };
}

function updatePlaceholderVisibility(editor: HTMLDivElement): void {
  const currentValue = editorValue(editor);
  // IME変換中はReactのstateを確定させないため、疑似要素の空判定だけは実DOMから
  // 同期する。これにより変換中の文字列とプレースホルダーが重なって表示されない。
  editor.dataset.editorHasContent = String(
    currentValue.text.length > 0 || currentValue.inlineContexts.length > 0,
  );
}

function rangeIsInside(range: Range, editor: HTMLDivElement): boolean {
  return editor.contains(range.commonAncestorContainer) || range.commonAncestorContainer === editor;
}

function currentMentionQuery(editor: HTMLDivElement): { query: string; range: Range } | null {
  const selection = window.getSelection();
  if (selection === null || !selection.isCollapsed || selection.rangeCount === 0) return null;
  const focusNode = selection.focusNode;
  if (!(focusNode instanceof Text) || !editor.contains(focusNode)) return null;
  const offset = selection.focusOffset;
  const prefix = focusNode.data.slice(0, offset);
  const markerOffset = prefix.lastIndexOf('@');
  if (markerOffset < 0 || !isInlineContextTriggerBoundary(prefix, markerOffset)) return null;
  const query = prefix.slice(markerOffset + 1).replaceAll(CARET_SENTINEL, '');
  if (
    query.includes('@') ||
    query.includes('[') ||
    query.includes(']') ||
    query.includes('\n') ||
    Array.from(query).length > MAX_INLINE_TRANSLATION_CONTEXT_CODE_POINTS
  ) {
    return null;
  }
  const range = document.createRange();
  range.setStart(focusNode, markerOffset);
  range.setEnd(focusNode, offset);
  return { query, range };
}

function adjacentMention(
  editor: HTMLDivElement,
  direction: 'backward' | 'forward',
): HTMLElement | null {
  const selection = window.getSelection();
  if (selection === null || !selection.isCollapsed || selection.rangeCount === 0) return null;
  const node = selection.focusNode;
  const offset = selection.focusOffset;
  if (node === null || (node !== editor && !editor.contains(node))) return null;

  if (node instanceof Text) {
    const edgeText =
      direction === 'backward' ? node.data.slice(0, offset) : node.data.slice(offset);
    if (edgeText.replaceAll(CARET_SENTINEL, '').length > 0) return null;
    let sibling = direction === 'backward' ? node.previousSibling : node.nextSibling;
    while (sibling instanceof Text && sibling.data.replaceAll(CARET_SENTINEL, '').length === 0) {
      sibling = direction === 'backward' ? sibling.previousSibling : sibling.nextSibling;
    }
    return isMentionElement(sibling) ? sibling : null;
  }

  if (node instanceof HTMLElement) {
    const candidateIndex = direction === 'backward' ? offset - 1 : offset;
    const candidate = candidateIndex >= 0 ? node.childNodes.item(candidateIndex) : null;
    return isMentionElement(candidate) ? candidate : null;
  }
  return null;
}

function placeCaretAfter(node: Node): void {
  const selection = window.getSelection();
  if (selection === null) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectedSourceCodePoints(editor: HTMLDivElement): number {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return 0;
  const range = selection.getRangeAt(0);
  if (!rangeIsInside(range, editor)) return 0;
  return Array.from(sourceTextFrom(range.cloneContents())).length;
}

function enforceSourceLimit(editor: HTMLDivElement): void {
  let excess = Array.from(editorValue(editor).text).length - MAX_TRANSLATION_SOURCE_CODE_POINTS;
  if (excess <= 0) return;

  // Normal key and paste input are prevented before overflow. This fallback reconciles the
  // actual DOM after IME composition, where mutating content during composition would break IME.
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest('[data-inline-context]') === null
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) textNodes.push(node);
  }
  for (const node of textNodes.reverse()) {
    const characters = Array.from(node.data);
    for (let index = characters.length - 1; index >= 0 && excess > 0; index -= 1) {
      if (characters[index] === CARET_SENTINEL) continue;
      characters.splice(index, 1);
      excess -= 1;
    }
    node.data = characters.join('');
    if (excess === 0) break;
  }
  for (const lineBreak of Array.from(editor.querySelectorAll('br')).reverse()) {
    if (excess <= 0) break;
    lineBreak.remove();
    excess = Array.from(editorValue(editor).text).length - MAX_TRANSLATION_SOURCE_CODE_POINTS;
  }
  for (const block of Array.from(editor.querySelectorAll('div, p')).reverse()) {
    if (excess <= 0) break;
    if (block.textContent?.replaceAll(CARET_SENTINEL, '').length !== 0) continue;
    block.remove();
    excess = Array.from(editorValue(editor).text).length - MAX_TRANSLATION_SOURCE_CODE_POINTS;
  }
  placeCaretAfter(editor);
}

export function InlineContextEditor({
  label,
  placeholder,
  submitOnEnter,
  onChange,
  onSubmit,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly submitOnEnter: boolean;
  readonly onChange: (value: InlineContextEditorValue) => void;
  readonly onSubmit: () => void;
}): React.JSX.Element {
  const { locale, t } = useI18n();
  const localizedDefaultContexts = defaultInlineContexts(locale);
  const editorRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const mentionRangeRef = useRef<Range | null>(null);
  const composingRef = useRef(false);
  const [value, setValue] = useState<InlineContextEditorValue>({ text: '', inlineContexts: [] });
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const optionIdPrefix = useId();
  const candidates = useMemo(
    () =>
      mention === null
        ? []
        : inlineContextCandidates(mention.query, value.inlineContexts, localizedDefaultContexts),
    [localizedDefaultContexts, mention, value.inlineContexts],
  );

  const closeMention = (): void => {
    mentionRangeRef.current = null;
    setMention(null);
    setActiveIndex(0);
  };
  const publishValue = (): InlineContextEditorValue => {
    const editor = editorRef.current;
    if (editor === null) return value;
    const nextValue = editorValue(editor);
    setValue(nextValue);
    onChange(nextValue);
    return nextValue;
  };
  const refreshMention = (): void => {
    const editor = editorRef.current;
    if (editor === null || composingRef.current) return;
    const current = currentMentionQuery(editor);
    if (current === null) {
      closeMention();
      return;
    }
    const currentValue = editorValue(editor);
    if (
      inlineContextCandidates(current.query, currentValue.inlineContexts, localizedDefaultContexts)
        .length === 0
    ) {
      closeMention();
      return;
    }
    mentionRangeRef.current = current.range.cloneRange();
    const caretRange = current.range.cloneRange();
    caretRange.collapse(false);
    const caretRect = caretRange.getBoundingClientRect();
    const shellRect = shellRef.current?.getBoundingClientRect();
    const unclampedLeft = shellRect === undefined ? 0 : caretRect.left - shellRect.left;
    const menuWidth = Math.min(310, Math.max(0, (shellRef.current?.clientWidth ?? 310) - 8));
    const left = Math.min(
      Math.max(0, unclampedLeft),
      Math.max(0, (shellRef.current?.clientWidth ?? menuWidth) - menuWidth),
    );
    // The composer shell clips overflowing content. Keep the compact menu near the first
    // writing line so every option remains reachable even when @ is typed on a lower line.
    const top =
      shellRect === undefined
        ? 28
        : Math.min(40, Math.max(28, caretRect.bottom - shellRect.top + 7));
    setMention({ query: current.query, top, left });
    if (mention?.query !== current.query) setActiveIndex(0);
  };
  const syncEditor = (): void => {
    const editor = editorRef.current;
    if (editor !== null) enforceSourceLimit(editor);
    const nextValue = publishValue();
    if (editor !== null) updatePlaceholderVisibility(editor);
    if (
      editor !== null &&
      nextValue.text.length === 0 &&
      nextValue.inlineContexts.length === 0 &&
      editor.textContent?.replaceAll(CARET_SENTINEL, '').length === 0
    ) {
      editor.replaceChildren();
    }
    refreshMention();
  };
  const commitMention = (contextValue: string): void => {
    const editor = editorRef.current;
    const mentionRange = mentionRangeRef.current;
    const context = normalizeInlineContext(contextValue);
    const contextValidation = validateInlineTranslationContexts([...value.inlineContexts, context]);
    if (
      editor === null ||
      mentionRange === null ||
      context.length === 0 ||
      !contextValidation.success ||
      value.inlineContexts.includes(context) ||
      !rangeIsInside(mentionRange, editor)
    ) {
      closeMention();
      return;
    }

    const chip = document.createElement('span');
    chip.className = 'inline-context-chip';
    chip.contentEditable = 'false';
    chip.dataset.inlineContext = context;
    chip.setAttribute('role', 'note');
    chip.setAttribute('aria-label', t('context.chipAria', { context }));
    chip.textContent = `@[${context}]`;
    const caretNode = document.createTextNode(CARET_SENTINEL);
    mentionRange.deleteContents();
    mentionRange.insertNode(caretNode);
    mentionRange.insertNode(chip);
    placeCaretAfter(caretNode);
    closeMention();
    publishValue();
    editor.focus();
  };
  const removeAdjacentMention = (direction: 'backward' | 'forward'): boolean => {
    const editor = editorRef.current;
    if (editor === null) return false;
    const chip = adjacentMention(editor, direction);
    if (chip === null) return false;
    const marker = document.createTextNode(CARET_SENTINEL);
    const neighboringSentinel = direction === 'backward' ? chip.nextSibling : chip.previousSibling;
    if (neighboringSentinel instanceof Text) {
      neighboringSentinel.data = neighboringSentinel.data.replace(CARET_SENTINEL, '');
      if (neighboringSentinel.data.length === 0) neighboringSentinel.remove();
    }
    chip.replaceWith(marker);
    placeCaretAfter(marker);
    syncEditor();
    return true;
  };

  useEffect(() => {
    const closeOutside = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || shellRef.current?.contains(event.target) === true)
        return;
      closeMention();
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, []);

  useEffect(() => {
    for (const chip of editorRef.current?.querySelectorAll<HTMLElement>('[data-inline-context]') ??
      []) {
      const context = normalizeInlineContext(chip.dataset.inlineContext ?? '');
      const displayContext = localizedInlineContext(context, locale);
      chip.textContent = `@[${displayContext}]`;
      chip.setAttribute('aria-label', t('context.chipAria', { context: displayContext }));
    }
  }, [locale, t]);

  useEffect(() => {
    if (mention === null || candidates.length === 0) return;
    document
      .getElementById(`${optionIdPrefix}-${Math.min(activeIndex, candidates.length - 1)}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, candidates.length, mention, optionIdPrefix]);

  const activeOptionId =
    mention !== null && candidates.length > 0
      ? `${optionIdPrefix}-${Math.min(activeIndex, candidates.length - 1)}`
      : undefined;

  return (
    <div className="inline-context-editor-shell" ref={shellRef}>
      <div
        ref={editorRef}
        className={
          value.text.length === 0 && value.inlineContexts.length === 0
            ? 'inline-context-editor is-empty'
            : 'inline-context-editor'
        }
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label={label}
        aria-multiline="true"
        aria-autocomplete="list"
        aria-controls={mention === null ? undefined : listboxId}
        aria-activedescendant={activeOptionId}
        data-placeholder={placeholder}
        spellCheck
        onPointerDown={() => {
          if (mention !== null) closeMention();
        }}
        onBeforeInput={(event) => {
          const inputEvent = event.nativeEvent as InputEvent;
          // UI Automationや一部IMEはinputTypeを持たないbeforeinputを送ることがある。
          // 通常入力だけを文字数制限の先行判定に使い、欠落イベントはonInput側へ委ねる。
          if (
            typeof inputEvent.inputType !== 'string' ||
            !inputEvent.inputType.startsWith('insert') ||
            inputEvent.isComposing
          )
            return;
          const editor = editorRef.current;
          if (editor === null) return;
          const insertedCodePoints =
            inputEvent.data === null ? 1 : Array.from(inputEvent.data).length;
          if (
            Array.from(value.text).length - selectedSourceCodePoints(editor) + insertedCodePoints >
            MAX_TRANSLATION_SOURCE_CODE_POINTS
          ) {
            event.preventDefault();
          }
        }}
        onInput={() => {
          if (composingRef.current) {
            // composition中はDOMの内容をstateへ取り込むと候補文字の編集を壊すため、
            // プレースホルダーの表示状態だけを先に更新する。
            const editor = editorRef.current;
            if (editor !== null) updatePlaceholderVisibility(editor);
            return;
          }
          syncEditor();
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          syncEditor();
        }}
        onPaste={(event) => {
          event.preventDefault();
          const editor = editorRef.current;
          if (editor === null) return;
          const selectedCodePoints = selectedSourceCodePoints(editor);
          const available = Math.max(
            0,
            MAX_TRANSLATION_SOURCE_CODE_POINTS - Array.from(value.text).length + selectedCodePoints,
          );
          const pastedText = Array.from(event.clipboardData.getData('text/plain'))
            .slice(0, available)
            .join('');
          const selection = window.getSelection();
          if (selection === null || selection.rangeCount === 0 || pastedText.length === 0) return;
          const range = selection.getRangeAt(0);
          if (!rangeIsInside(range, editor)) return;
          range.deleteContents();
          const pastedNode = document.createTextNode(pastedText);
          range.insertNode(pastedNode);
          placeCaretAfter(pastedNode);
          syncEditor();
        }}
        onKeyUp={(event) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) refreshMention();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            closeMention();
            onSubmit();
            return;
          }
          if (mention !== null && candidates.length > 0) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const direction = event.key === 'ArrowDown' ? 1 : -1;
              setActiveIndex(
                (current) => (current + direction + candidates.length) % candidates.length,
              );
              return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              commitMention(candidates[Math.min(activeIndex, candidates.length - 1)]?.value ?? '');
              return;
            }
          }
          if (event.key === 'Escape' && mention !== null) {
            event.preventDefault();
            closeMention();
            return;
          }
          if (event.key === 'Backspace' && removeAdjacentMention('backward')) {
            event.preventDefault();
            return;
          }
          if (event.key === 'Delete' && removeAdjacentMention('forward')) {
            event.preventDefault();
            return;
          }
          if (event.key === 'Enter' && submitOnEnter && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {mention !== null && candidates.length > 0 && (
        <div
          className="inline-context-menu"
          id={listboxId}
          role="listbox"
          aria-label={t('context.aria')}
          style={{ top: mention.top, left: mention.left }}
        >
          <div className="inline-context-menu-header">
            <span>{t('context.add')}</span>
            <kbd>esc</kbd>
          </div>
          <div className="inline-context-options">
            {candidates.map((candidate, index) => (
              <button
                id={`${optionIdPrefix}-${index}`}
                className={index === activeIndex ? 'active' : undefined}
                key={`${candidate.custom ? 'custom' : 'default'}-${candidate.value}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commitMention(candidate.value);
                }}
              >
                <span aria-hidden="true">{candidate.custom ? '+' : '@'}</span>
                {candidate.value}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
