param(
  [ValidateSet('Set', 'Check', 'SetText', 'CheckText', 'SetMalformedUnicode', 'SetOversizedUnicode', 'Clear')]
  [string]$Mode,
  [string]$Value = 'fumu-private-clipboard'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class FumuPrivateClipboardFixture
{
    private const uint CF_PRIVATEFIRST = 0x0200;
    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint format, IntPtr memory);
    [DllImport("user32.dll")]
    private static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")]
    private static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")]
    private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")]
    private static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalFree(IntPtr memory);

    private static void WithClipboard(Action action)
    {
        for (int attempt = 0; attempt < 20; attempt++)
        {
            if (OpenClipboard(IntPtr.Zero))
            {
                try { action(); }
                finally { CloseClipboard(); }
                return;
            }
            Thread.Sleep(25);
        }
        throw new InvalidOperationException("Clipboard could not be opened.");
    }

    public static void Set(string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value + "\0");
        IntPtr memory = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes.Length);
        if (memory == IntPtr.Zero) throw new InvalidOperationException("GlobalAlloc failed.");
        bool transferred = false;
        try
        {
            IntPtr pointer = GlobalLock(memory);
            if (pointer == IntPtr.Zero) throw new InvalidOperationException("GlobalLock failed.");
            try { Marshal.Copy(bytes, 0, pointer, bytes.Length); }
            finally { GlobalUnlock(memory); }

            WithClipboard(() =>
            {
                if (!EmptyClipboard()) throw new InvalidOperationException("EmptyClipboard failed.");
                if (SetClipboardData(CF_PRIVATEFIRST, memory) == IntPtr.Zero)
                    throw new InvalidOperationException("SetClipboardData failed.");
                transferred = true;
            });
        }
        finally
        {
            if (!transferred) GlobalFree(memory);
        }
    }

    public static bool Check(string expected)
    {
        bool matches = false;
        WithClipboard(() =>
        {
            if (!IsClipboardFormatAvailable(CF_PRIVATEFIRST)) return;
            IntPtr memory = GetClipboardData(CF_PRIVATEFIRST);
            UIntPtr sizeValue = memory == IntPtr.Zero ? UIntPtr.Zero : GlobalSize(memory);
            ulong size64 = sizeValue.ToUInt64();
            if (size64 == 0 || size64 > 65536) return;
            int size = (int)size64;
            IntPtr pointer = GlobalLock(memory);
            if (pointer == IntPtr.Zero) return;
            try
            {
                byte[] bytes = new byte[size];
                Marshal.Copy(pointer, bytes, 0, size);
                string value = Encoding.UTF8.GetString(bytes).TrimEnd('\0');
                matches = value == expected;
            }
            finally { GlobalUnlock(memory); }
        });
        return matches;
    }

    public static void SetText(string value)
    {
        SetStandardClipboardBytes(Encoding.Unicode.GetBytes(value + "\0"));
    }

    public static bool CheckText(string expected)
    {
        bool matches = false;
        WithClipboard(() =>
        {
            IntPtr memory = GetClipboardData(CF_UNICODETEXT);
            ulong size64 = memory == IntPtr.Zero ? 0 : GlobalSize(memory).ToUInt64();
            if (size64 < 2 || size64 > 1024 * 1024 || size64 > Int32.MaxValue) return;
            IntPtr pointer = GlobalLock(memory);
            if (pointer == IntPtr.Zero) return;
            try
            {
                int charCount = (int)(size64 / 2);
                string value = Marshal.PtrToStringUni(pointer, charCount) ?? String.Empty;
                matches = value.TrimEnd('\0') == expected;
            }
            finally { GlobalUnlock(memory); }
        });
        return matches;
    }

    private static void SetStandardClipboardBytes(byte[] bytes, bool fillEntireAllocation = false)
    {
        IntPtr memory = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes.Length);
        if (memory == IntPtr.Zero) throw new InvalidOperationException("GlobalAlloc failed.");
        bool transferred = false;
        try
        {
            IntPtr pointer = GlobalLock(memory);
            if (pointer == IntPtr.Zero) throw new InvalidOperationException("GlobalLock failed.");
            try
            {
                if (fillEntireAllocation)
                {
                    ulong allocationSize64 = GlobalSize(memory).ToUInt64();
                    if (allocationSize64 == 0 || allocationSize64 > Int32.MaxValue)
                        throw new InvalidOperationException("Unexpected GlobalAlloc size.");
                    byte[] allocation = new byte[(int)allocationSize64];
                    Array.Fill(allocation, (byte)0x41);
                    Marshal.Copy(allocation, 0, pointer, allocation.Length);
                }
                else
                {
                    Marshal.Copy(bytes, 0, pointer, bytes.Length);
                }
            }
            finally { GlobalUnlock(memory); }

            WithClipboard(() =>
            {
                if (!EmptyClipboard()) throw new InvalidOperationException("EmptyClipboard failed.");
                if (SetClipboardData(CF_UNICODETEXT, memory) == IntPtr.Zero)
                    throw new InvalidOperationException("SetClipboardData failed.");
                transferred = true;
            });
        }
        finally
        {
            // Standard Clipboard handles transfer to Windows after SetClipboardData.
            if (!transferred) GlobalFree(memory);
        }
    }

    public static void SetMalformedUnicode()
    {
        byte[] bytes = new byte[128];
        Array.Fill(bytes, (byte)0x41); // No UTF-16 NUL exists within the HGLOBAL.
        // GlobalAlloc may round the allocation up; fill that padding too so the test
        // cannot pass merely because an implementation reads beyond the requested bytes.
        SetStandardClipboardBytes(bytes, true);
    }

    public static void SetOversizedUnicode()
    {
        byte[] bytes = new byte[1024 * 1024 + 2];
        Array.Fill(bytes, (byte)0x41);
        bytes[bytes.Length - 2] = 0;
        bytes[bytes.Length - 1] = 0;
        SetStandardClipboardBytes(bytes);
    }

    public static void Clear()
    {
        IntPtr privateMemory = IntPtr.Zero;
        WithClipboard(() =>
        {
            if (IsClipboardFormatAvailable(CF_PRIVATEFIRST))
                privateMemory = GetClipboardData(CF_PRIVATEFIRST);
            EmptyClipboard();
        });
        // Windows deliberately does not free CF_PRIVATEFIRST..CF_PRIVATELAST.
        if (privateMemory != IntPtr.Zero) GlobalFree(privateMemory);
    }
}
'@

switch ($Mode) {
  'Set' {
    [FumuPrivateClipboardFixture]::Set($Value)
    Write-Output 'private-clipboard-set'
  }
  'Check' {
    if (-not [FumuPrivateClipboardFixture]::Check($Value)) {
      throw 'Private clipboard payload was not preserved.'
    }
    Write-Output 'private-clipboard-preserved'
  }
  'SetText' {
    [FumuPrivateClipboardFixture]::SetText($Value)
    Write-Output 'text-clipboard-set'
  }
  'CheckText' {
    if (-not [FumuPrivateClipboardFixture]::CheckText($Value)) {
      throw 'Text clipboard payload was not preserved.'
    }
    Write-Output 'text-clipboard-preserved'
  }
  'SetMalformedUnicode' {
    [FumuPrivateClipboardFixture]::SetMalformedUnicode()
    Write-Output 'malformed-unicode-clipboard-set'
  }
  'SetOversizedUnicode' {
    [FumuPrivateClipboardFixture]::SetOversizedUnicode()
    Write-Output 'oversized-unicode-clipboard-set'
  }
  'Clear' {
    [FumuPrivateClipboardFixture]::Clear()
    Write-Output 'private-clipboard-cleared'
  }
}
