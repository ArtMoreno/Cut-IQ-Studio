import { execFile } from "node:child_process";
import { LOCAL_VIDEO_FILE_FILTER, canonicalLocalVideoPath, canonicalWindowsDirectory } from "./exportPaths";

function runPicker(script: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: false, timeout: 10 * 60_000, maxBuffer: 32_768 },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed) return resolve(null);
          reject(new Error(String(stderr).trim() || "The Windows file picker could not be opened."));
          return;
        }
        const selected = String(stdout).trim();
        resolve(selected || null);
      },
    );
  });
}

export async function pickLocalVideo(): Promise<string | null> {
  const filter = LOCAL_VIDEO_FILE_FILTER.replace(/'/g, "''");
  const selected = await runPicker(`Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Filter = '${filter}'; $dialog.Multiselect = $false; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }`);
  return selected ? canonicalLocalVideoPath(selected) : null;
}

export async function pickOutputDirectory(): Promise<string | null> {
  const selected = await runPicker("Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Choose where Cut IQ should save MP4 exports'; $dialog.ShowNewFolderButton = $true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }");
  return selected ? canonicalWindowsDirectory(selected, true) : null;
}
