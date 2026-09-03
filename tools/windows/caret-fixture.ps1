param(
  [string]$WindowTitle = 'Fumu Caret Fixture',
  [string]$Text = 'The popup should anchor next to this standard Win32 caret.',
  [ValidateRange(0, 250000)]
  [int]$GeneratedTextLength = 0,
  [switch]$SelectAll
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

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
$textBox.Text = $Text
$textBox.Location = [System.Drawing.Point]::new(32, 42)
$textBox.Size = [System.Drawing.Size]::new(576, 160)

$form.Controls.Add($textBox)
$form.Add_Shown({
  $textBox.Focus()
  if ($SelectAll) {
    $textBox.SelectAll()
  }
  else {
    $textBox.SelectionStart = $textBox.TextLength
    $textBox.SelectionLength = 0
  }
  # E2Eは完全一致のWindowTitleをreadiness signalとして待つ。Handle生成直後に
  # Hotkeyを送るとShown/SelectAllより先行し、選択なしを観測するためである。
  $form.Text = $WindowTitle
})

[System.Windows.Forms.Application]::Run($form)
