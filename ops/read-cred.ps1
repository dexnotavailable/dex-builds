<#
.SYNOPSIS
Writes one Windows Credential Manager secret (generic credential) to stdout, nothing else.
Used by supervisor.mjs so tokens never appear on a command line or in a log.
Exit 3 when the target does not exist. Windows PowerShell 5.1 compatible. ASCII only.
#>
param([Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Target)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DevbotCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public UInt32 Flags; public UInt32 Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob;
    public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName; }
  [DllImport("Advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr cred);
}
"@
$ptr = [IntPtr]::Zero
if (-not [DevbotCred]::CredRead($Target, 1, 0, [ref]$ptr)) { exit 3 }
try {
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][DevbotCred+CREDENTIAL])
  $value = [Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, [int]($c.CredentialBlobSize / 2))
  [Console]::Out.Write($value)
} finally { [DevbotCred]::CredFree($ptr) }
