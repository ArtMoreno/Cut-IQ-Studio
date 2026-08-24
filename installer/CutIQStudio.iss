#define AppName "Cut IQ Studio"
#define AppVersion "1.0.0"
#define Publisher "Art Moreno"
#define AppURL "https://github.com/ArtMoreno/Cut-IQ-Studio"

[Setup]
AppId={{6E2AF716-6075-4B95-90D8-F0E4607068D7}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={localappdata}\Programs\Cut IQ Studio
DefaultGroupName=Cut IQ Studio
UninstallDisplayName=Cut IQ Studio
UninstallDisplayIcon={app}\Cut IQ Studio.ico
OutputDir=output
OutputBaseFilename=Cut-IQ-Studio-Setup
SetupIconFile=..\Cut IQ Studio.ico
LicenseFile=..\LICENSE
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern dynamic
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
DisableProgramGroupPage=yes
DisableWelcomePage=no
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#Publisher}
VersionInfoDescription=Cut IQ Studio Windows Installer
VersionInfoProductName={#AppName}
VersionInfoCopyright=Copyright (c) 2026 Art Moreno

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\dist\*"; DestDir: "{app}\app\dist"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "schema.sql"; DestDir: "{app}\resources"; Flags: ignoreversion
Source: "Start-CutIQStudio.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "Stop-CutIQStudio.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\Cut IQ Studio.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
Source: "..\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: checkedonce

[Icons]
Name: "{autodesktop}\Cut IQ Studio"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\Start-CutIQStudio.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\Cut IQ Studio.ico"; Comment: "Find, cut, and export video clips"; Tasks: desktopicon
Name: "{group}\Cut IQ Studio"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\Start-CutIQStudio.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\Cut IQ Studio.ico"; Comment: "Find, cut, and export video clips"
Name: "{group}\Uninstall Cut IQ Studio"; Filename: "{uninstallexe}"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\Start-CutIQStudio.ps1"""; Description: "Launch Cut IQ Studio"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\Stop-CutIQStudio.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "StopCutIQStudio"
