Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
' 0 = hidden window. The bridge keeps running in the background; logs are in the logs folder.
sh.Run "cmd /c """ & dir & "\start.bat""", 0, False
