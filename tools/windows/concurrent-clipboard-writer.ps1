param(
  [Parameter(Mandatory = $true)]
  [string]$Value,
  [ValidateRange(100, 10000)]
  [int]$TimeoutMs = 5000
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class FumuConcurrentClipboardWriter
{
    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;

    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint format, IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")]
    private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalFree(IntPtr memory);

    public static uint Sequence() { return GetClipboardSequenceNumber(); }

    public static void Write(string value)
    {
        byte[] bytes = Encoding.Unicode.GetBytes(value + "\0");
        IntPtr memory = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes.Length);
        if (memory == IntPtr.Zero) throw new InvalidOperationException("GlobalAlloc failed.");
        bool transferred = false;
        try
        {
            IntPtr pointer = GlobalLock(memory);
            if (pointer == IntPtr.Zero) throw new InvalidOperationException("GlobalLock failed.");
            try { Marshal.Copy(bytes, 0, pointer, bytes.Length); }
            finally { GlobalUnlock(memory); }

            for (int attempt = 0; attempt < 200; attempt++)
            {
                if (OpenClipboard(IntPtr.Zero))
                {
                    try
                    {
                        if (!EmptyClipboard()) throw new InvalidOperationException("EmptyClipboard failed.");
                        if (SetClipboardData(CF_UNICODETEXT, memory) == IntPtr.Zero)
                            throw new InvalidOperationException("SetClipboardData failed.");
                        transferred = true;
                    }
                    finally { CloseClipboard(); }
                    return;
                }
                Thread.Sleep(1);
            }
            throw new InvalidOperationException("Clipboard remained locked.");
        }
        finally
        {
            if (!transferred) GlobalFree(memory);
        }
    }
}
'@

$initialSequence = [FumuConcurrentClipboardWriter]::Sequence()
Write-Output 'clipboard-writer-ready'
[Console]::Out.Flush()
$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
while ([DateTime]::UtcNow -lt $deadline) {
  if ([FumuConcurrentClipboardWriter]::Sequence() -ne $initialSequence) {
    [FumuConcurrentClipboardWriter]::Write($Value)
    Write-Output 'clipboard-writer-complete'
    exit 0
  }
  [Threading.Thread]::Sleep(1)
}
throw 'Timed out waiting for Fumu Clipboard transaction.'
