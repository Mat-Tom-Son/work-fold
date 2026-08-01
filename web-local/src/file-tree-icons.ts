import archiveIconUrl from "material-icon-theme/icons/zip.svg?url";
import architectureIconUrl from "material-icon-theme/icons/architecture.svg?url";
import certificateIconUrl from "material-icon-theme/icons/certificate.svg?url";
import changelogIconUrl from "material-icon-theme/icons/changelog.svg?url";
import codeIconUrl from "material-icon-theme/icons/typescript.svg?url";
import consoleIconUrl from "material-icon-theme/icons/console.svg?url";
import cssIconUrl from "material-icon-theme/icons/css.svg?url";
import databaseIconUrl from "material-icon-theme/icons/database.svg?url";
import dockerIconUrl from "material-icon-theme/icons/docker.svg?url";
import documentIconUrl from "material-icon-theme/icons/document.svg?url";
import folderApiIconUrl from "material-icon-theme/icons/folder-api.svg?url";
import folderApiOpenIconUrl from "material-icon-theme/icons/folder-api-open.svg?url";
import folderAppIconUrl from "material-icon-theme/icons/folder-app.svg?url";
import folderAppOpenIconUrl from "material-icon-theme/icons/folder-app-open.svg?url";
import folderConfigIconUrl from "material-icon-theme/icons/folder-config.svg?url";
import folderConfigOpenIconUrl from "material-icon-theme/icons/folder-config-open.svg?url";
import folderDesktopIconUrl from "material-icon-theme/icons/folder-desktop.svg?url";
import folderDesktopOpenIconUrl from "material-icon-theme/icons/folder-desktop-open.svg?url";
import folderDocsIconUrl from "material-icon-theme/icons/folder-docs.svg?url";
import folderDocsOpenIconUrl from "material-icon-theme/icons/folder-docs-open.svg?url";
import folderExamplesIconUrl from "material-icon-theme/icons/folder-examples.svg?url";
import folderExamplesOpenIconUrl from "material-icon-theme/icons/folder-examples-open.svg?url";
import folderGithubIconUrl from "material-icon-theme/icons/folder-github.svg?url";
import folderGithubOpenIconUrl from "material-icon-theme/icons/folder-github-open.svg?url";
import folderIconUrl from "material-icon-theme/icons/folder.svg?url";
import folderLibIconUrl from "material-icon-theme/icons/folder-lib.svg?url";
import folderLibOpenIconUrl from "material-icon-theme/icons/folder-lib-open.svg?url";
import folderOpenIconUrl from "material-icon-theme/icons/folder-open.svg?url";
import folderResourceIconUrl from "material-icon-theme/icons/folder-resource.svg?url";
import folderResourceOpenIconUrl from "material-icon-theme/icons/folder-resource-open.svg?url";
import folderScriptsIconUrl from "material-icon-theme/icons/folder-scripts.svg?url";
import folderScriptsOpenIconUrl from "material-icon-theme/icons/folder-scripts-open.svg?url";
import folderSkillsIconUrl from "material-icon-theme/icons/folder-skills.svg?url";
import folderSkillsOpenIconUrl from "material-icon-theme/icons/folder-skills-open.svg?url";
import folderSrcIconUrl from "material-icon-theme/icons/folder-src.svg?url";
import folderSrcOpenIconUrl from "material-icon-theme/icons/folder-src-open.svg?url";
import folderTempIconUrl from "material-icon-theme/icons/folder-temp.svg?url";
import folderTempOpenIconUrl from "material-icon-theme/icons/folder-temp-open.svg?url";
import folderTestIconUrl from "material-icon-theme/icons/folder-test.svg?url";
import folderTestOpenIconUrl from "material-icon-theme/icons/folder-test-open.svg?url";
import folderToolsIconUrl from "material-icon-theme/icons/folder-tools.svg?url";
import folderToolsOpenIconUrl from "material-icon-theme/icons/folder-tools-open.svg?url";
import folderUiIconUrl from "material-icon-theme/icons/folder-ui.svg?url";
import folderUiOpenIconUrl from "material-icon-theme/icons/folder-ui-open.svg?url";
import gitIconUrl from "material-icon-theme/icons/git.svg?url";
import githubWorkflowIconUrl from "material-icon-theme/icons/github-actions-workflow.svg?url";
import htmlIconUrl from "material-icon-theme/icons/html.svg?url";
import imageIconUrl from "material-icon-theme/icons/image.svg?url";
import instructionsIconUrl from "material-icon-theme/icons/instructions.clone.svg?url";
import javascriptIconUrl from "material-icon-theme/icons/javascript.svg?url";
import jsonIconUrl from "material-icon-theme/icons/json.svg?url";
import keyIconUrl from "material-icon-theme/icons/key.svg?url";
import licenseIconUrl from "material-icon-theme/icons/license.svg?url";
import lockIconUrl from "material-icon-theme/icons/lock.svg?url";
import markdownIconUrl from "material-icon-theme/icons/markdown.svg?url";
import npmIconUrl from "material-icon-theme/icons/npm.svg?url";
import pdfIconUrl from "material-icon-theme/icons/pdf.svg?url";
import powerpointIconUrl from "material-icon-theme/icons/powerpoint.svg?url";
import powershellIconUrl from "material-icon-theme/icons/powershell.svg?url";
import promptIconUrl from "material-icon-theme/icons/prompt.svg?url";
import readmeIconUrl from "material-icon-theme/icons/readme.svg?url";
import reactIconUrl from "material-icon-theme/icons/react.svg?url";
import reactTsIconUrl from "material-icon-theme/icons/react_ts.svg?url";
import settingsIconUrl from "material-icon-theme/icons/settings.svg?url";
import skillIconUrl from "material-icon-theme/icons/skill.svg?url";
import spreadsheetIconUrl from "material-icon-theme/icons/table.svg?url";
import svgIconUrl from "material-icon-theme/icons/svg.svg?url";
import tsConfigIconUrl from "material-icon-theme/icons/tsconfig.svg?url";
import wordIconUrl from "material-icon-theme/icons/word.svg?url";
import xmlIconUrl from "material-icon-theme/icons/xml.svg?url";
import yamlIconUrl from "material-icon-theme/icons/yaml.svg?url";

export type FileTreeIconTone =
  | "archive"
  | "code"
  | "folder"
  | "image"
  | "pdf"
  | "sheet"
  | "slide"
  | "text"
  | "unknown"
  | "word";

export interface FileTreeIconSpec {
  src: string;
  label: string;
  tone: FileTreeIconTone;
}

interface FolderIconPair {
  closed: FileTreeIconSpec;
  open: FileTreeIconSpec;
}

function icon(src: string, label: string, tone: FileTreeIconTone): FileTreeIconSpec {
  return { src, label, tone };
}

function folderPair(closedSrc: string, openSrc: string, label: string): FolderIconPair {
  return {
    closed: icon(closedSrc, label, "folder"),
    open: icon(openSrc, `${label} open`, "folder"),
  };
}

const fallbackFileIcon = icon(documentIconUrl, "File", "unknown");
const fallbackFolderIcon = folderPair(folderIconUrl, folderOpenIconUrl, "Folder");

const fileNameIconMap = new Map<string, FileTreeIconSpec>([
  ["agents.md", icon(instructionsIconUrl, "Agent instructions", "text")],
  ["architecture.md", icon(architectureIconUrl, "Architecture document", "text")],
  ["changelog.md", icon(changelogIconUrl, "Changelog", "text")],
  ["dockerfile", icon(dockerIconUrl, "Dockerfile", "code")],
  [".env", icon(settingsIconUrl, "Environment settings", "code")],
  [".env.local", icon(settingsIconUrl, "Local environment settings", "code")],
  [".gitignore", icon(gitIconUrl, "Git ignore file", "code")],
  [".work-foldignore", icon(settingsIconUrl, "Space ignore file", "code")],
  ["license", icon(licenseIconUrl, "License", "text")],
  ["license.md", icon(licenseIconUrl, "License", "text")],
  ["package-lock.json", icon(npmIconUrl, "npm lockfile", "code")],
  ["package.json", icon(npmIconUrl, "Package file", "code")],
  ["readme.md", icon(readmeIconUrl, "Readme", "text")],
  ["skill.md", icon(skillIconUrl, "Skill instructions", "text")],
  ["tsconfig.json", icon(tsConfigIconUrl, "TypeScript config", "code")],
  ["vite.config.ts", icon(settingsIconUrl, "Vite config", "code")],
  ["vite.local.config.ts", icon(settingsIconUrl, "Vite config", "code")],
]);

const extensionIconMap = new Map<string, FileTreeIconSpec>([
  ["7z", icon(archiveIconUrl, "Archive file", "archive")],
  ["bat", icon(consoleIconUrl, "Batch script", "code")],
  ["bmp", icon(imageIconUrl, "Image file", "image")],
  ["cjs", icon(javascriptIconUrl, "JavaScript file", "code")],
  ["cmd", icon(consoleIconUrl, "Command script", "code")],
  ["csv", icon(spreadsheetIconUrl, "Spreadsheet file", "sheet")],
  ["css", icon(cssIconUrl, "CSS file", "code")],
  ["cts", icon(codeIconUrl, "TypeScript file", "code")],
  ["db", icon(databaseIconUrl, "Database file", "code")],
  ["doc", icon(wordIconUrl, "Word document", "word")],
  ["docm", icon(wordIconUrl, "Word document", "word")],
  ["docx", icon(wordIconUrl, "Word document", "word")],
  ["dot", icon(wordIconUrl, "Word template", "word")],
  ["dotx", icon(wordIconUrl, "Word template", "word")],
  ["gif", icon(imageIconUrl, "Image file", "image")],
  ["gz", icon(archiveIconUrl, "Archive file", "archive")],
  ["htm", icon(htmlIconUrl, "HTML file", "code")],
  ["html", icon(htmlIconUrl, "HTML file", "code")],
  ["ico", icon(imageIconUrl, "Icon image", "image")],
  ["jpeg", icon(imageIconUrl, "Image file", "image")],
  ["jpg", icon(imageIconUrl, "Image file", "image")],
  ["js", icon(javascriptIconUrl, "JavaScript file", "code")],
  ["json", icon(jsonIconUrl, "JSON file", "code")],
  ["json5", icon(jsonIconUrl, "JSON file", "code")],
  ["jsonc", icon(jsonIconUrl, "JSON file", "code")],
  ["jsx", icon(reactIconUrl, "React file", "code")],
  ["key", icon(keyIconUrl, "Key file", "code")],
  ["log", icon(documentIconUrl, "Log file", "text")],
  ["markdown", icon(markdownIconUrl, "Markdown file", "text")],
  ["md", icon(markdownIconUrl, "Markdown file", "text")],
  ["mjs", icon(javascriptIconUrl, "JavaScript file", "code")],
  ["mts", icon(codeIconUrl, "TypeScript file", "code")],
  ["pdf", icon(pdfIconUrl, "PDF file", "pdf")],
  ["pem", icon(certificateIconUrl, "Certificate file", "code")],
  ["png", icon(imageIconUrl, "Image file", "image")],
  ["potx", icon(powerpointIconUrl, "PowerPoint template", "slide")],
  ["ppt", icon(powerpointIconUrl, "PowerPoint presentation", "slide")],
  ["pptm", icon(powerpointIconUrl, "PowerPoint presentation", "slide")],
  ["pptx", icon(powerpointIconUrl, "PowerPoint presentation", "slide")],
  ["ps1", icon(powershellIconUrl, "PowerShell script", "code")],
  ["rar", icon(archiveIconUrl, "Archive file", "archive")],
  ["rtf", icon(documentIconUrl, "Rich text file", "text")],
  ["sql", icon(databaseIconUrl, "SQL file", "code")],
  ["sqlite", icon(databaseIconUrl, "Database file", "code")],
  ["svg", icon(svgIconUrl, "SVG image", "image")],
  ["tar", icon(archiveIconUrl, "Archive file", "archive")],
  ["tgz", icon(archiveIconUrl, "Archive file", "archive")],
  ["tif", icon(imageIconUrl, "Image file", "image")],
  ["tiff", icon(imageIconUrl, "Image file", "image")],
  ["ts", icon(codeIconUrl, "TypeScript file", "code")],
  ["tsx", icon(reactTsIconUrl, "React TypeScript file", "code")],
  ["tsv", icon(spreadsheetIconUrl, "Spreadsheet file", "sheet")],
  ["txt", icon(documentIconUrl, "Text file", "text")],
  ["webp", icon(imageIconUrl, "Image file", "image")],
  ["xls", icon(spreadsheetIconUrl, "Spreadsheet file", "sheet")],
  ["xlsb", icon(spreadsheetIconUrl, "Spreadsheet file", "sheet")],
  ["xlsm", icon(spreadsheetIconUrl, "Spreadsheet file", "sheet")],
  ["xlsx", icon(spreadsheetIconUrl, "Spreadsheet file", "sheet")],
  ["xml", icon(xmlIconUrl, "XML file", "code")],
  ["yaml", icon(yamlIconUrl, "YAML file", "code")],
  ["yml", icon(yamlIconUrl, "YAML file", "code")],
  ["zip", icon(archiveIconUrl, "Archive file", "archive")],
]);

const suffixIconMap: Array<[string, FileTreeIconSpec]> = [
  [".config.js", icon(settingsIconUrl, "JavaScript config", "code")],
  [".config.mjs", icon(settingsIconUrl, "JavaScript config", "code")],
  [".config.cjs", icon(settingsIconUrl, "JavaScript config", "code")],
  [".config.ts", icon(settingsIconUrl, "TypeScript config", "code")],
  [".lock", icon(lockIconUrl, "Lock file", "code")],
  [".prompt.md", icon(promptIconUrl, "Prompt file", "text")],
  [".test.ts", icon(codeIconUrl, "TypeScript test", "code")],
  [".test.tsx", icon(reactTsIconUrl, "React TypeScript test", "code")],
  [".spec.ts", icon(codeIconUrl, "TypeScript spec", "code")],
  [".spec.tsx", icon(reactTsIconUrl, "React TypeScript spec", "code")],
  [".workflow.yml", icon(githubWorkflowIconUrl, "Workflow file", "code")],
  [".workflow.yaml", icon(githubWorkflowIconUrl, "Workflow file", "code")],
];

const folderNameIconMap = new Map<string, FolderIconPair>([
  [".github", folderPair(folderGithubIconUrl, folderGithubOpenIconUrl, "GitHub folder")],
  [".pi", folderPair(folderSkillsIconUrl, folderSkillsOpenIconUrl, "Pi configuration folder")],
  ["api", folderPair(folderApiIconUrl, folderApiOpenIconUrl, "API folder")],
  ["app", folderPair(folderAppIconUrl, folderAppOpenIconUrl, "App folder")],
  ["assets", folderPair(folderResourceIconUrl, folderResourceOpenIconUrl, "Assets folder")],
  ["cases", folderPair(folderTestIconUrl, folderTestOpenIconUrl, "Cases folder")],
  ["components", folderPair(folderUiIconUrl, folderUiOpenIconUrl, "Components folder")],
  ["config", folderPair(folderConfigIconUrl, folderConfigOpenIconUrl, "Config folder")],
  ["desktop", folderPair(folderDesktopIconUrl, folderDesktopOpenIconUrl, "Desktop folder")],
  ["dist", folderPair(folderTempIconUrl, folderTempOpenIconUrl, "Build output folder")],
  ["docs", folderPair(folderDocsIconUrl, folderDocsOpenIconUrl, "Docs folder")],
  ["examples", folderPair(folderExamplesIconUrl, folderExamplesOpenIconUrl, "Examples folder")],
  ["lib", folderPair(folderLibIconUrl, folderLibOpenIconUrl, "Library folder")],
  ["local", folderPair(folderApiIconUrl, folderApiOpenIconUrl, "Local API folder")],
  ["node_modules", folderPair(folderTempIconUrl, folderTempOpenIconUrl, "Dependencies folder")],
  ["out", folderPair(folderTempIconUrl, folderTempOpenIconUrl, "Build output folder")],
  ["profiles", folderPair(folderConfigIconUrl, folderConfigOpenIconUrl, "Profiles folder")],
  ["runs", folderPair(folderResourceIconUrl, folderResourceOpenIconUrl, "Runs folder")],
  ["schemas", folderPair(folderConfigIconUrl, folderConfigOpenIconUrl, "Schemas folder")],
  ["scripts", folderPair(folderScriptsIconUrl, folderScriptsOpenIconUrl, "Scripts folder")],
  ["skills", folderPair(folderSkillsIconUrl, folderSkillsOpenIconUrl, "Skills folder")],
  ["src", folderPair(folderSrcIconUrl, folderSrcOpenIconUrl, "Source folder")],
  ["test", folderPair(folderTestIconUrl, folderTestOpenIconUrl, "Test folder")],
  ["tests", folderPair(folderTestIconUrl, folderTestOpenIconUrl, "Tests folder")],
  ["tools", folderPair(folderToolsIconUrl, folderToolsOpenIconUrl, "Tools folder")],
  ["ui", folderPair(folderUiIconUrl, folderUiOpenIconUrl, "UI folder")],
  ["web-local", folderPair(folderAppIconUrl, folderAppOpenIconUrl, "Renderer app folder")],
  ["work", folderPair(folderResourceIconUrl, folderResourceOpenIconUrl, "Work folder")],
  ["workflows", folderPair(folderGithubIconUrl, folderGithubOpenIconUrl, "Workflows folder")],
]);

export function fileTreeFileIcon(path: string): FileTreeIconSpec {
  const name = baseName(path).toLowerCase();
  const fileNameIcon = fileNameIconMap.get(name);
  if (fileNameIcon) return fileNameIcon;
  for (const [suffix, suffixIcon] of suffixIconMap) {
    if (name.endsWith(suffix)) return suffixIcon;
  }
  return extensionIconMap.get(extensionWithoutDot(name)) ?? fallbackFileIcon;
}

export function fileTreeFolderIcon(pathOrName: string, expanded: boolean): FileTreeIconSpec {
  const folderName = baseName(pathOrName).toLowerCase();
  const pair = folderNameIconMap.get(folderName) ?? fallbackFolderIcon;
  return expanded ? pair.open : pair.closed;
}

export function fileTreeIconClassName(iconSpec: FileTreeIconSpec): string {
  if (iconSpec.tone === "folder") return "material-file-icon folder-icon";
  return `material-file-icon file-icon-${iconSpec.tone}`;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function extensionWithoutDot(fileName: string): string {
  const match = /\.([^.\\/]+)$/.exec(fileName);
  return match?.[1] ?? "";
}
