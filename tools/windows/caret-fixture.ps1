param(
  [string]$WindowTitle = 'Fumu Caret Fixture',
  [string]$Text = 'The popup should anchor next to this standard Win32 caret.',
  [ValidateRange(0, 250000)]
  [int]$GeneratedTextLength = 0,
  [switch]$SelectAll,
  [switch]$LargeText,
  [switch]$FocusContainer,
  [switch]$CopyOnly,
  [switch]$ObjectSelection
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new()

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if ($CopyOnly) {
  # TextPatternがないアプリを再現する。Documentロールはコピー取得を許可し、
  # ListItemロールは実際のオブジェクト選択としてコピー注入を防ぐ必要がある。
  Add-Type -ReferencedAssemblies @(
    [System.Windows.Forms.Control].Assembly.Location,
    [System.Windows.Forms.AccessibleRole].Assembly.Location,
    [System.Drawing.Size].Assembly.Location,
    [System.Drawing.Font].Assembly.Location,
    [System.ComponentModel.Component].Assembly.Location
  ) -TypeDefinition @'
using System;
using System.Windows.Forms;
public class CopySelectionFixture : Control {
  public string SelectedText { get; set; }
  public bool ObjectSelection { get; set; }
  public CopySelectionFixture() {
    SetStyle(ControlStyles.Selectable, true);
    TabStop = true;
    Cursor = Cursors.IBeam;
  }
  protected override AccessibleObject CreateAccessibilityInstance() { return new SelectionObject(this); }
  protected override void OnKeyDown(KeyEventArgs e) {
    if (e.Control && (e.KeyCode == Keys.C || e.KeyCode == Keys.Insert)) {
      Clipboard.SetText(SelectedText);
      e.Handled = true;
    }
    base.OnKeyDown(e);
  }
  class SelectionObject : ControlAccessibleObject {
    readonly CopySelectionFixture owner;
    public SelectionObject(CopySelectionFixture control) : base(control) { owner = control; }
    public override AccessibleRole Role { get { return owner.ObjectSelection ? AccessibleRole.ListItem : AccessibleRole.Document; } }
    public override AccessibleObject GetSelected() { return this; }
  }
}
'@
}

# 大きなUIA選択の回帰試験では、Windowsのコマンドライン上限を越える本文を
# 引数で渡せないためFixture内で生成する。通常の目視試験ではTextをそのまま使う。
if ($GeneratedTextLength -gt 0) {
  $Text = 'X' * $GeneratedTextLength
}

$form = [System.Windows.Forms.Form]::new()
$form.Text = "$WindowTitle (starting)"
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.ClientSize = [System.Drawing.Size]::new(640, 280)

$textBox = [System.Windows.Forms.TextBox]::new()
$textBox.Multiline = $true
$textBox.MaxLength = [int]::MaxValue
$textBox.Font = [System.Drawing.Font]::new('Segoe UI', 16)
if ($LargeText) {
  # 旧取得処理が座標を拒否する100px以上の行高でも、選択文字は取得できる。
  $textBox.Font = [System.Drawing.Font]::new('Segoe UI', 100)
}
$textBox.HideSelection = $false
$textBox.Text = $Text
$textBox.Location = [System.Drawing.Point]::new(32, 42)
$textBox.Size = [System.Drawing.Size]::new(576, 160)

if ($CopyOnly) {
  $copyControl = [CopySelectionFixture]::new()
  $copyControl.SelectedText = $Text
  $copyControl.ObjectSelection = $ObjectSelection.IsPresent
  $copyControl.Bounds = $textBox.Bounds
  $form.Controls.Add($copyControl)
} else {
  $form.Controls.Add($textBox)
}
if ($FocusContainer) {
  $button = [System.Windows.Forms.Button]::new()
  $button.Text = 'Focus fixture'
  $button.Location = [System.Drawing.Point]::new(32, 220)
  $form.Controls.Add($button)
}
$form.Add_Shown({
  $textBox.Focus()
  if ($SelectAll) {
    $textBox.SelectAll()
  }
  else {
    $textBox.SelectionStart = $textBox.TextLength
    $textBox.SelectionLength = 0
  }
  if ($FocusContainer) {
    # Shown後に生成するとUIAのフォーカス通知がreadiness signalより遅れる。
    # 先に作った兄弟ButtonをActiveControlにしてからE2Eへ公開する。
    $form.ActiveControl = $button
    $button.Select()
  }
  if ($CopyOnly) { $copyControl.Focus() }
  # E2Eは完全一致のWindowTitleをreadiness signalとして待つ。Handle生成直後に
  # Hotkeyを送るとShown/SelectAllより先行し、選択なしを観測するためである。
  $form.Text = $WindowTitle
})

[System.Windows.Forms.Application]::Run($form)
