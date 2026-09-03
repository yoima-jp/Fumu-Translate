# Nani Windows版 技術調査

## 文書の位置付け

この文書は、Nani Windows版 1.1.0の公開情報、インストール済みパッケージ、実行状態、静的解析、制御された動的試験を基にした相互運用性調査である。

調査日は2026年8月31日である。

調査対象のMicrosoft Storeパッケージは `KiokuLLC.NaniTranslate_1.1.0.0_x64__mpzwtaxj5jyfc` である。

Naniのソースコードや固有アセットをFumu!へコピーしない。

解析結果は挙動と境界条件の理解にだけ使い、Fumu!は公開APIとOSSから独立実装する。

## 証拠区分

本文では、確度を次の三種類で示す。

- **Observed**：公開資料、パッケージ、実行プロセス、静的コード、または実機操作から直接確認した事実。
- **Inferred**：Observedの複数の事実から導いた説明であり、直接の観測ではないもの。
- **Unknown**：現環境または公開情報だけでは確認できなかったもの。

Observedには必要に応じて観測方法を付記する。

「静的」はインストール済み `app.asar` の制御フローを確認した結果を指す。

「動的」は実行中のWindowsアプリを操作またはWin32 APIで計測した結果を指す。

「公開」はNaniの公式サイトまたはMicrosoft Storeの記述を指す。

## 結論

Nani Windows版 1.1.0はElectronアプリであり、選択テキスト取得にWindows UI Automationを使っていない。

外部アプリの選択取得は、ElectronのClipboard APIで既存テキストを退避し、nut-jsで `Ctrl+C` を送信し、最大300msクリップボードをポーリングする方式である。

Nani自身にフォーカスがある場合だけ、レンダラー内の選択をElectronの `webContents.copy()` でコピーする。

翻訳時に表示される画面は選択範囲付近の小型Popupではない。

通常のメインウィンドウを復元してフォーカスし、100msだけ最前面化する。

したがって、Naniの現行Windows版について「Selection Rectを取得してPopupを配置している」という仮説は否定された。

Fumu!が目指す即時PopupはNaniの内部方式の複製ではなく、体験上の目的を別のOS統合で実現する必要がある。

## 調査対象の同定

### パッケージ

| 項目 | 値 | 区分 |
|---|---|---|
| Package name | `KiokuLLC.NaniTranslate` | Observed（Appx） |
| Version | `1.1.0.0` | Observed（Appx） |
| Architecture | x64 | Observed（Appx） |
| Publisher display name | Kioku LLC | Observed（Appx） |
| Minimum Windows version | 10.0.19041.0 | Observed（manifest） |
| Store product ID | `9NTRHF51WGGB` | Observed（manifest、Store） |
| Executable | `app\Nani.exe` | Observed（manifest） |
| Entry point | `Windows.FullTrustApplication` | Observed（manifest） |
| Capability | `runFullTrust` | Observed（manifest） |

実行ファイルのサイズは232,690,176 bytesである。

実行ファイルのSHA-256は `CABA1E52A073A4C49A53879B58F88F775FC129C6EE5085B780D71E4026DF5638` である。

`app.asar` のサイズは41,646,151 bytesである。

`app.asar` のSHA-256は `7F7A148AE57658A1263525791C6383C0ADEA3453FD21ECD03F300C9A90838DA6` である。

ハッシュは同じバージョン表記でも配布物が更新された場合に変わり得るため、この文書の観測対象を固定する識別子として扱う。

### Electron構成

**Observed（静的）**：`package.json` のアプリ名は `nani-desktop`、エントリーポイントは `./out/main/index.js` である。

**Observed（静的）**：Chromium、Electronのランタイムファイル、`resources.pak`、`snapshot_blob.bin`、`ffmpeg.dll`、`libEGL.dll`、`libGLESv2.dll` が同梱されている。

**Observed（静的）**：主なネイティブ依存は `@nut-tree-fork/nut-js 4.2.6`、`better-sqlite3 12.11.1`、`@napi-rs/system-ocr 1.0.2` である。

**Observed（静的）**：RendererはReact系の構成である。

**Observed（静的）**：通常Rendererは `contextIsolation: true`、`nodeIntegration: false` であり、preload経由でMain Processと通信する。

**Observed（静的）**：通常Rendererの `sandbox` は無効である。

### 実行プロセス

制御試験時のプロセス構成は次のとおりだった。

| 役割 | コマンドライン上の種別 | 親 |
|---|---|---|
| Electron Main Process | `Nani.exe --autostart` | 起動元 |
| GPU Process | `--type=gpu-process` | Main Process |
| Network Service | `--type=utility --utility-sub-type=network.mojom.NetworkService` | Main Process |
| Renderer Process | `--type=renderer` | Main Process |

**Observed（動的）**：Main Processが通常のメイン `BrowserWindow` を所有する。

**Observed（静的）**：選択翻訳専用の別プロセスは存在しない。

**Observed（静的）**：スクリーンショット選択時だけ、各Displayを覆う透明なCapture用 `BrowserWindow` を別に生成する。

このCapture用ウィンドウは選択テキスト翻訳のPopupではない。

## 起動と常駐

**Observed（manifest）**：`NaniTranslateStartup` というStartup Taskがあり、`Nani.exe --autostart` を実行する。

**Observed（静的）**：`--autostart` 起動時はメインウィンドウを表示せず、アプリを常駐させる。

**Observed（静的）**：Windowsでメインウィンドウを閉じる操作は通常終了ではなく、ウィンドウを隠してTray常駐を続ける。

**Observed（静的）**：セッション終了または明示的な終了操作ではプロセスを終了する。

**Observed（静的）**：Trayメニューから翻訳画面、スクリーンショット、設定、終了へ移動できる。

**Observed（静的）**：単一インスタンスロックを使う。

**Observed（manifest）**：`naniapp` URI Schemeと `naniapp.exe` App Execution Aliasを登録する。

**Observed（公開）**：`naniapp://translate?source=text` で翻訳を開始できると公式Helpに記載されている。

## グローバルショートカット

### 登録方式

**Observed（静的）**：Electron Main Processが `globalShortcut.register()` を使う。

Windows向けの既定値は次のとおりである。

| 機能 | 既定キー | 既定状態 |
|---|---|---|
| 選択テキスト翻訳 | `Ctrl+J` | 有効 |
| メインウィンドウ切替 | `Win+Ctrl+J` | 有効 |
| スクリーンショット翻訳 | `Ctrl+F8` | 未設定 |
| 選択テキスト校正 | `Ctrl+Alt+J` | 未設定 |

**Observed（静的）**：ユーザー設定はローカルKVの `user-custom-shortcuts` に保存される。

**Observed（静的）**：変更時は登録済みショートカットをいったんすべて解除し、新しい設定一式を再登録する。

**Observed（静的）**：再登録後にTrayメニューのショートカット表示を更新する。

### 競合時の挙動

**Observed（静的）**：`globalShortcut.register()` が `false` を返すと、状態を `failed` としてRendererへ返す。

**Observed（静的）**：設定UIは登録失敗を表示する。

**Observed（公開）**：公式Helpは登録できない場合に他アプリとの競合を確認し、別のキーへ変更するよう案内している。

**Inferred**：低レベルKeyboard Hookで他アプリの登録を奪う方式ではないため、競合時に強制上書きはしない。

Electron公式APIも、他アプリが既に使用しているAcceleratorの登録は `false` で静かに失敗すると定義している。

## 選択テキスト取得

### Windows実装の実際

**Observed（静的）**：Nani 1.1.0のWindows経路にはUI Automation API、MSAA、TextPattern、Caret Rect、Selection Rectを取得するコードがない。

**Observed（静的）**：外部アプリに対しては常にnut-jsで `LeftControl+C` を送る。

**Observed（静的）**：ショートカットにAlt、Shift、Windowsキーが含まれる場合は、nut-jsで該当Modifierを解放して30ms待つ。

**Observed（静的）**：nut-jsのWindows向け自動入力遅延は40msである。

**Observed（静的）**：Nani自身がフォーカス中なら、DOMの選択またはInputのSelectionを確認し、`webContents.copy()` を使う。

取得処理は次の順序である。

~~~mermaid
flowchart TD
    A[Hotkey callback] --> B[重複取得中なら終了]
    B --> C[現在のClipboard textを読む]
    C --> D{既存textが空か}
    D -- いいえ --> E[Clipboardをclear]
    D -- はい --> F[clearしない]
    E --> G{Nani自身がfocusedか}
    F --> G
    G -- はい --> H[Renderer選択をwebContents.copy]
    G -- いいえ --> I[必要なModifierを解放]
    I --> J[nut-jsでCtrl+C]
    H --> K[20ms間隔でClipboardを読む]
    J --> K
    K --> L{300ms以内に非空textか}
    L -- はい --> M[textを返す]
    L -- いいえ --> N[空文字を返す]
    M --> O{開始時textが非空か}
    N --> O
    O -- はい --> P[writeTextで開始時textを復元]
    O -- いいえ --> Q[Clipboardをそのまま残す]
~~~

### Clipboardの変更タイミング

**Observed（動的）**：Notepadでテキストを選択して `Ctrl+J` を投入した一回の制御試験では、入力開始から15.53ms後にClipboard Sequence Numberが最初に変化した。

**Observed（動的）**：同じ試験でNaniのウィンドウが可視化され、Foreground Windowになったのは125.73ms後だった。

この値は一回の試験値であり、性能分布、上限、他アプリでの値を示さない。

**Observed（動的）**：開始時Clipboardに既知の非空テキストを置いた別試験では、そのテキストが処理後に復元された。

**Observed（静的）**：開始時Clipboard textが空なら復元処理を実行しない。

したがって、その場合は選択テキストがClipboardに残る。

**Observed（静的）**：退避対象はElectronの `readText()` が返すプレーンテキストだけである。

既存Clipboardに画像、HTML、RTFなどがあっても、非空テキストが併存する場合は一度 `clear()` し、最後に `writeText()` だけで復元する。

**Inferred**：複数形式を持つClipboardでは、プレーンテキスト以外の形式が失われる可能性がある。

これはWindows Clipboardの全形式を列挙して復元する実装ではないことから導ける。

### 取得失敗

**Observed（静的）**：Clipboardを20ms間隔で読み、製品ビルドでは最大300ms待つ。

**Observed（静的）**：デバッグ状態では最大1,200ms待つ。

**Observed（静的）**：結果が空文字、または記号と句読点だけなら選択テキストとして扱わない。

**Observed（静的）**：選択を取得できない場合は翻訳入力画面を開く。

**Observed（静的）**：「現在のClipboard内容を翻訳元として採用する」という追加Fallbackはない。

**Observed（静的）**：取得中フラグにより同時実行を一件に制限する。

### アプリ別の差

Windows経路には外部アプリ名による分岐がない。

このため、アプリ別の違いは相手側が `Ctrl+C` をどう処理するかに依存する。

| 対象 | Nani内部経路 | 動的確認 | 判定 |
|---|---|---|---|
| Windows Notepad | nut-js `Ctrl+C` | 選択取得、Clipboard操作、Nani表示を確認 | Observed |
| Chrome | nut-js `Ctrl+C` | Nani自身での完了試験は未実施 | Observed（静的） / Unknown（動的） |
| Firefox | nut-js `Ctrl+C` | Nani自身での完了試験は未実施 | Observed（静的） / Unknown（動的） |
| Discord | nut-js `Ctrl+C` | 対象アプリが調査環境に未導入 | Observed（静的） / Unknown（動的） |
| VS Code | nut-js `Ctrl+C` | Nani自身での完了試験は未実施 | Observed（静的） / Unknown（動的） |
| Electronアプリ | nut-js `Ctrl+C` | アプリ種別による分岐なし | Observed（静的） / Unknown（一般化した動的保証） |
| 従来型Win32アプリ | nut-js `Ctrl+C` | 全Win32 Controlの網羅試験は未実施 | Observed（静的） / Unknown（一般化した動的保証） |

Chromeを使った追加試験は、テスト用 `data:` URLを画面操作基盤が安全に検証できず中断した。

この中断をChrome非対応の証拠として扱わない。

## ウィンドウ

### メインウィンドウ

**Observed（静的）**：既定サイズは1,240×780 DIPである。

**Observed（静的）**：最小サイズは640×580 DIPである。

**Observed（静的）**：WindowsではFrame付き、Mica背景、Menu Bar自動非表示の通常ウィンドウを作る。

**Observed（静的）**：前回の `x`、`y`、`width`、`height` を `windowBounds` として保存する。

**Observed（静的）**：保存位置がどのDisplayのWork Areaとも交差しない場合だけ、Primary Display中央へ補正する。

**Observed（静的）**：それ以外は前回位置を維持する。

### Hotkey時の表示

**Observed（静的）**：選択取得を `await` してからウィンドウを表示する。

**Observed（静的）**：最小化中ならRestoreし、非表示ならShowし、続いてFocusする。

**Observed（静的）**：Windowsでは `setAlwaysOnTop(true, "screen-saver")` で一時的に前面化し、100ms後に `false` へ戻す。

**Observed（動的）**：表示後のウィンドウはTopmostではなかった。

**Observed（動的）**：Hotkey時に元アプリからNaniへForeground Windowが移った。

### Win32属性

実行中ウィンドウの制御試験結果は次のとおりである。

| 属性 | 値 | 区分 |
|---|---|---|
| Window Class | `Chrome_WidgetWin_1` | Observed（動的） |
| Style | `0x16CF0000` | Observed（動的） |
| Extended Style | `0x00200100` | Observed（動的） |
| Owner HWND | `0x0` | Observed（動的） |
| Caption | あり | Observed（動的） |
| Thick Frame | あり | Observed（動的） |
| System Menu | あり | Observed（動的） |
| `WS_POPUP` | なし | Observed（動的） |
| `WS_EX_TOOLWINDOW` | なし | Observed（動的） |
| `WS_EX_NOACTIVATE` | なし | Observed（動的） |
| `WS_EX_TOPMOST` | なし（100ms経過後） | Observed（動的） |
| DPI | 96 | Observed（動的、試験Display） |

**Inferred**：通常の非OwnerウィンドウでTool Windowではないため、Windowsの通常規則ではTaskbarとAlt+Tabに現れる。

TaskbarとAlt+Tabの列挙を自動取得した証拠はないため、この点はWindow Styleからの推論として扱う。

### 閉じ方

**Observed（動的）**：外側のNotepadへフォーカスを移してもNaniは閉じなかった。

**Observed（動的）**：Escで表示中のModalは閉じたが、続くEscでメインウィンドウは閉じなかった。

**Observed（静的）**：メインウィンドウのEsc Handlerはアプリ内検索UIの終了に使われる。

**Observed（静的）**：WindowsのメインウィンドウにBlur時の自動Hideはない。

### Popup位置

**Observed（静的）**：選択範囲のRectを取得しない。

**Observed（静的）**：Caret位置を取得しない。

**Observed（静的）**：Mouse Cursor位置を翻訳画面の配置に使わない。

**Observed（静的）**：Active Window位置を翻訳画面の配置に使わない。

**Observed（静的）**：表示位置は保存済みメインウィンドウ位置であり、画面外に完全に外れた場合だけPrimary Display中央へ戻す。

### マルチモニターとDPI

**Observed（静的）**：保存済みBoundsが一つでもDisplay Work Areaと交差すれば、その位置を維持する。

**Observed（静的）**：ElectronのScreen APIとBrowserWindow Boundsを使う。

**Inferred**：DPI Scalingの基礎処理はElectronのDIP座標系に委ねている。

異なるScale FactorのDisplay間で翻訳画面を移動する専用補正コードは確認できなかった。

## 表示速度

### Windowsアプリ

制御試験の計測点は次のとおりである。

| イベント | Hotkey投入からの時間 |
|---|---:|
| Clipboard Sequence Numberの最初の変化 | 15.53ms |
| NaniウィンドウがVisible | 125.73ms |
| NaniウィンドウがForeground | 125.73ms |

この計測はNotepad、DPI 96、一回の試行、既に常駐しているNani 1.1.0という条件で行った。

翻訳APIの無料利用上限に達していたため、WindowsアプリのLoading表示、最初の翻訳文字、翻訳完了までは計測できなかった。

これらの値はUnknownである。

### Web版の補助計測

Web版で匿名の一回の翻訳を実行した補助計測では、実行操作から最初の状態表示まで約1,687ms、最初の翻訳文字まで約2,344ms、主要結果完了まで約2,625msだった。

語彙などの追加情報は約5,232msまで更新された。

Web版はWindowsデスクトップ版と実行経路が異なる。

この値をWindows版の性能値として使わない。

### UIとリクエストの順序

**Observed（静的）**：Main Processは選択取得完了後にメインウィンドウを表示し、Rendererへ翻訳Actionを送る。

**Observed（静的）**：Rendererは新しい翻訳SessionのStreaming Requestを開始し、その後Routeを確定する先行取得構造を持つ。

したがって、翻訳完了を待ってウィンドウを表示するわけではない。

一方、選択取得の完了はウィンドウ表示より先である。

## 翻訳リクエストの状態管理

**Observed（静的）**：Sessionごとに `AbortController` を一つ保持する。

**Observed（静的）**：同じSessionで新しいRequestを開始すると、以前のControllerをAbortする。

**Observed（静的）**：Sessionごとに増加するStream IDを持ち、古いStream IDから届いたChunk、完了、Errorを無視する。

**Observed（静的）**：状態は少なくとも `submitted`、`streaming`、`ready`、`error`、`aborted` を区別する。

**Observed（静的）**：最初のText Chunkは直ちにStateへ反映し、後続更新は通知をまとめる。

**Observed（静的）**：予期しないStream終端をErrorとして扱う。

**Observed（静的）**：Stop、Stop All、Retryを実装する。

**Observed（静的）**：同時に保持するSession数へ上限を設け、Streaming中のSessionはEvictionしない。

**Inferred**：Stream IDとAbortを併用するため、Abortが間に合わず古いChunkが到着しても最新表示を上書きしない。

## 翻訳レスポンスの構造

**Observed（静的）**：Nani 1.1.0のServer ResponseはStreaming JSONではなく、独自Markupを含むText Streamである。

**Observed（静的）**：Rendererは生成途中の不完全Markupを許容して逐次Parseし、完了後に厳密Parseする。

**Observed（静的）**：表示NodeにはPlain TextとTranslationがある。

**Observed（静的）**：TranslationはResult、Language、Tone、Note、発音補助、Examplesを持てる。

**Observed（静的）**：Toneは少なくともCasualとPoliteを区別する。

**Observed（静的）**：複数のTranslation Nodeを代替表現として表示できる。

Fumu!はこの独自Markupを実装しない。

Koreが公開しているTranslation、Explanation、Alternatives、AlternativeごとのNuanceというJSON構造を基に、独立したStreaming JSON Schemaを使う。

## UX機能

### 直接確認した構成

**Observed（動的）**：デスクトップ画面は左側の履歴領域と右側の翻訳作業領域を持つ。

**Observed（動的）**：翻訳元入力、翻訳先言語、文体調整、Context追加、添付、実行操作がある。

**Observed（動的）**：Dark Themeを確認した。

**Observed（公開）**：公式Helpは翻訳、複数表現、文脈説明、返信作成、校正、画像翻訳、デスクトップのスクリーンショット翻訳、音声再生を案内している。

**Observed（公開）**：デスクトップ履歴は端末内へ保存される。

### 結果表示

**Observed（静的）**：原文と主要翻訳を表示する。

**Observed（静的）**：主要翻訳をClipboardへCopyできる。

**Observed（静的）**：Translation Noteを説明またはNuanceとして表示する。

**Observed（静的）**：複数のTranslation Nodeを別表現として表示する。

**Observed（静的）**：発音補助としてRomaji、Kana、Pinyin、IPAなどを扱う。

**Observed（静的）**：用例、語彙、文法情報を追加表示できる。

### 変換操作

静的に確認できた操作群には次の意図が含まれる。

- Casual化とPolite化。
- 短縮と詳細化。
- Nativeらしい表現への調整。
- 乾いた文体と感情を引く文体の切替。
- 読みやすさの調整。
- AI生成らしさの低減。
- 別表現の生成。
- 原文の改善。

UIの固有文言、アイコン配置、キャラクター表現はFumu!へコピーしない。

Fumu!では機能の意図だけを、短い独自ラベルと異なるVisual Designで実装する。

### 戻し訳

**Observed（静的）**：戻し訳は `/api/ai/back-translate` への別Streaming Requestで生成する。

**Observed（静的）**：最初から自動生成せず、ユーザー操作時に遅延実行する。

**Observed（静的）**：失敗時にRetryできる。

### Follow-up

**Observed（静的）**：定型Follow-upと自由入力Follow-upを持つ。

**Observed（静的）**：翻訳全体だけでなく、選択した部分を対象に質問できる。

**Observed（静的）**：対象翻訳の抜粋とSection IDをRequest Contextへ含める。

**Observed（静的）**：返信作成は親子関係を持つ別Sessionとして履歴へ保存できる。

## 履歴と設定

### ローカルDB

**Observed（静的）**：`better-sqlite3` とDrizzle ORMを使う。

**Observed（動的）**：Store Packageの仮想化されたUser Data領域にSQLite DBが存在する。

確認した主要Tableは次のとおりである。

- `localkv`。
- `basic_translate`。
- `basic_translate_message`。
- `proofread_session`。
- `proofread_message`。

Translation Sessionは原文、言語、表示用抜粋、Metadata、Model、履歴時刻、親子関係、Context、Custom Styleなどを保持できる。

MessageはRole、Content、会話対象かどうか、作成時刻、Session外部キーを持つ。

**Observed（静的）**：履歴の保存期間を設定できる。

**Observed（公開）**：公式Helpは翻訳データを端末内へ保存し、NaniのServerには履歴として保存しないと説明している。

### 認証情報

**Observed（静的）**：Access Tokenの暗号化にAES-256-CTRを使う。

**Observed（静的）**：鍵材料はUser Data Path由来の固定情報から導出する。

この方式をFumu!へ採用しない。

Fumu!ではElectron `safeStorage` の同期APIを使い、WindowsではDPAPIに委ねる。

### Network

**Observed（静的）**：主要接続先は `nani.now` と `nani.kiok.jp` である。

**Observed（公開）**：公式Helpは翻訳と不正利用検出のため、入力をGoogle、OpenAI、xAIへ送る場合があると説明している。

**Observed（公開）**：Naniは外部向けPublic APIを提供していない。

Fumu!はNaniのEndpointへ接続しない。

ユーザーが設定したProvider APIまたはローカルAgentだけへ接続する。

## 未確認事項

次の項目はUnknownのまま残す。

- Windows版で最初の翻訳Tokenが表示されるまでの時間分布。
- Windows版で翻訳が完了するまでの時間分布。
- Chrome、Firefox、Discord、VS Codeそれぞれに対するNani 1.1.0の動的成功率。
- Elevated Processを対象にした選択取得の挙動。
- Remote Desktop、IME変換中、Password Control、Terminal特殊選択での挙動。
- 異なるDPIを持つ複数Display間での全操作試験。
- Alt+TabとTaskbarへの表示をShell列挙で直接確認した結果。
- Nani Server側のPrompt、Model Routing、Abuse Detectionの内部実装。

Unknownを推測でFumu!の仕様へ置き換えない。

Fumu!側はこれらを個別のCompatibility Testとして扱う。

## Fumu!へ反映する設計判断

Naniの短いHotkey体験は参考にするが、次の内部方式は継承しない。

| Nani 1.1.0 | Fumu! |
|---|---|
| 外部アプリは常にCtrl+C | UIA、IAccessible、安全に退避可能な場合だけ使うClipboard Fallback |
| 選択取得後に通常ウィンドウを表示 | 非アクティブPopupを先に表示 |
| 元アプリからFocusを奪う | 取得完了までは元アプリのFocusを維持 |
| 保存済みメインウィンドウ位置 | Selection Rect、Caret、Cursor、Screen Center |
| ClipboardのTextだけ復元 | Private／非HGLOBAL Formatがあれば変更前にFallbackを中止 |
| 主要画面とHotkey表示が同じWindow | Main WindowとPopup Windowを分離 |
| 独自Streaming Markup | Provider非依存のStreaming JSON |
| Nani Server固定 | ユーザー所有APIとローカルAgent |

## 再現可能性

静的調査では、Store Packageの `app.asar` を一時領域へ展開し、Main BundleとRenderer Bundleを整形して検索した。

展開物と整形物はFumu!リポジトリへ保存しない。

動的調査では、Win32 APIでWindow Style、Extended Style、Owner、Bounds、DPI、Visibility、Foreground Window、Clipboard Sequence Numberを取得した。

ユーザーの翻訳本文、Access Token、Cookie、API応答本文は収集していない。

ローカルDBはSchemaと保存場所の確認に限定し、既存履歴の内容を調査資料へ転記していない。

## 参照資料

- [Nani Help Center](https://nani.now/en/help)
- [Nani Desktop Download](https://nani.now/en/download)
- [Nani Microsoft Store page](https://apps.microsoft.com/detail/9ntrhf51wggb)
- [Electron globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut/)
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window/)
- [Electron screen](https://www.electronjs.org/docs/latest/api/screen/)
- [selection-hook](https://github.com/0xfullex/selection-hook)
- [Kore translation](https://github.com/fa0311/kore-translation)
