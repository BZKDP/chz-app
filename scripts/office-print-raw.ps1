param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string]$PrinterName,

    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 120)]
    [string]$DocumentName
)

$ErrorActionPreference = 'Stop'
$inboxRoot = [IO.Path]::GetFullPath('C:\ProgramData\CHZRemotePrint\inbox')
$fullPath = [IO.Path]::GetFullPath($FilePath)
$rootPrefix = $inboxRoot.TrimEnd('\') + '\'

if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Print input is outside the CHZ remote print inbox.'
}
if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw 'Print input file does not exist.'
}

$printer = Get-Printer -Name $PrinterName -ErrorAction Stop
$payload = [IO.File]::ReadAllBytes($fullPath)
if ($payload.Length -lt 1 -or $payload.Length -gt 100MB) {
    throw "Unexpected RAW print payload size: $($payload.Length) bytes."
}

if (-not ('CHZ.RawPrinter' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace CHZ {
    public static class RawPrinter {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private class DOC_INFO_1 {
            [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
            [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
            [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
        }

        [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);
        [DllImport("winspool.drv", SetLastError = true)]
        private static extern bool ClosePrinter(IntPtr printer);
        [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern int StartDocPrinter(IntPtr printer, int level, [In] DOC_INFO_1 docInfo);
        [DllImport("winspool.drv", SetLastError = true)]
        private static extern bool EndDocPrinter(IntPtr printer);
        [DllImport("winspool.drv", SetLastError = true)]
        private static extern bool StartPagePrinter(IntPtr printer);
        [DllImport("winspool.drv", SetLastError = true)]
        private static extern bool EndPagePrinter(IntPtr printer);
        [DllImport("winspool.drv", SetLastError = true)]
        private static extern bool WritePrinter(IntPtr printer, byte[] bytes, int count, out int written);

        public static int Send(string printerName, string documentName, byte[] bytes) {
            IntPtr printer;
            if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed");
            }
            try {
                var info = new DOC_INFO_1 {
                    pDocName = documentName,
                    pOutputFile = null,
                    pDataType = "RAW"
                };
                int jobId = StartDocPrinter(printer, 1, info);
                if (jobId == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed");
                try {
                    if (!StartPagePrinter(printer)) throw new Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter failed");
                    try {
                        int written;
                        if (!WritePrinter(printer, bytes, bytes.Length, out written)) {
                            throw new Win32Exception(Marshal.GetLastWin32Error(), "WritePrinter failed");
                        }
                        if (written != bytes.Length) throw new InvalidOperationException("Not all RAW bytes were written.");
                    } finally {
                        EndPagePrinter(printer);
                    }
                } finally {
                    EndDocPrinter(printer);
                }
                return jobId;
            } finally {
                ClosePrinter(printer);
            }
        }
    }
}
'@
}

try {
    $jobId = [CHZ.RawPrinter]::Send($printer.Name, $DocumentName, $payload)
    [pscustomobject]@{
        ok = $true
        printer = $printer.Name
        documentName = $DocumentName
        bytes = $payload.Length
        jobId = $jobId
    } | ConvertTo-Json -Compress
}
finally {
    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
        Remove-Item -LiteralPath $fullPath -Force
    }
}
