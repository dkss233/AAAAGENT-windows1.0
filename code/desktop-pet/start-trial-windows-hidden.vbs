' AAAAGENT launcher without a console window.
' Output is captured to windows\.local\pet-launch.log so a failed hidden start stays diagnosable.
' Layout: code\desktop-pet\this.vbs -> code\desktop-pet -> code -> windows
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
windowsRoot = fso.GetParentFolderName(fso.GetParentFolderName(here))
logDir = windowsRoot & "\.local"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir) End If
logFile = logDir & "\pet-launch.log"
sh.CurrentDirectory = here
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\start-trial-windows.ps1"""
sh.Run "cmd.exe /c """ & cmd & " > """ & logFile & """ 2>&1""", 0, False