!include "LogicLib.nsh"
!include "WinMessages.nsh"

!macro WorkFoldCliBroadcastEnvironment
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro WorkFoldCliManageUserPath ACTION
  Push $0
  Push $1
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\bin\work-fold-cli.ps1" --work-fold-installer-manage-user-path ${ACTION} "$INSTDIR\bin"`
  Pop $0
  Pop $1
  ${If} $0 == 0
    !insertmacro WorkFoldCliBroadcastEnvironment
  ${Else}
    DetailPrint "work-fold CLI user PATH ${ACTION} failed: $1"
    SetErrors
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !insertmacro WorkFoldCliManageUserPath "install"
!macroend

!macro customUnInstall
  !insertmacro WorkFoldCliManageUserPath "uninstall"
!macroend
