import { join } from 'node:path';
import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  MAX_CONVERSATION_CONTEXT_TEXT_CODE_POINTS,
  MAX_CONVERSATION_CONTEXT_TURNS,
  MAX_INLINE_TRANSLATION_CONTEXT_CODE_POINTS,
  MAX_INLINE_TRANSLATION_CONTEXTS,
  MAX_TRANSLATION_SOURCE_CODE_POINTS,
  TRANSLATION_ACTION_OPERATION_VALUES,
  validateInlineTranslationContexts,
} from '@fumu/translation-core';
import { MAX_CLIPBOARD_TEXT_CODE_POINTS, type AppController } from './app-controller';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import {
  generalSettingsUpdateSchema,
  fetchProviderModelsSchema,
  providerIdSchema,
  saveProviderSchema,
  shortcutSchema,
  updateUsedModelsSchema,
  writingStyleInstructionSchema,
} from './settings/profile-schema';
import { assertRendererAccess, rendererEntryUrls, type RendererKind } from './ipc-sender-policy';
import {
  MAX_APPLIED_TRANSLATION_INSTRUCTION_CODE_POINTS,
  MAX_APPLIED_TRANSLATION_INSTRUCTIONS,
  APPLIED_TRANSLATION_INSTRUCTION_KIND_VALUES,
  normalizeAppliedTranslationInstructionLabel,
} from '../shared/applied-translation-instructions-contract';

// code pointでの厳密な検証はAppControllerが行う。ここでは1文字がsurrogate pairに
// なる入力を通しつつ、IPC境界で明らかに過大なpayloadだけを拒否する。
const translationSourceTextSchema = z.string().max(MAX_TRANSLATION_SOURCE_CODE_POINTS * 2);
const clipboardTextSchema = z.string().max(MAX_CLIPBOARD_TEXT_CODE_POINTS * 2);
const conversationDirectionSchema = z.enum(['incoming', 'outgoing']).nullable();
// 会話中はProviderが検出した相手言語名を次の返信先として再利用する。
// UIの選択肢だけに絞らず、短い言語名として境界で制限する。
const targetLanguageSchema = z.string().trim().min(1).max(80).nullable().optional();
const conversationContextSchema = z
  .array(
    z
      .object({
        speaker: z.enum(['self', 'other']),
        sourceText: z.string().max(MAX_CONVERSATION_CONTEXT_TEXT_CODE_POINTS * 2),
        translatedText: z.string().max(MAX_CONVERSATION_CONTEXT_TEXT_CODE_POINTS * 2),
      })
      .strict(),
  )
  .max(MAX_CONVERSATION_CONTEXT_TURNS)
  .optional();
const conversationSessionIdSchema = z.uuid().nullable().optional();
const writingStyleSchema = writingStyleInstructionSchema.nullable().optional();
const inlineContextsSchema = z
  // These are raw-payload abuse limits only. Product limits are applied after normalization
  // by validateInlineTranslationContexts, so harmless whitespace and duplicates do not fail early.
  .array(z.string().max(MAX_INLINE_TRANSLATION_CONTEXT_CODE_POINTS * 16))
  .max(MAX_INLINE_TRANSLATION_CONTEXTS * 4)
  .transform((contexts, context) => {
    const result = validateInlineTranslationContexts(contexts);
    if (!result.success) {
      context.addIssue({ code: 'custom', message: 'Invalid inline translation context.' });
      return z.NEVER;
    }
    return result.value;
  })
  .optional();
const appliedInstructionsSchema = z
  .array(
    z
      .object({
        kind: z.enum(APPLIED_TRANSLATION_INSTRUCTION_KIND_VALUES),
        label: z.string().max(MAX_APPLIED_TRANSLATION_INSTRUCTION_CODE_POINTS * 2),
      })
      .strict(),
  )
  .max(MAX_APPLIED_TRANSLATION_INSTRUCTIONS)
  .transform((instructions) =>
    instructions.flatMap((instruction) => {
      const label = normalizeAppliedTranslationInstructionLabel(instruction.label);
      return label.length === 0 ? [] : [{ kind: instruction.kind, label }];
    }),
  )
  .optional();
const followUpSchema = z.string().max(10_000);
const writingStyleIdSchema = z.uuid();
const translationActionSchema = z.enum(TRANSLATION_ACTION_OPERATION_VALUES);
const resizeSchema = z.object({
  width: z.number().finite().positive().max(2_000),
  height: z.number().finite().positive().max(2_000),
});
const historyQuerySchema = z
  .object({
    query: z.string().max(500),
    limit: z.number().int().min(1).max(200),
  })
  .strict();
const historyIdSchema = z.uuid();

export function registerIpcHandlers(
  controller: AppController,
  rendererUrl: string | undefined,
): () => void {
  const expectedRendererUrls = rendererEntryUrls(
    rendererUrl,
    join(__dirname, '../renderer/index.html'),
  );

  const assertTrustedSender = (
    event: IpcMainInvokeEvent,
    allowedKinds: readonly RendererKind[],
  ): RendererKind => {
    const frame = event.senderFrame;
    return assertRendererAccess(
      frame?.url ?? '',
      frame !== null && frame === event.sender.mainFrame,
      expectedRendererUrls,
      allowedKinds,
    );
  };

  const mainOnly = (event: IpcMainInvokeEvent): RendererKind =>
    assertTrustedSender(event, ['main']);
  const popupOnly = (event: IpcMainInvokeEvent): RendererKind =>
    assertTrustedSender(event, ['popup']);
  const eitherWindow = (event: IpcMainInvokeEvent): RendererKind =>
    assertTrustedSender(event, ['main', 'popup']);

  ipcMain.handle(IPC_CHANNELS.appGetStatus, (event) => {
    mainOnly(event);
    return controller.status;
  });

  ipcMain.handle(IPC_CHANNELS.appTriggerClipboard, async (event) => {
    eitherWindow(event);
    await controller.triggerClipboard();
  });

  ipcMain.handle(IPC_CHANNELS.appOpenLanguageSettings, async (event) => {
    eitherWindow(event);
    await shell.openExternal('ms-settings:regionlanguage');
  });

  ipcMain.handle(IPC_CHANNELS.appRestart, (event) => {
    eitherWindow(event);
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle(
    IPC_CHANNELS.appTranslateText,
    (
      event,
      input: unknown,
      direction: unknown,
      writingStyle: unknown,
      inlineContexts: unknown,
      appliedInstructions: unknown,
      targetLanguage: unknown,
      conversationContext: unknown,
      conversationSessionId: unknown,
    ) => {
      mainOnly(event);
      controller.translateTextInMain(
        translationSourceTextSchema.parse(input),
        conversationDirectionSchema.parse(direction),
        writingStyleSchema.parse(writingStyle) ?? null,
        inlineContextsSchema.parse(inlineContexts) ?? [],
        appliedInstructionsSchema.parse(appliedInstructions) ?? [],
        targetLanguageSchema.parse(targetLanguage) ?? null,
        conversationContextSchema.parse(conversationContext) ?? [],
        conversationSessionIdSchema.parse(conversationSessionId) ?? null,
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.popupClose, (event) => {
    popupOnly(event);
    controller.closePopup();
  });

  ipcMain.handle(IPC_CHANNELS.popupCopy, async (event, input: unknown) => {
    eitherWindow(event);
    await controller.copyText(clipboardTextSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.popupUseManual, (event, input: unknown) => {
    popupOnly(event);
    controller.useManualText(translationSourceTextSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.popupRetryTranslation, async (event) => {
    await controller.retryTranslation(eitherWindow(event));
  });

  ipcMain.handle(
    IPC_CHANNELS.popupApplyTranslationAction,
    async (event, input: unknown, baseTranslation: unknown) => {
      await controller.applyTranslationAction(
        translationActionSchema.parse(input),
        eitherWindow(event),
        translationSourceTextSchema.optional().parse(baseTranslation),
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.popupApplyWritingStyle,
    async (event, input: unknown, baseTranslation: unknown) => {
      await controller.applyWritingStyle(
        writingStyleIdSchema.parse(input),
        eitherWindow(event),
        translationSourceTextSchema.optional().parse(baseTranslation),
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.popupSendFollowUp, async (event, input: unknown) => {
    await controller.sendFollowUp(followUpSchema.parse(input), eitherWindow(event));
  });

  ipcMain.handle(IPC_CHANNELS.popupRetryFollowUp, async (event) => {
    await controller.retryFollowUp(eitherWindow(event));
  });

  ipcMain.handle(IPC_CHANNELS.popupResize, (event, input: unknown) => {
    popupOnly(event);
    controller.resizePopup(resizeSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    // Popupもメインと同じ外見設定を描画するため、信頼済みRendererには読み取りだけ許可する。
    // ショートカットやプロバイダー等の更新IPCは引き続きmainOnlyのままにする。
    eitherWindow(event);
    return controller.settings;
  });

  ipcMain.handle(IPC_CHANNELS.settingsBeginShortcutCapture, (event) => {
    mainOnly(event);
    controller.beginShortcutCapture();
  });

  ipcMain.handle(IPC_CHANNELS.settingsEndShortcutCapture, (event) => {
    mainOnly(event);
    controller.endShortcutCapture();
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdateShortcut, (event, input: unknown) => {
    mainOnly(event);
    return controller.updateShortcut(shortcutSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdateGeneral, (event, input: unknown) => {
    mainOnly(event);
    return controller.updateGeneralSettings(generalSettingsUpdateSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.settingsFetchProviderModels, (event, input: unknown) => {
    mainOnly(event);
    return controller.fetchProviderModels(fetchProviderModelsSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.settingsLoginChatGpt, (event, input: unknown) => {
    mainOnly(event);
    return controller.loginChatGpt(providerIdSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.settingsSaveProvider, (event, input: unknown) => {
    mainOnly(event);
    return controller.saveProvider(saveProviderSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.settingsDeleteProvider, (event, input: unknown) => {
    mainOnly(event);
    return controller.deleteProvider(providerIdSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdateUsedModels, (event, input: unknown) => {
    mainOnly(event);
    return controller.updateUsedModels(updateUsedModelsSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.historyList, (event, input: unknown) => {
    mainOnly(event);
    return controller.listHistory(historyQuerySchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.historyGet, (event, input: unknown) => {
    mainOnly(event);
    return controller.getHistoryDetail(historyIdSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.historyDelete, (event, input: unknown) => {
    mainOnly(event);
    controller.deleteHistory(historyIdSchema.parse(input));
  });

  ipcMain.handle(IPC_CHANNELS.historyClear, (event) => {
    mainOnly(event);
    controller.clearHistory();
  });

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.appGetStatus);
    ipcMain.removeHandler(IPC_CHANNELS.appTriggerClipboard);
    ipcMain.removeHandler(IPC_CHANNELS.appRestart);
    ipcMain.removeHandler(IPC_CHANNELS.appOpenLanguageSettings);
    ipcMain.removeHandler(IPC_CHANNELS.appTranslateText);
    ipcMain.removeHandler(IPC_CHANNELS.popupClose);
    ipcMain.removeHandler(IPC_CHANNELS.popupCopy);
    ipcMain.removeHandler(IPC_CHANNELS.popupUseManual);
    ipcMain.removeHandler(IPC_CHANNELS.popupRetryTranslation);
    ipcMain.removeHandler(IPC_CHANNELS.popupApplyTranslationAction);
    ipcMain.removeHandler(IPC_CHANNELS.popupApplyWritingStyle);
    ipcMain.removeHandler(IPC_CHANNELS.popupSendFollowUp);
    ipcMain.removeHandler(IPC_CHANNELS.popupRetryFollowUp);
    ipcMain.removeHandler(IPC_CHANNELS.popupResize);
    ipcMain.removeHandler(IPC_CHANNELS.settingsGet);
    ipcMain.removeHandler(IPC_CHANNELS.settingsBeginShortcutCapture);
    ipcMain.removeHandler(IPC_CHANNELS.settingsEndShortcutCapture);
    ipcMain.removeHandler(IPC_CHANNELS.settingsUpdateShortcut);
    ipcMain.removeHandler(IPC_CHANNELS.settingsUpdateGeneral);
    ipcMain.removeHandler(IPC_CHANNELS.settingsFetchProviderModels);
    ipcMain.removeHandler(IPC_CHANNELS.settingsLoginChatGpt);
    ipcMain.removeHandler(IPC_CHANNELS.settingsSaveProvider);
    ipcMain.removeHandler(IPC_CHANNELS.settingsDeleteProvider);
    ipcMain.removeHandler(IPC_CHANNELS.settingsUpdateUsedModels);
    ipcMain.removeHandler(IPC_CHANNELS.historyList);
    ipcMain.removeHandler(IPC_CHANNELS.historyGet);
    ipcMain.removeHandler(IPC_CHANNELS.historyDelete);
    ipcMain.removeHandler(IPC_CHANNELS.historyClear);
  };
}
