# work-fold 0.4.37

September 27, 2026

This update makes longer tasks and larger files easier for Workers to handle,
preserves more of their evidence, and makes their progress easier to follow.

- Follow thinking and tool activity in one chronological Worker steps strip.
  Choose every step or the current step in Appearance, inspect edit details,
  and recover earlier steps when reconnecting during a running turn.
- Keep accepted work running across Chat tab changes and closures. Interrupted
  turns retain their partial replies and tool evidence, and Stop follows owned
  work without cancelling independent Workers.
- Search large text files without the former 1 MiB exclusion. Workers can
  continue searches and inspect paginated History changes and verified ranges
  of older file versions without restoring them.
- Read beyond the former PDF page limit, continue dense-page extraction, and
  render selected pages or crops. Document jobs retain logs and generated
  files when a run fails or its response is too large to include at once.
  Installed LibreOffice can supply document conversion and spreadsheet
  recalculation when available.
- Attach more files within the selected model's context budget and preserve
  Word headers, footers, and footnotes. Chrome and Service Connections expose
  continuation information and retained results more consistently.
- Choose models from a searchable dropdown grouped by vendor, enjoy quieter
  focus styling, and keep the Latest control clear of Chat text.

Downloads: [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest).
