' bgjobs hidden launcher: package asset, ASCII only, content is job-independent.
' argv[0] = error dir (jobDir); argv[1..] = target argv, forwarded verbatim.
' SW_HIDE (0) + wait (True) => no console window, and this process stays the task root
' until the target exits (taskkill/End on the tree still works).
Option Explicit
Dim sh, cmd, i, errDir
Set sh = CreateObject("WScript.Shell")
errDir = WScript.Arguments(0)
cmd = ""
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & QuoteArg(WScript.Arguments(i)) & " "
Next
On Error Resume Next
sh.Run cmd, 0, True
If Err.Number <> 0 Then
  Dim fso, f
  Set fso = CreateObject("Scripting.FileSystemObject")
  Set f = fso.CreateTextFile(errDir & "\launch-error.txt", True)
  f.WriteLine "launch failed: " & Err.Description
  f.Close
End If

' Quote one argv item for the target's CommandLineToArgvW / CRT parser (same rules as
' descriptor.mjs quoteArg). Wrap in one pair of quotes when the item is empty or holds
' a space, tab or quote; inside the wrapper every backslash run that precedes a quote
' (or the closing quote) is doubled, and a quote is escaped with a backslash.
Function QuoteArg(s)
  Dim k, ch, quoted, bs
  quoted = (Len(s) = 0)
  For k = 1 To Len(s)
    ch = Mid(s, k, 1)
    If ch = " " Or ch = Chr(9) Or ch = Chr(34) Then quoted = True
  Next
  If Not quoted Then
    QuoteArg = s
    Exit Function
  End If
  QuoteArg = ""
  bs = 0
  For k = 1 To Len(s)
    ch = Mid(s, k, 1)
    If ch = "\" Then
      bs = bs + 1
    Else
      If ch = Chr(34) Then
        QuoteArg = QuoteArg & String(bs * 2 + 1, "\") & Chr(34)
      Else
        QuoteArg = QuoteArg & String(bs, "\") & ch
      End If
      bs = 0
    End If
  Next
  QuoteArg = Chr(34) & QuoteArg & String(bs * 2, "\") & Chr(34)
End Function
